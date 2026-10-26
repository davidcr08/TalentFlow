function crearRepositorioCuentasPostgres(pool) {
  return {
    // Une la cuenta con el empleado por email (el email vive en `empleados`).
    async buscarPorEmail(email) {
      const resultado = await pool.query(
        `SELECT c.empleado_id, c.password_hash, c.role, c.estado
           FROM cuentas c
           JOIN empleados e ON e.id = c.empleado_id
          WHERE lower(e.email) = lower($1)`,
        [email]
      );
      const fila = resultado.rows[0];
      if (!fila) return null;
      return {
        empleadoId: fila.empleado_id,
        passwordHash: fila.password_hash,
        role: fila.role,
        estado: fila.estado
      };
    }
  };
}

module.exports = { crearRepositorioCuentasPostgres };
