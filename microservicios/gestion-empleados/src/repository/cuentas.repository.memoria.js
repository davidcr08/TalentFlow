function crearRepositorioCuentasEnMemoria() {
  const cuentas = new Map(); // email(lower) -> cuenta

  const copia = (c) => ({ ...c });

  return {
    agregar({ email, empleadoId, passwordHash, role = "USER", estado = "ACTIVA", versionToken = 0 }) {
      cuentas.set(email.toLowerCase(), { empleadoId, email, passwordHash, role, estado, versionToken });
    },
    async buscarPorEmail(email) {
      const cuenta = cuentas.get(email.toLowerCase());
      return cuenta ? copia(cuenta) : null;
    },
    async buscarPorId(empleadoId) {
      for (const cuenta of cuentas.values()) {
        if (cuenta.empleadoId === empleadoId) return copia(cuenta);
      }
      return null;
    },
    // Compare-and-set: solo actualiza si la versión de tokens sigue siendo la esperada (el token
    // no se ha usado ya) y la cuenta no está DESACTIVADA_PERMANENTE. Devuelve true si actualizó.
    async actualizarPasswordConVersion({ empleadoId, versionEsperada, passwordHash, nuevoEstado }) {
      for (const cuenta of cuentas.values()) {
        if (cuenta.empleadoId !== empleadoId) continue;
        if (cuenta.versionToken !== versionEsperada || cuenta.estado === "DESACTIVADA_PERMANENTE") {
          return false;
        }
        cuenta.passwordHash = passwordHash;
        cuenta.estado = nuevoEstado;
        cuenta.versionToken += 1;
        return true;
      }
      return false;
    }
  };
}

module.exports = { crearRepositorioCuentasEnMemoria };
