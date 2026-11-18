-- ============================================================
-- Migración RF-42: empleados_replica + vacaciones_finalizadas_pendientes
-- Ejecutable en BD existente (idempotente) y copiado a init.sql para nuevas
-- ============================================================

-- 1. empleados_replica
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

-- 2. vacaciones_finalizadas_pendientes
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

-- CHECK estado CORREGIDO: tabla real = vacaciones_finalizadas_pendientes
ALTER TABLE vacaciones_finalizadas_pendientes DROP CONSTRAINT IF EXISTS vacaciones_finalizadas_pendientes_estado_check;
ALTER TABLE vacaciones_finalizadas_pendientes ADD CONSTRAINT vacaciones_finalizadas_pendientes_estado_check
    CHECK (estado IN ('PENDIENTE', 'PROCESADO_ACTIVO', 'PROCESADO_RETIRADO', 'REQUIERE_REVISION'));

-- Índices
CREATE INDEX IF NOT EXISTS idx_pendientes_empleado 
    ON vacaciones_finalizadas_pendientes (empleado_id, estado);
CREATE INDEX IF NOT EXISTS idx_pendientes_estado_reclamado 
    ON vacaciones_finalizadas_pendientes (estado, reclamado_en) 
    WHERE estado = 'PENDIENTE';
