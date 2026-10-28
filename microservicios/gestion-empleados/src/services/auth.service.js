const { AppError } = require("../errores");
const { verificar, hashear } = require("../auth/password");
const { validarPassword } = require("../auth/politica-password");
const { TIPO_RESET_PASSWORD, EXPIRACION_RESET_SEGUNDOS } = require("../auth/jwt");

const ROLES = Object.freeze({ ADMIN: "ADMIN", USER: "USER" });
const ESTADOS_CUENTA = Object.freeze({
  ACTIVA: "ACTIVA",
  INACTIVA: "INACTIVA",
  SUSPENDIDA_TEMPORAL: "SUSPENDIDA_TEMPORAL",
  DESACTIVADA_PERMANENTE: "DESACTIVADA_PERMANENTE"
});

// RF-01: mismo mensaje para credenciales incorrectas, email inexistente o cuenta no ACTIVA,
// para no revelar si una cuenta existe ni en qué estado está.
const MENSAJE_CREDENCIALES = "Credenciales inválidas";

// RF-04: mismo mensaje para token expirado, alterado, usado, de otro tipo, o cuenta
// DESACTIVADA_PERMANENTE / inexistente, para no revelar el estado de la cuenta.
const MENSAJE_TOKEN_INVALIDO = "Token inválido o expirado";

// RF-05: motivo del evento cuenta.activada cuando el reset activa una cuenta INACTIVA.
const MOTIVO_ACTIVACION_INICIAL = "ACTIVACION_INICIAL";

// Hash de relleno: se verifica contra él cuando la cuenta no existe, para que el tiempo
// de respuesta no delate si el email está registrado.
const HASH_RELLENO = hashear("relleno-sin-uso");

/**
 * @param repositorioCuentas  { buscarPorEmail(email), buscarPorId(id) -> { empleadoId, email, passwordHash, role, estado, versionToken } | null,
 *                              actualizarPasswordConVersion({ empleadoId, versionEsperada, passwordHash, nuevoEstado }) -> boolean }
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
      estado: cuenta.estado,
      versionToken: cuenta.versionToken
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

  // RF-04: el token es un JWT firmado, type RESET_PASSWORD, con la versión vigente de la cuenta.
  const tokenRecuperacion = emisorJwt.emitirReset({
    sub: cuenta.identificador,
    version: cuenta.versionToken ?? 0
  });
  const expiraEn = new Date(Date.now() + EXPIRACION_RESET_SEGUNDOS * 1000).toISOString();

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

  // RF-04 / RF-05: POST /auth/reset-password
  async function resetPassword(token, newPassword) {
    const faltantes = [
      ...(typeof token !== "string" || !token.trim()
        ? [{ field: "token", message: "Es un campo obligatorio" }]
        : []),
      ...(typeof newPassword !== "string" || !newPassword
        ? [{ field: "newPassword", message: "Es un campo obligatorio" }]
        : [])
    ];
    if (faltantes.length > 0) {
      throw new AppError("Debe enviar token y newPassword", 400, faltantes);
    }

    // 1) Token: firma y vigencia (verificar devuelve null si está alterado o expirado) y tipo.
    const payload = emisorJwt.verificar(token.trim());
    if (
      !payload ||
      payload.type !== TIPO_RESET_PASSWORD ||
      typeof payload.sub !== "string" ||
      !Number.isInteger(payload.ver)
    ) {
      throw new AppError(MENSAJE_TOKEN_INVALIDO, 400);
    }

    // 2) Cuenta: debe existir, no estar DESACTIVADA_PERMANENTE y la versión del token debe ser
    // la vigente (si no, el token ya se usó o fue reemplazado por uno más nuevo).
    // El ADMIN semilla no tiene cuenta en la BD, así que cae aquí como inexistente.
    const cuenta = await repositorioCuentas.buscarPorId(payload.sub);
    if (
      !cuenta ||
      cuenta.estado === ESTADOS_CUENTA.DESACTIVADA_PERMANENTE ||
      cuenta.versionToken !== payload.ver
    ) {
      throw new AppError(MENSAJE_TOKEN_INVALIDO, 400);
    }

    // 3) Política de contraseña (RNF-05).
    const incumplimientos = validarPassword(newPassword);
    if (incumplimientos.length > 0) {
      throw new AppError(
        "La contraseña no cumple la política de seguridad",
        400,
        incumplimientos.map((message) => ({ field: "newPassword", message }))
      );
    }

    // RF-05: el token de activación inicial y el de recuperación son idénticos (ambos
    // RESET_PASSWORD); lo que los distingue es el estado de la cuenta. Solo INACTIVA pasa a
    // ACTIVA; ACTIVA y SUSPENDIDA_TEMPORAL conservan su estado.
    const activaCuenta = cuenta.estado === ESTADOS_CUENTA.INACTIVA;
    const nuevoEstado = activaCuenta ? ESTADOS_CUENTA.ACTIVA : cuenta.estado;

    // Contraseña, estado e incremento de versión en una sola operación atómica: si dos
    // peticiones usan el mismo token a la vez, solo una lo consigue.
    const actualizada = await repositorioCuentas.actualizarPasswordConVersion({
      empleadoId: cuenta.empleadoId,
      versionEsperada: payload.ver,
      passwordHash: hashear(newPassword),
      nuevoEstado
    });
    if (!actualizada) {
      throw new AppError(MENSAJE_TOKEN_INVALIDO, 400);
    }

    // Solo la activación inicial publica evento. Igual que en empleados.service, un fallo del
    // broker se registra pero no revierte el cambio ya guardado (RNF-06).
    if (activaCuenta && publicadorEventos) {
      try {
        await publicadorEventos.publicar("cuenta.activada", {
          empleadoId: cuenta.empleadoId,
          email: cuenta.email,
          motivo: MOTIVO_ACTIVACION_INICIAL
        });
      } catch (error) {
        console.error("No se pudo publicar el evento cuenta.activada:", error.message);
      }
    }

    return { message: "Contraseña actualizada correctamente" };
  }

  return { login, recuperarPassword, resetPassword };
}

module.exports = {
  crearServicioAuth,
  ROLES,
  ESTADOS_CUENTA,
  MENSAJE_CREDENCIALES,
  MENSAJE_TOKEN_INVALIDO,
  MOTIVO_ACTIVACION_INICIAL
};
