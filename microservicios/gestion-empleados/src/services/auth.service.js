const { AppError } = require("../errores");
const { verificar, hashear } = require("../auth/password");

const ROLES = Object.freeze({ ADMIN: "ADMIN", USER: "USER" });
const ESTADOS_CUENTA = Object.freeze({
  ACTIVA: "ACTIVA",
  INACTIVA: "INACTIVA",
  SUSPENDIDA_TEMPORAL: "SUSPENDIDA_TEMPORAL"
});

// RF-01: mismo mensaje para credenciales incorrectas, email inexistente o cuenta no ACTIVA,
// para no revelar si una cuenta existe ni en qué estado está.
const MENSAJE_CREDENCIALES = "Credenciales inválidas";

// Hash de relleno: se verifica contra él cuando la cuenta no existe, para que el tiempo
// de respuesta no delate si el email está registrado.
const HASH_RELLENO = hashear("relleno-sin-uso");

/**
 * @param repositorioCuentas  { buscarPorEmail(email) -> { empleadoId, passwordHash, role, estado } | null }
 * @param emisorJwt           resultado de crearEmisorJwt()
 * @param admin               ADMIN semilla opcional: { id, email, passwordHash }
 */
function crearServicioAuth(repositorioCuentas, emisorJwt, admin = null) {
  async function buscarCuenta(email) {
    if (admin && admin.email.toLowerCase() === email.toLowerCase()) {
      return {
        identificador: admin.id,
        passwordHash: admin.passwordHash,
        role: ROLES.ADMIN,
        estado: ESTADOS_CUENTA.ACTIVA
      };
    }
    const cuenta = await repositorioCuentas.buscarPorEmail(email);
    if (!cuenta) return null;
    return {
      identificador: cuenta.empleadoId,
      passwordHash: cuenta.passwordHash,
      role: cuenta.role,
      estado: cuenta.estado
    };
  }

  async function login(email, password) {
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
      throw new AppError("Debe enviar email y password", 400, [
        ...(typeof email !== "string" || !email.trim()
          ? [{ field: "email", message: "Es un campo obligatorio" }]
          : []),
        ...(typeof password !== "string" || !password
          ? [{ field: "password", message: "Es un campo obligatorio" }]
          : [])
      ]);
    }

    const cuenta = await buscarCuenta(email.trim());
    const passwordCorrecta = verificar(password, cuenta ? cuenta.passwordHash : HASH_RELLENO);

    if (!cuenta || !passwordCorrecta || cuenta.estado !== ESTADOS_CUENTA.ACTIVA) {
      throw new AppError(MENSAJE_CREDENCIALES, 401);
    }

    return {
      accessToken: emisorJwt.emitir({ sub: cuenta.identificador, role: cuenta.role }),
      tokenType: "Bearer",
      expiresIn: emisorJwt.expiracionSegundos
    };
  }

  return { login };
}

module.exports = { crearServicioAuth, ROLES, ESTADOS_CUENTA, MENSAJE_CREDENCIALES };
