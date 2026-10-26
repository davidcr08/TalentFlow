function crearRepositorioCuentasEnMemoria() {
  const cuentas = new Map(); // email(lower) -> cuenta

  return {
    agregar({ email, empleadoId, passwordHash, role = "USER", estado = "ACTIVA" }) {
      cuentas.set(email.toLowerCase(), { empleadoId, passwordHash, role, estado });
    },
    async buscarPorEmail(email) {
      return cuentas.get(email.toLowerCase()) ?? null;
    }
  };
}

module.exports = { crearRepositorioCuentasEnMemoria };
