"""RF-27 a RF-30: transiciones por fecha (scheduler) y endpoints de desarrollo."""
import asyncio
from datetime import date, datetime

import pytest

from app.config import Settings
from app.scheduler import PlanificadorVacaciones
from tests.conftest import ZONA
from tests.test_vacaciones import alta_empleado


def insertar(client, app, id_, empleado, inicio, fin, estado="PROGRAMADA"):
    async def _insertar():
        async with app.state.repo.transaccion() as conn:
            await conn.execute(
                "INSERT INTO vacaciones (id, empleado_id, fecha_inicio, fecha_fin, estado) "
                "VALUES (%s, %s, %s, %s, %s)",
                (id_, empleado, inicio, fin, estado),
            )

    client.portal.call(_insertar)


def estado_de(client, id_):
    return client.get(f"/vacaciones/{id_}").json()["estado"]


def pasada(client, app):
    return client.portal.call(app.state.planificador.ejecutar_una_vez)


def eventos(broker, tipo):
    return [d for t, d in broker.publicados if t == tipo]


def poner_fecha(reloj, texto):
    y, m, d = (int(x) for x in texto.split("-"))
    reloj.ahora = datetime(y, m, d, 9, 0, tzinfo=ZONA)


# ------------------------------------------------------------ RF-27: iniciar


def test_inicia_los_periodos_programados_cuya_fecha_inicio_llego(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app, "E001", "ana@empresa.com")
    insertar(client, app, "V-1", "E001", "2026-10-10", "2026-10-20")
    poner_fecha(reloj, "2026-10-10")  # fechaInicio == hoy

    resultado = pasada(client, app)

    assert resultado == {"iniciados": ["V-1"], "finalizados": []}
    assert estado_de(client, "V-1") == "EN_CURSO"
    assert eventos(broker, "vacaciones.iniciadas") == [
        {
            "vacacionesId": "V-1",
            "empleadoId": "E001",
            "email": "ana@empresa.com",
            "fechaInicio": "2026-10-10",
            "fechaFin": "2026-10-20",
        }
    ]
    assert eventos(broker, "vacaciones.finalizadas") == []


def test_no_inicia_los_periodos_cuya_fecha_inicio_no_ha_llegado(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app)
    insertar(client, app, "V-1", "E001", "2026-10-11", "2026-10-20")
    poner_fecha(reloj, "2026-10-10")

    assert pasada(client, app) == {"iniciados": [], "finalizados": []}
    assert estado_de(client, "V-1") == "PROGRAMADA"
    assert broker.publicados == []


def test_no_toca_periodos_cancelados_ni_de_otros_estados(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app)
    insertar(client, app, "V-C", "E001", "2026-09-01", "2026-09-10", "CANCELADA")
    insertar(client, app, "V-F", "E001", "2026-08-01", "2026-08-10", "FINALIZADA")
    poner_fecha(reloj, "2026-10-10")

    assert pasada(client, app) == {"iniciados": [], "finalizados": []}
    assert estado_de(client, "V-C") == "CANCELADA"
    assert estado_de(client, "V-F") == "FINALIZADA"
    assert broker.publicados == []


# ------------------------------------------------------------ RF-28: finalizar


def test_el_dia_fecha_fin_sigue_en_curso_y_finaliza_al_dia_siguiente(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app, "E001", "ana@empresa.com")
    insertar(client, app, "V-1", "E001", "2026-10-01", "2026-10-10", "EN_CURSO")

    poner_fecha(reloj, "2026-10-10")  # hoy == fechaFin: las vacaciones incluyen ese día
    assert pasada(client, app) == {"iniciados": [], "finalizados": []}
    assert estado_de(client, "V-1") == "EN_CURSO"
    assert broker.publicados == []

    poner_fecha(reloj, "2026-10-11")  # fechaFin < hoy
    assert pasada(client, app) == {"iniciados": [], "finalizados": ["V-1"]}
    assert estado_de(client, "V-1") == "FINALIZADA"
    assert eventos(broker, "vacaciones.finalizadas") == [
        {"vacacionesId": "V-1", "empleadoId": "E001", "email": "ana@empresa.com", "fechaFin": "2026-10-10"}
    ]


def test_el_ciclo_completo_publica_cada_evento_una_sola_vez(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app)
    insertar(client, app, "V-1", "E001", "2026-10-12", "2026-10-14")

    for dia in ["2026-10-10", "2026-10-12", "2026-10-12", "2026-10-14", "2026-10-15", "2026-10-15", "2026-11-01"]:
        poner_fecha(reloj, dia)
        pasada(client, app)

    assert [t for t, _ in broker.publicados] == ["vacaciones.iniciadas", "vacaciones.finalizadas"]
    assert estado_de(client, "V-1") == "FINALIZADA"


def test_periodo_con_fechas_ya_pasadas_sale_iniciado_y_luego_finalizado_en_orden(entorno):
    """p. ej. el servicio estuvo caído: la cuenta se suspende y se reactiva, en ese orden."""
    client, app, broker, reloj = entorno
    alta_empleado(client, app)
    insertar(client, app, "V-1", "E001", "2026-10-01", "2026-10-05")
    poner_fecha(reloj, "2026-10-10")

    assert pasada(client, app) == {"iniciados": ["V-1"], "finalizados": ["V-1"]}
    assert [t for t, _ in broker.publicados] == ["vacaciones.iniciadas", "vacaciones.finalizadas"]
    assert estado_de(client, "V-1") == "FINALIZADA"


def test_procesa_varios_periodos_en_orden_de_fecha(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app, "E001", "a@a.com")
    alta_empleado(client, app, "E002", "b@b.com", id_="otro")
    insertar(client, app, "V-2", "E002", "2026-10-09", "2026-10-30")
    insertar(client, app, "V-1", "E001", "2026-10-08", "2026-10-30")
    poner_fecha(reloj, "2026-10-10")

    assert pasada(client, app)["iniciados"] == ["V-1", "V-2"]
    assert [d["vacacionesId"] for d in eventos(broker, "vacaciones.iniciadas")] == ["V-1", "V-2"]


# ------------------------------------------------------------ robustez


def test_si_falla_la_publicacion_el_periodo_conserva_su_estado_y_se_reintenta(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app)
    insertar(client, app, "V-1", "E001", "2026-10-10", "2026-10-20")
    poner_fecha(reloj, "2026-10-10")

    broker.fallar = True
    assert pasada(client, app) == {"iniciados": [], "finalizados": []}
    assert estado_de(client, "V-1") == "PROGRAMADA"  # no se perdió: sigue pendiente

    broker.fallar = False
    assert pasada(client, app) == {"iniciados": ["V-1"], "finalizados": []}
    assert estado_de(client, "V-1") == "EN_CURSO"
    assert len(eventos(broker, "vacaciones.iniciadas")) == 1


def test_un_periodo_que_falla_no_impide_procesar_los_demas(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app, "E001", "a@a.com")
    insertar(client, app, "V-1", "E001", "2026-10-09", "2026-10-30")
    insertar(client, app, "V-2", "SIN-REPLICA", "2026-10-09", "2026-10-30")  # sin réplica: no hay email
    insertar(client, app, "V-3", "E001", "2026-10-10", "2026-10-30")
    poner_fecha(reloj, "2026-10-10")

    # V-3 se solapa con V-1 pero el scheduler no valida solapamientos: eso se hizo al programar.
    assert pasada(client, app)["iniciados"] == ["V-1", "V-3"]
    assert estado_de(client, "V-2") == "PROGRAMADA"


def test_dos_pasadas_simultaneas_no_duplican_eventos(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app)
    insertar(client, app, "V-1", "E001", "2026-10-10", "2026-10-20")
    poner_fecha(reloj, "2026-10-10")

    async def dos():
        return await asyncio.gather(
            app.state.planificador.ejecutar_una_vez(), app.state.planificador.ejecutar_una_vez()
        )

    client.portal.call(dos)
    assert len(eventos(broker, "vacaciones.iniciadas")) == 1


def test_la_pasada_usa_la_fecha_de_negocio_no_la_utc(entorno):
    client, app, broker, reloj = entorno
    alta_empleado(client, app)
    insertar(client, app, "V-1", "E001", "2026-10-11", "2026-10-20")
    # 23:30 del 10 en Bogotá ya es el 11 en UTC: sigue siendo "hoy = 10"
    reloj.ahora = datetime(2026, 10, 10, 23, 30, tzinfo=ZONA)
    assert pasada(client, app)["iniciados"] == []


# ------------------------------------------------------------ RF-29: configuración y bucle


def test_la_frecuencia_se_configura_por_variable_de_entorno(monkeypatch):
    monkeypatch.delenv("SCHEDULER_INTERVALO_SEGUNDOS", raising=False)
    assert Settings.desde_entorno().scheduler_intervalo_s == 60.0  # por defecto, cada minuto
    monkeypatch.setenv("SCHEDULER_INTERVALO_SEGUNDOS", "5")
    assert Settings.desde_entorno().scheduler_intervalo_s == 5.0
    monkeypatch.setenv("SCHEDULER_INTERVALO_SEGUNDOS", "")
    assert Settings.desde_entorno().scheduler_intervalo_s == 60.0
    monkeypatch.setenv("SCHEDULER_INTERVALO_SEGUNDOS", "0")
    assert Settings.desde_entorno().scheduler_intervalo_s == 0.0
    monkeypatch.setenv("SCHEDULER_INTERVALO_SEGUNDOS", "mucho")
    with pytest.raises(ValueError):
        Settings.desde_entorno()


def test_el_scheduler_se_desactiva_con_intervalo_cero():
    assert PlanificadorVacaciones(None, 0).habilitado is False
    assert PlanificadorVacaciones(None, -1).habilitado is False
    assert PlanificadorVacaciones(None, 60).habilitado is True


def test_el_bucle_repite_cada_intervalo_y_sobrevive_a_un_fallo():
    llamadas = []

    class ServicioFalso:
        async def ejecutar_transiciones(self):
            llamadas.append(1)
            if len(llamadas) == 1:
                raise RuntimeError("BD caída")
            return {"iniciados": [], "finalizados": []}

    async def correr():
        plan = PlanificadorVacaciones(ServicioFalso(), 0.01)
        plan.iniciar()
        await asyncio.sleep(0.15)
        await plan.detener()

    asyncio.run(correr())
    assert len(llamadas) >= 3  # el primer fallo no detuvo el bucle


def test_el_bucle_arranca_y_se_detiene_con_la_aplicacion(pg_uri):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from tests.conftest import BrokerFalso

    settings = Settings(
        port=8085, db_host="", db_port=0, db_name="", db_user="", db_pass="",
        broker_url="", broker_exchange="x", zona_horaria="America/Bogota", dsn_url=pg_uri,
        scheduler_intervalo_s=0.05,
    )
    app = create_app(settings, broker=BrokerFalso(), arrancar_consumidores=False)
    with TestClient(app):
        assert app.state.planificador._tarea is not None
    assert app.state.planificador._tarea is None


# ------------------------------------------------------------ RF-30: endpoints de desarrollo


def test_los_endpoints_de_desarrollo_estan_desactivados_por_defecto(entorno):
    client, app, broker, _ = entorno
    assert Settings.desde_entorno().endpoints_desarrollo is False
    insertar(client, app, "V-1", "E001", "2027-01-01", "2027-01-05")
    assert client.post("/vacaciones/V-1/forzar-inicio").status_code == 404
    assert client.post("/vacaciones/V-1/forzar-fin").status_code == 404
    assert estado_de(client, "V-1") == "PROGRAMADA"
    rutas = client.get("/vacaciones/openapi.json").json()["paths"]
    assert not any("forzar" in ruta for ruta in rutas)


def test_la_variable_de_entorno_habilita_los_endpoints_de_desarrollo(monkeypatch):
    for valor, esperado in [("true", True), ("TRUE", True), ("1", True), ("false", False), ("", False), ("no", False)]:
        monkeypatch.setenv("ENDPOINTS_DESARROLLO_HABILITADOS", valor)
        assert Settings.desde_entorno().endpoints_desarrollo is esperado, valor


def test_forzar_inicio_ignora_la_fecha_y_publica_vacaciones_iniciadas(entorno_dev):
    client, app, broker, _ = entorno_dev
    alta_empleado(client, app, "E001", "ana@empresa.com")
    insertar(client, app, "V-1", "E001", "2027-03-15", "2027-03-30")  # fechas en el futuro

    r = client.post("/vacaciones/V-1/forzar-inicio")

    assert r.status_code == 200
    assert r.json()["estado"] == "EN_CURSO"
    assert r.json()["fechaInicio"] == "2027-03-15"  # no se tocan las fechas
    assert eventos(broker, "vacaciones.iniciadas") == [
        {
            "vacacionesId": "V-1", "empleadoId": "E001", "email": "ana@empresa.com",
            "fechaInicio": "2027-03-15", "fechaFin": "2027-03-30",
        }
    ]


def test_forzar_fin_ignora_la_fecha_y_publica_vacaciones_finalizadas(entorno_dev):
    client, app, broker, _ = entorno_dev
    alta_empleado(client, app, "E001", "ana@empresa.com")
    insertar(client, app, "V-1", "E001", "2027-03-15", "2027-03-30", "EN_CURSO")

    r = client.post("/vacaciones/V-1/forzar-fin")

    assert r.status_code == 200
    assert r.json()["estado"] == "FINALIZADA"
    assert eventos(broker, "vacaciones.finalizadas") == [
        {"vacacionesId": "V-1", "empleadoId": "E001", "email": "ana@empresa.com", "fechaFin": "2027-03-30"}
    ]


def test_flujo_de_prueba_completo_con_los_endpoints_forzados(entorno_dev):
    client, app, broker, _ = entorno_dev
    alta_empleado(client, app)
    id_ = client.post(
        "/vacaciones", json={"empleadoId": "E001", "fechaInicio": "2027-03-15", "fechaFin": "2027-03-30"}
    ).json()["id"]

    assert client.post(f"/vacaciones/{id_}/forzar-inicio").json()["estado"] == "EN_CURSO"
    assert client.post(f"/vacaciones/{id_}/forzar-fin").json()["estado"] == "FINALIZADA"
    assert [t for t, _ in broker.publicados] == [
        "vacaciones.programadas", "vacaciones.iniciadas", "vacaciones.finalizadas",
    ]


def test_forzar_con_estado_incorrecto_responde_409_y_no_publica(entorno_dev):
    client, app, broker, _ = entorno_dev
    alta_empleado(client, app)
    insertar(client, app, "V-P", "E001", "2027-03-15", "2027-03-30", "PROGRAMADA")
    insertar(client, app, "V-E", "E001", "2027-04-15", "2027-04-30", "EN_CURSO")
    insertar(client, app, "V-C", "E001", "2027-05-15", "2027-05-30", "CANCELADA")

    assert client.post("/vacaciones/V-P/forzar-fin").status_code == 409
    assert client.post("/vacaciones/V-E/forzar-inicio").status_code == 409
    assert client.post("/vacaciones/V-C/forzar-inicio").status_code == 409
    assert client.post("/vacaciones/V-C/forzar-fin").status_code == 409
    assert broker.publicados == []
    assert estado_de(client, "V-P") == "PROGRAMADA" and estado_de(client, "V-E") == "EN_CURSO"


def test_forzar_un_periodo_inexistente_responde_404(entorno_dev):
    client, *_ = entorno_dev
    assert client.post("/vacaciones/V-NO/forzar-inicio").status_code == 404
    assert client.post("/vacaciones/V-NO/forzar-fin").status_code == 404


def test_forzar_con_broker_caido_responde_503_y_no_cambia_el_estado(entorno_dev):
    client, app, broker, _ = entorno_dev
    alta_empleado(client, app)
    insertar(client, app, "V-1", "E001", "2027-03-15", "2027-03-30")
    broker.fallar = True

    assert client.post("/vacaciones/V-1/forzar-inicio").status_code == 503
    assert estado_de(client, "V-1") == "PROGRAMADA"


def test_los_endpoints_forzados_y_el_scheduler_comparten_la_misma_funcion(entorno_dev):
    """El forzado deja el período en el mismo estado y con el mismo evento que el scheduler."""
    client, app, broker, reloj = entorno_dev
    alta_empleado(client, app, "E001", "ana@empresa.com")
    insertar(client, app, "V-A", "E001", "2026-10-10", "2026-10-20")
    insertar(client, app, "V-B", "E001", "2026-10-10", "2026-10-20")
    poner_fecha(reloj, "2026-10-10")

    client.post("/vacaciones/V-A/forzar-inicio")
    # V-B lo inicia el scheduler; V-A ya no está PROGRAMADA y no se repite
    assert pasada(client, app)["iniciados"] == ["V-B"]
    por_id = {d["vacacionesId"]: d for d in eventos(broker, "vacaciones.iniciadas")}
    assert set(por_id) == {"V-A", "V-B"}
    assert {k for k in por_id["V-A"]} == {k for k in por_id["V-B"]}


def test_los_endpoints_de_desarrollo_estan_marcados_en_swagger(entorno_dev):
    client, *_ = entorno_dev
    esquema = client.get("/vacaciones/openapi.json").json()
    for ruta in ("/vacaciones/{id}/forzar-inicio", "/vacaciones/{id}/forzar-fin"):
        operacion = esquema["paths"][ruta]["post"]
        assert operacion["tags"] == ["Desarrollo (no usar en producción)"]
        assert operacion["summary"].startswith("[DESARROLLO]")
        assert operacion["x-desarrollo"] is True
        assert "no usar en producción" in operacion["description"].lower()
        assert "Solo ADMIN" in operacion["description"]
