"""Tarea periódica (RF-27 / RF-28 / RF-29): mueve los períodos por fecha y publica los eventos."""
import asyncio
import logging
from typing import Optional

from .servicio import VacacionesService

log = logging.getLogger("vacaciones.scheduler")


class PlanificadorVacaciones:
    def __init__(self, servicio: VacacionesService, intervalo_s: float):
        self.servicio = servicio
        self.intervalo_s = intervalo_s
        self._tarea: Optional[asyncio.Task] = None

    @property
    def habilitado(self) -> bool:
        return self.intervalo_s > 0

    async def ejecutar_una_vez(self) -> dict[str, list[str]]:
        resultado = await self.servicio.ejecutar_transiciones()
        if resultado["iniciados"] or resultado["finalizados"]:
            log.info("Scheduler: iniciados=%s finalizados=%s", resultado["iniciados"], resultado["finalizados"])
        return resultado

    async def _bucle(self) -> None:
        log.info("Scheduler de vacaciones activo: cada %s s", self.intervalo_s)
        while True:
            try:
                await self.ejecutar_una_vez()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - un ciclo fallido (p. ej. BD caída) no mata la tarea
                log.exception("Scheduler: falló la pasada; se reintenta en %s s", self.intervalo_s)
            await asyncio.sleep(self.intervalo_s)

    def iniciar(self) -> None:
        if not self.habilitado:
            log.info("Scheduler de vacaciones desactivado (SCHEDULER_INTERVALO_SEGUNDOS <= 0)")
            return
        if self._tarea is None:
            self._tarea = asyncio.create_task(self._bucle())

    async def detener(self) -> None:
        if self._tarea is not None:
            self._tarea.cancel()
            try:
                await self._tarea
            except asyncio.CancelledError:
                pass
            self._tarea = None
