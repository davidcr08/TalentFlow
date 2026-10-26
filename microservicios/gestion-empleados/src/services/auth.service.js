const { AppError } = require("../errores");
const { verificar, hashear } = require("../auth/password");

const ROLES = Object.freeze({ ADMIN: "ADMIN", USER: "USER" });
const { randomBytes } = require("node:crypto");
const ESTADOS_CUENTA = Object.freeze({
  ACTIVA: "ACTIVA",
  INACTIVA: "INACTIVA",
  SUSPENDIDA_TEMPORAL: "SUSPENDIDA_TEMPORAL",
  DESACTIVADA_PERMANENTE: "DESACTIVADA_PERMANENTE"
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
 * @param publicadorEventos   publicador de eventos opcional, para publicar eventos de login exitoso
 * 
 */
function crearServicioAuth(repositorioCuentas, emisorJwt, admin = null, publicadorEventos = null)  {
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

  // reto 5 rf03
  async function recuperarPassword(email) {
  if (typeof email !== "string" || !email.trim()) {
    throw new AppError("Debe enviar un email válido", 400, [
      { field: "email", message: "Es un campo obligatorio" }
    ]);
  }

  const emailNormalizado = email.trim();
  const cuenta = await buscarCuenta(emailNormalizado);

  // La respuesta no revela si la cuenta existe ni su estado.
  const respuesta = {
    message: "Si la cuenta puede recuperar su contraseña, recibirá instrucciones."
  };

  const estadosPermitidos = [
    ESTADOS_CUENTA.ACTIVA,
    ESTADOS_CUENTA.INACTIVA,
    ESTADOS_CUENTA.SUSPENDIDA_TEMPORAL
  ];

  // No recuperar cuentas inexistentes, desactivadas permanentemente
  // ni el ADMIN semilla, que no tiene una cuenta recuperable en la BD.
  if (
    !cuenta ||
    (admin && admin.email.toLowerCase() === emailNormalizado.toLowerCase()) ||
    !estadosPermitidos.includes(cuenta.estado)
  ) {
    return respuesta;
  }

  const tokenRecuperacion = randomBytes(32).toString("hex");
  const expiraEn = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  if (!publicadorEventos) {
    throw new AppError("Servicio de recuperación no disponible", 503);
  }

  try {
    await publicadorEventos.publicar("usuario.recuperacion", {
      email: emailNormalizado,
      tokenRecuperacion,
      expiraEn
    });
  } catch (error) {
    console.error("No se pudo publicar el evento de recuperación:", error.message);
    throw new AppError("Servicio de recuperación no disponible", 503);
  }

  return respuesta;
}

  return { login, recuperarPassword };
}

module.exports = { crearServicioAuth, ROLES, ESTADOS_CUENTA, MENSAJE_CREDENCIALES };
