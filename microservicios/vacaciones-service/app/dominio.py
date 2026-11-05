"""Reglas de dominio puras (sin I/O): fechas y formato de salida."""
from datetime import date, datetime, timedelta, timezone
from typing import Any


def dias_habiles(inicio: date, fin: date) -> int:
    """Días de lunes a viernes entre inicio y fin, ambos inclusive.

    No descuenta festivos: el calendario laboral no es parte del alcance del reto.
    """
    total = 0
    dia = inicio
    while dia <= fin:
        if dia.weekday() < 5:
            total += 1
        dia += timedelta(days=1)
    return total


def iso_utc(valor: datetime) -> str:
    """ISO-8601 en UTC con sufijo Z y sin fracciones, como en el catálogo de eventos."""
    return valor.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def periodo_a_dto(fila: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": fila["id"],
        "empleadoId": fila["empleado_id"],
        "fechaInicio": fila["fecha_inicio"].isoformat(),
        "fechaFin": fila["fecha_fin"].isoformat(),
        "estado": fila["estado"],
        "fechaCreacion": iso_utc(fila["fecha_creacion"]),
    }


# RF-27 / RF-28: transiciones de estado por fecha. Las usan el scheduler y los endpoints de desarrollo.
INICIAR = "iniciar"
FINALIZAR = "finalizar"

TRANSICIONES: dict[str, dict[str, str]] = {
    INICIAR: {"desde": "PROGRAMADA", "hacia": "EN_CURSO", "evento": "vacaciones.iniciadas"},
    FINALIZAR: {"desde": "EN_CURSO", "hacia": "FINALIZADA", "evento": "vacaciones.finalizadas"},
}


def corresponde_por_fecha(accion: str, fila: dict[str, Any], hoy: date) -> bool:
    """¿La fecha ya habilita la transición?

    - iniciar:   fechaInicio <= hoy (el primer día de vacaciones ya cuenta).
    - finalizar: fechaFin < hoy (las vacaciones INCLUYEN el día fechaFin: se cierran al día siguiente).
    """
    if accion == INICIAR:
        return fila["fecha_inicio"] <= hoy
    if accion == FINALIZAR:
        return fila["fecha_fin"] < hoy
    raise ValueError(f"acción desconocida: {accion}")


def data_evento_transicion(accion: str, fila: dict[str, Any], email: str) -> dict[str, Any]:
    """Cuerpo (`data`) de vacaciones.iniciadas / vacaciones.finalizadas según el Catálogo de Eventos."""
    base = {"vacacionesId": fila["id"], "empleadoId": fila["empleado_id"], "email": email}
    if accion == INICIAR:
        return {**base, "fechaInicio": fila["fecha_inicio"].isoformat(), "fechaFin": fila["fecha_fin"].isoformat()}
    return {**base, "fechaFin": fila["fecha_fin"].isoformat()}
