const COLUMNAS = `c.empleado_id, e.email, c.password_hash, c.role, c.estado, c.token_version`;

function aCuenta(fila) {
  if (!fila) return null;
  return {
    empleadoId: fila.empleado_id,
    email: fila.email,
    passwordHash: fila.password_hash,
    role: fila.role,
    estado: fila.estado,
    versionToken: fila.token_version
  };
}

// Las operaciones reciben un "ejecutor" con .query: el pool (cada consulta en su conexión) o un
// cliente dentro de una transacción (ver transaccion() abajo). Así la misma lógica sirve para ambos.
function crearOperaciones(ejecutor) {
  return {
    // Une la cuenta con el empleado por email (el email vive en `empleados`).
    async buscarPorEmail(email) {
      const resultado = await ejecutor.query(
        `SELECT ${COLUMNAS}
           FROM cuentas c
           JOIN empleados e ON e.id = c.empleado_id
          WHERE lower(e.email) = lower($1)`,
        [email]
      );
      return aCuenta(resultado.rows[0]);
    },

    //rf-07
      async buscarAdminSemillaPorEmail(email) {
      const resultado = await ejecutor.query(
        `SELECT id, email, password_hash, role, estado
           FROM admin_semilla
          WHERE lower(email) = lower($1)`,
        [email]
      );

       const fila = resultado.rows[0];

      if (!fila) return null;

    return {
        empleadoId: fila.id,
        email: fila.email,
        passwordHash: fila.password_hash,
        role: fila.role,
        estado: fila.estado,
        versionToken: 0
      };
 },

    async buscarPorId(empleadoId) {
      const resultado = await ejecutor.query(
        `SELECT ${COLUMNAS}
           FROM cuentas c
           JOIN empleados e ON e.id = c.empleado_id
          WHERE c.empleado_id = $1`,
        [empleadoId]
      );
      return aCuenta(resultado.rows[0]);
    },

    //RF-38
    async incrementarVersionToken(empleadoId) {
    const resultado = await ejecutor.query(
    `UPDATE cuentas
        SET token_version = token_version + 1
      WHERE empleado_id = $1
      RETURNING token_version`,
    [empleadoId]
  );

  return resultado.rowCount === 1
    ? resultado.rows[0].token_version
    : null;
  },

    // Compare-and-set atómico en un solo UPDATE: cambia la contraseña y el estado e incrementa
    // token_version solo si la versión sigue siendo la esperada. Dos usos concurrentes del mismo
    // token no pueden ganar los dos: el segundo no encuentra fila y devuelve false.
    async actualizarPasswordConVersion({ empleadoId, versionEsperada, passwordHash, nuevoEstado }) {
      const resultado = await ejecutor.query(
        `UPDATE cuentas
            SET password_hash = $3,
                estado        = $4,
                token_version = token_version + 1
          WHERE empleado_id   = $1
            AND token_version = $2
            AND estado <> 'DESACTIVADA_PERMANENTE'`,
        [empleadoId, versionEsperada, passwordHash, nuevoEstado]
      );
      return resultado.rowCount === 1;
    },

    // RF-09/10/11: registra el id del evento. true = primera vez; false = duplicado.
    async registrarEvento(id) {
      const resultado = await ejecutor.query(
        `INSERT INTO eventos_procesados (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [id]
      );
      return resultado.rowCount === 1;
    },

    // RF-09: crea la cuenta INACTIVA, rol USER. El email vive en `empleados` (la cuenta se une a
    // él por empleado_id), por eso aquí solo hace falta el empleadoId.
    // Devuelve "CREADA", "YA_EXISTE" (PK repetida) o "EMPLEADO_INEXISTENTE" (viola la FK).
    async crearCuentaInactiva({ empleadoId, passwordHash }) {
      try {
        const resultado = await ejecutor.query(
          `INSERT INTO cuentas (empleado_id, password_hash, role, estado, token_version)
           VALUES ($1, $2, 'USER', 'INACTIVA', 0)
           ON CONFLICT (empleado_id) DO NOTHING`,
          [empleadoId, passwordHash]
        );
        return resultado.rowCount === 1 ? "CREADA" : "YA_EXISTE";
      } catch (error) {
        if (error.code === "23503") return "EMPLEADO_INEXISTENTE";
        throw error;
      }
    },

    // RF-10/11: compare-and-set del estado. Solo cambia si la cuenta sigue en `estadoEsperado`;
    // así un evento concurrente o repetido no puede pisar otra transición.
    async cambiarEstado({ empleadoId, estadoEsperado, nuevoEstado }) {
      const resultado = await ejecutor.query(
        `UPDATE cuentas SET estado = $3 WHERE empleado_id = $1 AND estado = $2`,
        [empleadoId, estadoEsperado, nuevoEstado]
      );
      return resultado.rowCount === 1;
    }
  };
}

function crearRepositorioCuentasPostgres(pool) {
  return {
    ...crearOperaciones(pool),

    // Ejecuta `fn(operaciones)` en una transacción: COMMIT si termina, ROLLBACK si lanza.
    async transaccion(fn) {
      const cliente = await pool.connect();
      try {
        await cliente.query("BEGIN");
        const resultado = await fn(crearOperaciones(cliente));
        await cliente.query("COMMIT");
        return resultado;
      } catch (error) {
        await cliente.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        cliente.release();
      }
    }
  };
}

async function inicializarAdminSemilla(pool, { id, email, passwordHash }) {
  await pool.query(
    `INSERT INTO admin_semilla (
       id, email, password_hash, role, estado
     )
     VALUES ($1, $2, $3, 'ADMIN', 'ACTIVA')
     ON CONFLICT (id)
     DO UPDATE SET
       email = EXCLUDED.email,
       password_hash = EXCLUDED.password_hash,
       role = 'ADMIN',
       estado = 'ACTIVA',
       actualizado_en = now()`,
    [id, email, passwordHash]
  );
}

module.exports = {
  crearRepositorioCuentasPostgres,
  inicializarAdminSemilla
};