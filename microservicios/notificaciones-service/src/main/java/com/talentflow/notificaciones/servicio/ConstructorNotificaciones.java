package com.talentflow.notificaciones.servicio;

import com.fasterxml.jackson.databind.JsonNode;
import com.talentflow.notificaciones.dominio.NotificacionNueva;
import com.talentflow.notificaciones.dominio.TipoNotificacion;
import com.talentflow.notificaciones.eventos.Envelope;
import com.talentflow.notificaciones.eventos.EventoInvalidoException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Traduce un evento del catálogo a las notificaciones que corresponden (función
 * pura, sin I/O).
 *
 * <ul>
 * <li>RF-16 usuario.creado / usuario.recuperacion -> SEGURIDAD con el enlace y el token.</li>
 * <li>RF-17 cuenta.activada / cuenta.desactivada -> CUENTA, con el mensaje según el motivo
 * (VACACIONES, RETIRO, ACTIVACION_INICIAL, FIN_VACACIONES). La despedida sale aquí (RETIRO).</li>
 * <li>RF-18 usuario.creado -> además, BIENVENIDA. empleado.creado y empleado.retirado ya NO envían
 * nada: solo dejan una traza (catálogo 3.1 y 3.3).</li>
 * <li>vacaciones.programadas -> VACACIONES (sin cambios).</li>
 * </ul>
 */
@Component
public class ConstructorNotificaciones {

    public static final String EMPLEADO_CREADO = "empleado.creado";
    public static final String EMPLEADO_RETIRADO = "empleado.retirado";
    public static final String USUARIO_CREADO = "usuario.creado";
    public static final String USUARIO_RECUPERACION = "usuario.recuperacion";
    public static final String CUENTA_ACTIVADA = "cuenta.activada";
    public static final String CUENTA_DESACTIVADA = "cuenta.desactivada";
    public static final String VACACIONES_PROGRAMADAS = "vacaciones.programadas";

    public static final String ENLACE_RESET_POR_DEFECTO = "http://localhost:8080/auth/reset-password";

    private final String enlaceReset;

    public ConstructorNotificaciones() {
        this(ENLACE_RESET_POR_DEFECTO);
    }

    @Autowired
    public ConstructorNotificaciones(
            @Value("${app.enlaces.reset-password:" + ENLACE_RESET_POR_DEFECTO + "}") String enlaceReset) {
        this.enlaceReset = enlaceReset;
    }

    /**
     * RF-18: eventos que este servicio solo registra como traza, sin enviar nada. Se mantienen
     * enlazados a la cola para dejar constancia de que llegaron.
     */
    public boolean esSoloTraza(Envelope evento) {
        return EMPLEADO_CREADO.equals(evento.type()) || EMPLEADO_RETIRADO.equals(evento.type());
    }

    /** Lista vacía si este servicio no genera notificación para ese tipo de evento. */
    public List<NotificacionNueva> construir(Envelope evento) {
        return switch (evento.type()) {
            case USUARIO_CREADO -> List.of(bienvenida(evento), activacion(evento));
            case USUARIO_RECUPERACION -> List.of(recuperacion(evento));
            case CUENTA_ACTIVADA -> List.of(cuentaActivada(evento));
            case CUENTA_DESACTIVADA -> List.of(cuentaDesactivada(evento));
            case VACACIONES_PROGRAMADAS -> List.of(vacaciones(evento));
            default -> List.of();
        };
    }

    // ---- RF-18: bienvenida (usuario.creado) ----

    private NotificacionNueva bienvenida(Envelope e) {
        String empleadoId = requerido(e, "empleadoId");
        String email = requerido(e, "email");
        String nombre = (opcional(e, "nombre") + " " + opcional(e, "apellido")).trim();
        if (nombre.isEmpty()) {
            nombre = email;
        }
        String mensaje = "Bienvenido " + nombre + ". Su registro como empleado fue exitoso.";
        return new NotificacionNueva(TipoNotificacion.BIENVENIDA, email, mensaje, empleadoId);
    }

    // ---- RF-16: SEGURIDAD con enlace y token ----

    private NotificacionNueva activacion(Envelope e) {
        String empleadoId = requerido(e, "empleadoId");
        String email = requerido(e, "email");
        String token = requerido(e, "tokenActivacion");
        return seguridad(email, empleadoId, token, opcional(e, "expiraEn"),
                "Active su cuenta y defina su contraseña", "activación");
    }

    private NotificacionNueva recuperacion(Envelope e) {
        String email = requerido(e, "email");
        String token = requerido(e, "tokenRecuperacion");
        // El catálogo de usuario.recuperacion no incluye empleadoId: la notificación queda sin él.
        String empleadoId = opcional(e, "empleadoId");
        return seguridad(email, empleadoId.isEmpty() ? null : empleadoId, token, opcional(e, "expiraEn"),
                "Restablezca su contraseña", "recuperación");
    }

    private NotificacionNueva seguridad(String email, String empleadoId, String token, String expiraEn,
            String accion, String clase) {
        String enlace = enlaceReset + (enlaceReset.contains("?") ? "&" : "?") + "token="
                + URLEncoder.encode(token, StandardCharsets.UTF_8);
        String vigencia = expiraEn.isEmpty() ? "" : " Vence el " + expiraEn + ".";
        // Lo que se guarda y devuelve la API NO lleva el token: cualquiera con acceso a
        // GET /notificaciones podría usarlo para apropiarse de la cuenta.
        String guardado = "Se envió un enlace de " + clase + " de cuenta." + vigencia;
        String enviado = accion + ": " + enlace + " | Token de " + clase + ": " + token + "." + vigencia;
        return new NotificacionNueva(TipoNotificacion.SEGURIDAD, email, guardado, empleadoId, enviado);
    }

    // ---- RF-17: CUENTA según el motivo ----

    private NotificacionNueva cuentaActivada(Envelope e) {
        String empleadoId = requerido(e, "empleadoId");
        String email = requerido(e, "email");
        String mensaje = switch (opcional(e, "motivo")) {
            case "ACTIVACION_INICIAL" -> "Su cuenta ha sido activada. Ya puede iniciar sesión con su nueva contraseña.";
            case "FIN_VACACIONES" -> "Sus vacaciones han finalizado: su cuenta ha sido reactivada. ¡Bienvenido de vuelta!";
            default -> "Su cuenta ha sido activada.";
        };
        return new NotificacionNueva(TipoNotificacion.CUENTA, email, mensaje, empleadoId);
    }

    private NotificacionNueva cuentaDesactivada(Envelope e) {
        String empleadoId = requerido(e, "empleadoId");
        String email = requerido(e, "email");
        JsonNode permanente = e.data().get("permanente");
        boolean esPermanente = permanente != null && permanente.isBoolean() && permanente.asBoolean();
        String mensaje = switch (opcional(e, "motivo")) {
            case "VACACIONES" -> "Su cuenta ha sido suspendida temporalmente mientras dura su período de vacaciones.";
            // Despedida: se dispara aquí y no con empleado.retirado (RF-17).
            case "RETIRO" -> "Gracias por su trabajo en la empresa. Su cuenta ha sido desactivada de forma "
                    + "permanente por su retiro. Le deseamos mucho éxito.";
            default -> esPermanente
                    ? "Su cuenta ha sido desactivada de forma permanente."
                    : "Su cuenta ha sido desactivada temporalmente.";
        };
        return new NotificacionNueva(TipoNotificacion.CUENTA, email, mensaje, empleadoId);
    }

    // ---- vacaciones.programadas (sin cambios) ----

    private NotificacionNueva vacaciones(Envelope e) {
        String empleadoId = requerido(e, "empleadoId");
        String email = requerido(e, "email");
        String inicio = requerido(e, "fechaInicio");
        String fin = requerido(e, "fechaFin");
        String periodo = opcional(e, "vacacionesId");
        JsonNode dias = e.data().get("diasHabiles");

        StringBuilder mensaje = new StringBuilder("Sus vacaciones del ")
                .append(inicio).append(" al ").append(fin);
        if (dias != null && dias.isNumber()) {
            mensaje.append(" (").append(dias.asInt()).append(" días hábiles)");
        }
        mensaje.append(" han sido programadas");
        if (!periodo.isEmpty()) {
            mensaje.append(" [período ").append(periodo).append("]");
        }
        mensaje.append(".");
        return new NotificacionNueva(TipoNotificacion.VACACIONES, email, mensaje.toString(), empleadoId);
    }

    private static String requerido(Envelope e, String campo) {
        JsonNode valor = e.data().get(campo);
        if (valor == null || !valor.isTextual() || valor.asText().isBlank()) {
            throw new EventoInvalidoException("data." + campo + " es obligatorio en " + e.type());
        }
        return valor.asText().trim();
    }

    private static String opcional(Envelope e, String campo) {
        JsonNode valor = e.data().get(campo);
        if (valor == null || valor.isNull()) {
            return "";
        }
        return valor.asText().trim();
    }
}
