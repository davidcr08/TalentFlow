package com.talentflow.notificaciones.dominio;

/**
 * Datos de una notificación aún no persistida (derivada de un evento).
 *
 * @param mensaje     texto que se guarda y que devuelve la API REST.
 * @param cuerpoEnvio texto que se "envía" (se escribe en el log simulado). Si es null se envía
 *                    {@code mensaje}. Se separan para que un secreto (el token de un enlace de
 *                    activación o de reset) llegue al destinatario sin quedar guardado ni
 *                    expuesto en GET /notificaciones.
 */
public record NotificacionNueva(TipoNotificacion tipo, String destinatario, String mensaje, String empleadoId,
        String cuerpoEnvio) {

    public NotificacionNueva(TipoNotificacion tipo, String destinatario, String mensaje, String empleadoId) {
        this(tipo, destinatario, mensaje, empleadoId, null);
    }

    /** Lo que sale por el canal de envío simulado. */
    public String textoAEnviar() {
        return cuerpoEnvio != null ? cuerpoEnvio : mensaje;
    }
}
