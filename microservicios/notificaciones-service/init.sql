-- Modelo de base de datos del microservicio de notificaciones
-- Motor: PostgreSQL (ver docker-compose.yml -> database-notificaciones)

CREATE TABLE IF NOT EXISTS notificaciones (
    id            VARCHAR(36)  PRIMARY KEY,
    tipo          VARCHAR(20)  NOT NULL,
    destinatario  VARCHAR(150) NOT NULL,
    mensaje       TEXT         NOT NULL,
    fecha_envio   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- NULL en las notificaciones de usuario.recuperacion: ese evento no trae empleadoId.
    empleado_id   VARCHAR(20)  NULL,
    -- Mensaje (envelope.id) que originó la notificación. Un mismo evento puede generar varias
    -- (usuario.creado: BIENVENIDA + SEGURIDAD), así que la unicidad es (evento_id, tipo): segunda
    -- red de seguridad contra duplicados, además de la tabla eventos_procesados.
    evento_id     VARCHAR(64)  NOT NULL
);

-- RF-16/RF-17/RF-18. Idempotente: también sirve para bases ya creadas (init.sql no se reejecuta
-- sobre un volumen existente; aplíquelo a mano o use `docker compose down -v`).
-- DESVINCULACION ya no se genera (la despedida es CUENTA con motivo RETIRO) pero se admite para
-- no invalidar las filas que dejó el Reto 4.
ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_tipo_check;
ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_tipo_check
    CHECK (tipo IN ('BIENVENIDA', 'DESVINCULACION', 'VACACIONES', 'SEGURIDAD', 'CUENTA'));
ALTER TABLE notificaciones ALTER COLUMN empleado_id DROP NOT NULL;
ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_evento_id_key;
ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_evento_id_tipo_key;
ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_evento_id_tipo_key UNIQUE (evento_id, tipo);

CREATE INDEX IF NOT EXISTS idx_notificaciones_empleado ON notificaciones (empleado_id, fecha_envio);

-- Deduplicación de eventos por id de mensaje (Catálogo de Eventos, sección 2.1).
CREATE TABLE IF NOT EXISTS eventos_procesados (
    id            VARCHAR(64)  PRIMARY KEY,
    procesado_en  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
