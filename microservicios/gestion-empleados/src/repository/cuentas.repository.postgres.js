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

function crearRepositorioCuentasPostgres(pool) {
  return {
    // Une la cuenta con el empleado por email (el email vive en `empleados`).
    async buscarPorEmail(email) {
      const resultado = await pool.query(
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
      const resultado = await pool.query(
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
      const resultado = await pool.query(
        `SELECT ${COLUMNAS}
           FROM cuentas c
           JOIN empleados e ON e.id = c.empleado_id
          WHERE c.empleado_id = $1`,
        [empleadoId]
      );
      return aCuenta(resultado.rows[0]);
    },

    // Compare-and-set atómico en un solo UPDATE: cambia la contraseña y el estado e incrementa
    // token_version solo si la versión sigue siendo la esperada. Dos usos concurrentes del mismo
    // token no pueden ganar los dos: el segundo no encuentra fila y devuelve false.
    async actualizarPasswordConVersion({ empleadoId, versionEsperada, passwordHash, nuevoEstado }) {
      const resultado = await pool.query(
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