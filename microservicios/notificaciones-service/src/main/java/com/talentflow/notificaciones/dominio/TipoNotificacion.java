package com.talentflow.notificaciones.dominio;

public enum TipoNotificacion {
    /** Bienvenida: se dispara con usuario.creado (RF-18). */
    BIENVENIDA("BIENVENIDA"),
    /**
     * Obsoleto desde RF-17/RF-18: ya no se genera. La despedida sale con cuenta.desactivada
     * (motivo RETIRO) como notificación de tipo CUENTA. Se conserva solo para poder leer las
     * filas que el Reto 4 dejó guardadas con este tipo.
     */
    @Deprecated
    DESVINCULACION("DESVINCULACIÓN"),
    VACACIONES("VACACIONES"),
    /** Enlace y token de activación o de recuperación de contraseña (RF-16). */
    SEGURIDAD("SEGURIDAD"),
    /** Cambios de estado de la cuenta: activada / desactivada (RF-17). */
    CUENTA("CUENTA");

    private final String etiquetaLog;

    TipoNotificacion(String etiquetaLog) {
        this.etiquetaLog = etiquetaLog;
    }

    /** Texto usado en el log simulado (con tilde, como en el enunciado). El JSON usa name(). */
    public String etiquetaLog() {
        return etiquetaLog;
    }
}
