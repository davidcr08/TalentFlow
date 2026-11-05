"""Lógica de negocio de vacaciones: validaciones, persistencia y publicación del evento."""
import logging
from datetime import date, datetime
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

from .broker import Broker
from .dominio import (
    FINALIZAR,
    INICIAR,
    TRANSICIONES,
    corresponde_por_fecha,
    data_evento_transicion,
    dias_habiles,
    periodo_a_dto,
)
from .errores import AppError
from .repository import VacacionesRepository

log = logging.getLogger("vacaciones.servicio")


class VacacionesService:
    def __init__(
        self,
        repo: VacacionesRepository,
        broker: Broker,
        zona_horaria: str = "America/Bogota",
        reloj: Optional[Callable[[], datetime]] = None,
    ):
        self.repo = repo
        self.broker = broker
        self.zona = ZoneInfo(zona_horaria)
        self._reloj = reloj

    def hoy(self) -> date:
        ahora = self._reloj() if self._reloj else datetime.now(self.zona)
        return ahora.date()

    async def programar(self, empleado_id: str, inicio: date, fin: date) -> dict[str, Any]:
        hoy = self.hoy()

        # 1. Fechas incoherentes
        if fin <= inicio:
            raise AppError(
                f"fechaFin ({fin}) debe ser posterior a fechaInicio ({inicio})",
                400,
                [{"campo": "fechaFin", "mensaje": "debe ser posterior a fechaInicio"}],
            )
        # 2. Fechas en el pasado
        if inicio < hoy:
            raise AppError(
                f"fechaInicio ({inicio}) no puede ser anterior a la fecha actual ({hoy})",
                400,
                [{"campo": "fechaInicio", "mensaje": "no puede estar en el pasado"}],
            )

        async with self.repo.transaccion() as conn:
            # Serializa programaciones concurrentes del mismo empleado hasta el commit.
            await self.repo.bloquear_empleado(conn, empleado_id)

            # 4. Empleado inexistente (según la réplica local alimentada por eventos)
            empleado = await self.repo.obtener_empleado(conn, empleado_id)
            if empleado is None:
                raise AppError(
                    f"El empleado {empleado_id} no existe",
                    400,
                    [{"campo": "empleadoId", "mensaje": "no corresponde a un empleado registrado"}],
                )
            if empleado["estado"] == "RETIRADO":
                raise AppError(
                    f"El empleado {empleado_id} está RETIRADO y no puede programar vacaciones",
                    400,
                    [{"campo": "empleadoId", "mensaje": "el empleado está retirado"}],
                )

            # 3. Solapamiento con un período PROGRAMADA o EN_CURSO
            conflicto = await self.repo.buscar_solapado(conn, empleado_id, inicio, fin)
            if conflicto is not None:
                raise AppError(
                    f"El rango {inicio} a {fin} se cruza con el período {conflicto['id']} "
                    f"({conflicto['fecha_inicio']} a {conflicto['fecha_fin']}, {conflicto['estado']})",
                    400,
                    [{"campo": "fechaInicio", "mensaje": "se cruza con otro período del empleado"}],
                    extra={"periodoEnConflicto": periodo_a_dto(conflicto)},
                )

            nuevo_id = await self.repo.siguiente_id(conn, hoy.year)
            fila = await self.repo.insertar(conn, nuevo_id, empleado_id, inicio, fin)
            email = empleado["email"]

        # La transacción ya confirmó. Publicar DESPUÉS: si falla, se registra el error
        # pero NO se revierte el período (misma regla que el servicio de empleados).
        await self._publicar_programadas(fila, email)
        return periodo_a_dto(fila)

    async def _publicar_programadas(self, fila: dict[str, Any], email: str) -> None:
        data = {
            "vacacionesId": fila["id"],
            "empleadoId": fila["empleado_id"],
            "email": email,
            "fechaInicio": fila["fecha_inicio"].isoformat(),
            "fechaFin": fila["fecha_fin"].isoformat(),
            "diasHabiles": dias_habiles(fila["fecha_inicio"], fila["fecha_fin"]),
        }
        try:
            await self.broker.publicar("vacaciones.programadas", data)
        except Exception:  # noqa: BLE001
            log.exception(
                "No se pudo publicar vacaciones.programadas del período %s; "
                "el período quedó registrado (no se revierte)",
                fila["id"],
            )

    async def obtener(self, id_: str) -> dict[str, Any]:
        async with self.repo.transaccion() as conn:
            fila = await self.repo.obtener(conn, id_)
        if fila is None:
            raise AppError(f"No existe el período de vacaciones {id_}", 404)
        return periodo_a_dto(fila)

    async def listar(self, empleado_id: Optional[str] = None) -> list[dict[str, Any]]:
        async with self.repo.transaccion() as conn:
            filas = await self.repo.listar(conn, empleado_id)
        return [periodo_a_dto(f) for f in filas]

    async def cancelar(self, id_: str) -> dict[str, Any]:
        hoy = self.hoy()
        async with self.repo.transaccion() as conn:
            fila = await self.repo.obtener(conn, id_, para_actualizar=True)
            if fila is None:
                raise AppError(f"No existe el período de vacaciones {id_}", 404)
            if fila["estado"] == "CANCELADA":
                raise AppError(f"El período {id_} ya está CANCELADA", 409)
            # RF-26: un período que ya inició (en curso, finalizado o con fechaInicio ya
            # llegada) no se cancela -> 400.
            if fila["estado"] != "PROGRAMADA" or fila["fecha_inicio"] <= hoy:
                raise AppError(
                    f"El período {id_} ya inició (estado {fila['estado']}, fechaInicio "
                    f"{fila['fecha_inicio']}): solo se cancelan períodos que no han iniciado",
                    400,
                    [{"campo": "id", "mensaje": "el período ya inició"}],
                )
            fila = await self.repo.marcar_cancelada(conn, id_)
        return periodo_a_dto(fila)

    # ------------------------------------------------------------------ RF-27 / RF-28 / RF-30

    async def transicionar(self, id_: str, accion: str, *, forzar: bool = False) -> Optional[dict[str, Any]]:
        """ÚNICA función de transición de estado por fecha. La usan:
          - el scheduler (forzar=False): solo transiciona si la fecha ya lo habilita;
          - los endpoints de desarrollo (forzar=True): ignora las fechas (RF-30).

        PROGRAMADA -> EN_CURSO + vacaciones.iniciadas   (accion = "iniciar")
        EN_CURSO  -> FINALIZADA + vacaciones.finalizadas (accion = "finalizar")

        Sin forzar devuelve None si no hay nada que hacer (otro ciclo o instancia ya lo movió, o la
        fecha aún no corresponde). Con forzar lanza 404 si no existe y 409 si el estado no es el esperado.

        La publicación ocurre DENTRO de la transacción, con la fila bloqueada, y ANTES del commit: si
        el broker falla se revierte y el período conserva su estado, así que el siguiente ciclo
        reintenta (no se pierde el evento y el estado no queda sin publicar). Si es el commit el que
        falla tras publicar, el siguiente ciclo republica con otro id; los consumidores lo toleran
        porque deciden por el estado de la cuenta (RF-10/RF-11), no por el id del evento.
        """
        regla = TRANSICIONES[accion]
        hoy = self.hoy()
        async with self.repo.transaccion() as conn:
            fila = await self.repo.obtener(conn, id_, para_actualizar=True)
            if fila is None:
                if forzar:
                    raise AppError(f"No existe el período de vacaciones {id_}", 404)
                return None
            if fila["estado"] != regla["desde"]:
                if forzar:
                    raise AppError(
                        f"El período {id_} está {fila['estado']}: solo se puede {accion} un período {regla['desde']}",
                        409,
                    )
                return None
            if not forzar and not corresponde_por_fecha(accion, fila, hoy):
                return None

            empleado = await self.repo.obtener_empleado(conn, fila["empleado_id"])
            if empleado is None:
                raise AppError(
                    f"No hay réplica del empleado {fila['empleado_id']}: no se puede publicar {regla['evento']}",
                    409,
                )

            try:
                await self.broker.publicar(regla["evento"], data_evento_transicion(accion, fila, empleado["email"]))
            except Exception as exc:  # noqa: BLE001
                log.exception("No se pudo publicar %s del período %s; el período conserva su estado", regla["evento"], id_)
                raise AppError(
                    f"No se pudo publicar {regla['evento']}: el período {id_} no cambió de estado", 503
                ) from exc

            fila = await self.repo.marcar_estado(conn, id_, regla["hacia"])
        log.info(
            "Período %s: %s -> %s (%s)%s",
            id_, regla["desde"], regla["hacia"], regla["evento"], " [forzado]" if forzar else "",
        )
        return periodo_a_dto(fila)

    async def ejecutar_transiciones(self) -> dict[str, list[str]]:
        """Una pasada de la tarea periódica (RF-27 y RF-28).

        Primero inicia y después finaliza: un período cuyas fechas ya pasaron por completo (p. ej.
        porque el servicio estuvo caído) sale en la misma pasada con vacaciones.iniciadas y luego
        vacaciones.finalizadas, en ese orden. Un fallo en un período no impide procesar los demás.
        """
        resultado: dict[str, list[str]] = {"iniciados": [], "finalizados": []}
        for accion, clave in ((INICIAR, "iniciados"), (FINALIZAR, "finalizados")):
            hoy = self.hoy()
            async with self.repo.transaccion() as conn:
                ids = (
                    await self.repo.ids_a_iniciar(conn, hoy)
                    if accion == INICIAR
                    else await self.repo.ids_a_finalizar(conn, hoy)
                )
            for id_ in ids:
                try:
                    if await self.transicionar(id_, accion):
                        resultado[clave].append(id_)
                except Exception:  # noqa: BLE001
                    log.exception("Fallo al %s el período %s; se reintenta en la próxima pasada", accion, id_)
        return resultado
