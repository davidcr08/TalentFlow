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

-- RF-42: Réplica local de empleados para evaluar estado al recibir vacaciones.finalizadas
CREATE TABLE IF NOT EXISTS empleados_replica (
    empleado_id       VARCHAR(20)  PRIMARY KEY,
    email             VARCHAR(150) NOT NULL,
    estado            VARCHAR(20)  NOT NULL DEFAULT 'ACTIVO',
    ultimo_evento_ts  TIMESTAMPTZ  NOT NULL,
    actualizado_en    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE empleados_replica DROP CONSTRAINT IF EXISTS empleados_replica_estado_check;
ALTER TABLE empleados_replica ADD CONSTRAINT empleados_replica_estado_check
    CHECK (estado IN ('ACTIVO', 'RETIRADO'));

-- RF-42: Pendientes de procesamiento de vacaciones.finalizadas
CREATE TABLE IF NOT EXISTS vacaciones_finalizadas_pendientes (
    id                  VARCHAR(64)  PRIMARY KEY,
    empleado_id         VARCHAR(20)  NOT NULL,
    email               VARCHAR(150) NOT NULL,
    fecha_fin           DATE         NOT NULL,
    vacaciones_id       VARCHAR(20)  NOT NULL,
    estado              VARCHAR(20)  NOT NULL DEFAULT 'PENDIENTE',
    intento_actual      INTEGER      NOT NULL DEFAULT 0,
    max_intentos        INTEGER      NOT NULL DEFAULT 10,
    reclamado_por       VARCHAR(100) NULL,
    reclamado_en        TIMESTAMPTZ  NULL,
    creado_en           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    actualizado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    procesado_en        TIMESTAMPTZ  NULL
);

ALTER TABLE vacaciones_finalizadas_pendientes DROP CONSTRAINT IF EXISTS vacaciones_finalizadas_pendientes_estado_check;
ALTER TABLE vacaciones_finalizadas_pendientes ADD CONSTRAINT vacaciones_finalizadas_pendientes_estado_check
    CHECK (estado IN ('PENDIENTE', 'PROCESADO_ACTIVO', 'PROCESADO_RETIRADO', 'REQUIERE_REVISION'));

CREATE INDEX IF NOT EXISTS idx_pendientes_empleado 
    ON vacaciones_finalizadas_pendientes (empleado_id, estado);
CREATE INDEX IF NOT EXISTS idx_pendientes_estado_reclamado 
    ON vacaciones_finalizadas_pendientes (estado, reclamado_en) 
    WHERE estado = 'PENDIENTE';
