-- ============================================================
-- Migración RF-42: empleados_replica + vacaciones_finalizadas_pendientes + ajustes notificaciones
-- Ejecutable en BD existente (idempotente) y copiado a init.sql para nuevas
-- ============================================================

-- 0. Ajustes a la tabla notificaciones (compatibilidad con código RF-42)
-- El código usa ON CONFLICT (evento_id, tipo) y requiere empleado_id NULL para usuario.recuperacion
-- Verificar duplicados antes de crear la restricción compuesta:
-- SELECT evento_id, tipo, COUNT(*) FROM notificaciones GROUP BY evento_id, tipo HAVING COUNT(*) > 1;
-- Si hay duplicados, requieren resolución manual ANTES de aplicar esta migración.

-- Eliminar restricción antigua si existe
ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_evento_id_key;
-- Eliminar restricción compuesta si existe (idempotente)
ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_evento_id_tipo_key;
-- Crear restricción compuesta UNIQUE (evento_id, tipo)
ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_evento_id_tipo_key UNIQUE (evento_id, tipo);
-- Permitir NULL en empleado_id (para usuario.recuperacion)
ALTER TABLE notificaciones ALTER COLUMN empleado_id DROP NOT NULL;

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

-- Consulta de diagnóstico para verificar duplicados antes de crear UNIQUE (evento_id, tipo):
-- SELECT evento_id, tipo, COUNT(*) as duplicados
-- FROM notificaciones
-- GROUP BY evento_id, tipo
-- HAVING COUNT(*) > 1;

-- Consultas adicionales de diagnóstico:
-- Verificar restricciones existentes en notificaciones:
-- SELECT conname, contype, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'notificaciones'::regclass;
-- Verificar tipos y nulabilidad de columnas:
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'notificaciones'
-- ORDER BY ordinal_position;
-- Verificar existencia de tablas nuevas:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_name IN ('empleados_replica', 'vacaciones_finalizadas_pendientes');
