-- Modelo de base de datos para el microservicio de gestión de empleados
-- Motor: PostgreSQL (ver docker-compose.yml -> database-empleados)

CREATE TABLE IF NOT EXISTS empleados (
    id                VARCHAR(20)  PRIMARY KEY,
    nombre            VARCHAR(100) NOT NULL,
    apellido          VARCHAR(100) NOT NULL,
    email             VARCHAR(150) NOT NULL UNIQUE,
    numero_empleado   VARCHAR(30)  NOT NULL UNIQUE,
    cargo             VARCHAR(100) NOT NULL,
    area              VARCHAR(100) NOT NULL,
    departamento_id   VARCHAR(20)  NOT NULL,
    fecha_ingreso     DATE         NOT NULL,
    estado            VARCHAR(20)  NOT NULL DEFAULT 'ACTIVO'
                       CHECK (estado IN ('ACTIVO', 'EN_VACACIONES', 'RETIRADO')),
    -- Estado de la verificación del departamento, independiente del ciclo de vida
    -- laboral (columna "estado" de arriba). PENDIENTE cuando el registro se aceptó
    -- con departamentos-service caído (Circuit Breaker abierto); se reconcilia a
    -- ACEPTADO o RECHAZADO automáticamente cuando el servicio se restablece
    -- (ver reconciliarPendientes() en services/empleados.service.js).
    validacion_departamento VARCHAR(20) NOT NULL DEFAULT 'ACEPTADO'
                       CHECK (validacion_departamento IN ('PENDIENTE', 'ACEPTADO', 'RECHAZADO')),
    creado_en         TIMESTAMP    NOT NULL DEFAULT now(),
    fecha_retiro      TIMESTAMP    NULL     
);

CREATE INDEX IF NOT EXISTS idx_empleados_departamento_id ON empleados (departamento_id);
CREATE INDEX IF NOT EXISTS idx_empleados_email ON empleados (email);
CREATE INDEX IF NOT EXISTS idx_empleados_validacion_departamento ON empleados (validacion_departamento);

ALTER TABLE empleados
ADD COLUMN IF NOT EXISTS fecha_retiro TIMESTAMP NULL;

-- RF-01/RF-02: cuentas de acceso. Una cuenta por empleado; el ADMIN semilla NO vive aquí
-- (se configura por variables de entorno ADMIN_*). Nunca se guarda la contraseña en claro:
-- solo el hash scrypt (ver src/auth/password.js).
CREATE TABLE IF NOT EXISTS cuentas (
    empleado_id    VARCHAR(20)  PRIMARY KEY REFERENCES empleados (id),
    password_hash  VARCHAR(300) NOT NULL,
    role           VARCHAR(10)  NOT NULL DEFAULT 'USER'
                    CHECK (role IN ('ADMIN', 'USER')),
    estado         VARCHAR(30)  NOT NULL DEFAULT 'ACTIVA'
                    CHECK (estado IN ('ACTIVA', 'INACTIVA', 'SUSPENDIDA_TEMPORAL', 'DESACTIVADA_PERMANENTE')),
    -- RF-04: versión de los tokens de reset de la cuenta. Cada token lleva la versión vigente al
    -- emitirse; al usarlo se incrementa y los tokens anteriores quedan obsoletos (un solo uso).
    token_version  INTEGER      NOT NULL DEFAULT 0
);

-- Para bases ya creadas (init.sql no se reejecuta sobre un volumen existente):
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuentas ALTER COLUMN estado TYPE VARCHAR(30);
ALTER TABLE cuentas DROP CONSTRAINT IF EXISTS cuentas_estado_check;
ALTER TABLE cuentas ADD CONSTRAINT cuentas_estado_check
    CHECK (estado IN ('ACTIVA', 'INACTIVA', 'SUSPENDIDA_TEMPORAL', 'DESACTIVADA_PERMANENTE'));
