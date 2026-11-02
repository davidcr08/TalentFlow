package com.talentflow.notificaciones;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.talentflow.notificaciones.dominio.NotificacionNueva;
import com.talentflow.notificaciones.dominio.TipoNotificacion;
import com.talentflow.notificaciones.eventos.Envelope;
import com.talentflow.notificaciones.eventos.EventoInvalidoException;
import com.talentflow.notificaciones.eventos.EventoParser;
import com.talentflow.notificaciones.servicio.ConstructorNotificaciones;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

class ConstructorNotificacionesTest {

    private static final String TOKEN = "aaa.bbb.ccc";

    private final EventoParser parser = new EventoParser(new ObjectMapper());
    private final ConstructorNotificaciones constructor = new ConstructorNotificaciones();

    private Envelope evento(String tipo, String data) {
        String json = "{\"id\":\"m-1\",\"type\":\"" + tipo + "\",\"version\":1,"
                + "\"occurredAt\":\"2026-10-10T12:00:00Z\",\"producer\":\"p\",\"data\":" + data + "}";
        return parser.parsear(json.getBytes(StandardCharsets.UTF_8));
    }

    private static String usuarioCreado() {
        return "{\"empleadoId\":\"E001\",\"email\":\"juan@empresa.com\","
                + "\"tokenActivacion\":\"" + TOKEN + "\",\"expiraEn\":\"2026-10-11T12:00:00Z\"}";
    }

    // ---- RF-18: bienvenida con usuario.creado; empleado.* solo traza ----

    @Test
    void usuarioCreadoGeneraBienvenidaYSeguridad() {
        List<NotificacionNueva> n = constructor.construir(evento("usuario.creado", usuarioCreado()));

        assertThat(n).extracting(NotificacionNueva::tipo)
                .containsExactly(TipoNotificacion.BIENVENIDA, TipoNotificacion.SEGURIDAD);
        assertThat(n).allSatisfy(x -> {
            assertThat(x.destinatario()).isEqualTo("juan@empresa.com");
            assertThat(x.empleadoId()).isEqualTo("E001");
        });
        assertThat(n.get(0).mensaje()).startsWith("Bienvenido juan@empresa.com");
    }

    @Test
    void bienvenidaUsaNombreYApellidoSiElEventoLosTrae() {
        List<NotificacionNueva> n = constructor.construir(evento("usuario.creado",
                "{\"empleadoId\":\"E001\",\"nombre\":\"Juan\",\"apellido\":\"Pérez\",\"email\":\"juan@empresa.com\","
                        + "\"tokenActivacion\":\"" + TOKEN + "\"}"));
        assertThat(n.get(0).mensaje()).startsWith("Bienvenido Juan Pérez");
    }

    @Test
    void empleadoCreadoYEmpleadoRetiradoSoloSonTrazaYNoGeneranNotificacion() {
        Envelope creado = evento("empleado.creado",
                "{\"empleadoId\":\"E001\",\"nombre\":\"Juan\",\"email\":\"juan@empresa.com\"}");
        Envelope retirado = evento("empleado.retirado",
                "{\"empleadoId\":\"E001\",\"email\":\"juan@empresa.com\",\"fechaRetiro\":\"2026-11-30T16:45:00Z\"}");

        assertThat(constructor.esSoloTraza(creado)).isTrue();
        assertThat(constructor.esSoloTraza(retirado)).isTrue();
        assertThat(constructor.construir(creado)).isEmpty();
        assertThat(constructor.construir(retirado)).isEmpty();
        assertThat(constructor.esSoloTraza(evento("usuario.creado", usuarioCreado()))).isFalse();
    }

    // ---- RF-16: SEGURIDAD con enlace y token ----

    @Test
    void usuarioCreadoEnviaElEnlaceYElTokenDeActivacion() {
        NotificacionNueva s = constructor.construir(evento("usuario.creado", usuarioCreado())).get(1);

        assertThat(s.tipo()).isEqualTo(TipoNotificacion.SEGURIDAD);
        assertThat(s.textoAEnviar())
                .contains("http://localhost:8080/auth/reset-password?token=" + TOKEN)
                .contains("Token de activación: " + TOKEN)
                .contains("2026-10-11T12:00:00Z");
    }

    @Test
    void usuarioRecuperacionEnviaElEnlaceYElTokenDeRecuperacion() {
        NotificacionNueva s = constructor.construir(evento("usuario.recuperacion",
                "{\"email\":\"juan@empresa.com\",\"tokenRecuperacion\":\"" + TOKEN
                        + "\",\"expiraEn\":\"2026-10-10T12:30:00Z\"}")).get(0);

        assertThat(s.tipo()).isEqualTo(TipoNotificacion.SEGURIDAD);
        assertThat(s.destinatario()).isEqualTo("juan@empresa.com");
        assertThat(s.empleadoId()).isNull();
        assertThat(s.textoAEnviar())
                .contains("?token=" + TOKEN)
                .contains("Token de recuperación: " + TOKEN);
    }

    @Test
    void elTokenSeEnviaPeroNoSeGuardaEnElMensajeDeLaApi() {
        NotificacionNueva s = constructor.construir(evento("usuario.creado", usuarioCreado())).get(1);
        assertThat(s.mensaje()).doesNotContain(TOKEN).doesNotContain("token=");
        assertThat(s.textoAEnviar()).contains(TOKEN);
    }

    @Test
    void elEnlaceBaseEsConfigurable() {
        ConstructorNotificaciones propio = new ConstructorNotificaciones("https://app.empresa.com/reset");
        NotificacionNueva s = propio.construir(evento("usuario.creado", usuarioCreado())).get(1);
        assertThat(s.textoAEnviar()).contains("https://app.empresa.com/reset?token=" + TOKEN);
    }

    @Test
    void faltaElTokenEsEventoInvalido() {
        assertThatThrownBy(() -> constructor.construir(evento("usuario.creado",
                "{\"empleadoId\":\"E001\",\"email\":\"juan@empresa.com\"}")))
                .isInstanceOf(EventoInvalidoException.class)
                .hasMessageContaining("data.tokenActivacion");
        assertThatThrownBy(() -> constructor.construir(evento("usuario.recuperacion",
                "{\"email\":\"juan@empresa.com\"}")))
                .isInstanceOf(EventoInvalidoException.class)
                .hasMessageContaining("data.tokenRecuperacion");
    }

    // ---- RF-17: CUENTA según el motivo ----

    private NotificacionNueva cuenta(String tipo, String motivo, String extra) {
        return constructor.construir(evento(tipo,
                "{\"empleadoId\":\"E001\",\"email\":\"juan@empresa.com\",\"motivo\":\"" + motivo + "\"" + extra + "}"))
                .get(0);
    }

    @Test
    void cuentaDesactivadaPorVacaciones() {
        NotificacionNueva n = cuenta("cuenta.desactivada", "VACACIONES", ",\"permanente\":false");
        assertThat(n.tipo()).isEqualTo(TipoNotificacion.CUENTA);
        assertThat(n.destinatario()).isEqualTo("juan@empresa.com");
        assertThat(n.mensaje()).contains("suspendida temporalmente").contains("vacaciones");
    }

    @Test
    void cuentaDesactivadaPorRetiroEsLaDespedida() {
        NotificacionNueva n = cuenta("cuenta.desactivada", "RETIRO", ",\"permanente\":true");
        assertThat(n.tipo()).isEqualTo(TipoNotificacion.CUENTA);
        assertThat(n.mensaje()).contains("Gracias por su trabajo").contains("permanente").contains("retiro");
    }

    @Test
    void cuentaActivadaPorActivacionInicial() {
        NotificacionNueva n = cuenta("cuenta.activada", "ACTIVACION_INICIAL", "");
        assertThat(n.tipo()).isEqualTo(TipoNotificacion.CUENTA);
        assertThat(n.mensaje()).contains("activada").contains("iniciar sesión");
    }

    @Test
    void cuentaActivadaPorFinDeVacaciones() {
        NotificacionNueva n = cuenta("cuenta.activada", "FIN_VACACIONES", "");
        assertThat(n.tipo()).isEqualTo(TipoNotificacion.CUENTA);
        assertThat(n.mensaje()).contains("vacaciones han finalizado").contains("reactivada");
    }

    @Test
    void cadaMotivoTieneUnMensajeDistinto() {
        List<String> mensajes = List.of(
                cuenta("cuenta.desactivada", "VACACIONES", ",\"permanente\":false").mensaje(),
                cuenta("cuenta.desactivada", "RETIRO", ",\"permanente\":true").mensaje(),
                cuenta("cuenta.activada", "ACTIVACION_INICIAL", "").mensaje(),
                cuenta("cuenta.activada", "FIN_VACACIONES", "").mensaje());
        assertThat(mensajes).doesNotHaveDuplicates();
    }

    @Test
    void unMotivoDesconocidoNoRompeYUsaUnMensajeGenerico() {
        assertThat(cuenta("cuenta.desactivada", "OTRO", ",\"permanente\":true").mensaje())
                .isEqualTo("Su cuenta ha sido desactivada de forma permanente.");
        assertThat(cuenta("cuenta.desactivada", "OTRO", ",\"permanente\":false").mensaje())
                .isEqualTo("Su cuenta ha sido desactivada temporalmente.");
        assertThat(cuenta("cuenta.activada", "OTRO", "").mensaje()).isEqualTo("Su cuenta ha sido activada.");
    }

    @Test
    void cuentaSinEmpleadoIdOSinEmailEsEventoInvalido() {
        assertThatThrownBy(() -> constructor.construir(evento("cuenta.activada",
                "{\"email\":\"a@a.com\",\"motivo\":\"FIN_VACACIONES\"}")))
                .isInstanceOf(EventoInvalidoException.class)
                .hasMessageContaining("data.empleadoId");
        assertThatThrownBy(() -> constructor.construir(evento("cuenta.desactivada",
                "{\"empleadoId\":\"E001\",\"motivo\":\"RETIRO\"}")))
                .isInstanceOf(EventoInvalidoException.class)
                .hasMessageContaining("data.email");
    }

    // ---- sin cambios ----

    @Test
    void vacacionesProgramadasGeneraConfirmacionConLasFechas() {
        NotificacionNueva n = constructor.construir(evento("vacaciones.programadas",
                "{\"vacacionesId\":\"V-2026-0042\",\"empleadoId\":\"E001\",\"email\":\"juan@empresa.com\","
                        + "\"fechaInicio\":\"2027-03-15\",\"fechaFin\":\"2027-03-30\",\"diasHabiles\":12}"))
                .get(0);

        assertThat(n.tipo()).isEqualTo(TipoNotificacion.VACACIONES);
        assertThat(n.mensaje()).startsWith("Sus vacaciones del 2027-03-15 al 2027-03-30")
                .contains("12 días hábiles")
                .contains("V-2026-0042");
    }

    @Test
    void unEventoAjenoNoGeneraNotificacion() {
        assertThat(constructor.construir(evento("empleado.actualizado", "{\"empleadoId\":\"E001\"}"))).isEmpty();
    }

    @Test
    void faltaElEmpleadoIdEsEventoInvalido() {
        assertThatThrownBy(() -> constructor.construir(evento("vacaciones.programadas",
                "{\"email\":\"a@a.com\",\"fechaInicio\":\"2027-01-01\",\"fechaFin\":\"2027-01-05\"}")))
                .isInstanceOf(EventoInvalidoException.class)
                .hasMessageContaining("data.empleadoId");
    }
}
