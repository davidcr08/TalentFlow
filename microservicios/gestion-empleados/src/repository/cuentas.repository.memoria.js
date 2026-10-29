function crearRepositorioCuentasEnMemoria() {
  let cuentas = new Map(); // email(lower) -> cuenta
  let eventosProcesados = new Set();
  const admins = new Map(); // email(lower) -> { id, email }

  const copia = (c) => ({ ...c });

  const repo = {
    agregar({ email, empleadoId, passwordHash, role = "USER", estado = "ACTIVA", versionToken = 0 }) {
      cuentas.set(email.toLowerCase(), { empleadoId, email, passwordHash, role, estado, versionToken });
    },
    // Solo para pruebas: simula el ADMIN semilla persistido (tabla admin_semilla).
    agregarAdminSemilla({ id, email }) {
      admins.set(email.toLowerCase(), { id, email });
    },
    async buscarAdminSemillaPorEmail(email) {
      const admin = admins.get(email.toLowerCase());
      if (!admin) return null;
      return {
        empleadoId: admin.id,
        email: admin.email,
        passwordHash: "scrypt$sin$uso",
        role: "ADMIN",
        estado: "ACTIVA",
        versionToken: 0
      };
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
    },

    // --- RF-09/10/11 ---
    async registrarEvento(id) {
      if (eventosProcesados.has(id)) return false;
      eventosProcesados.add(id);
      return true;
    },
    async crearCuentaInactiva({ empleadoId, email, passwordHash }) {
      if ((await repo.buscarPorId(empleadoId)) || cuentas.has(email.toLowerCase())) return "YA_EXISTE";
      repo.agregar({ email, empleadoId, passwordHash, role: "USER", estado: "INACTIVA", versionToken: 0 });
      return "CREADA";
    },
    async cambiarEstado({ empleadoId, estadoEsperado, nuevoEstado }) {
      for (const cuenta of cuentas.values()) {
        if (cuenta.empleadoId !== empleadoId) continue;
        if (cuenta.estado !== estadoEsperado) return false;
        cuenta.estado = nuevoEstado;
        return true;
      }
      return false;
    },
    // Simula la transacción: si `fn` lanza, se restaura el estado previo (cuentas e ids de evento).
    async transaccion(fn) {
      const cuentasPrevias = new Map([...cuentas].map(([k, v]) => [k, copia(v)]));
      const eventosPrevios = new Set(eventosProcesados);
      try {
        return await fn(repo);
      } catch (error) {
        cuentas = cuentasPrevias;
        eventosProcesados = eventosPrevios;
        throw error;
      }
    },
    // Solo para pruebas.
    eventoRegistrado(id) {
      return eventosProcesados.has(id);
    }
  };
  return repo;
}

module.exports = { crearRepositorioCuentasEnMemoria };
