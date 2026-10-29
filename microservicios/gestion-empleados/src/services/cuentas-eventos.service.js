const { randomBytes } = require("node:crypto");
const { EventoInvalido } = require("../errores");
const { hashear } = require("../auth/password");
const { ESTADOS_CUENTA } = require("./auth.service");

// Reacciones del servicio de autenticación a eventos de otros servicios.
//   RF-09  empleado.creado        -> cuenta INACTIVA + usuario.creado (token de activación)
//   RF-10  vacaciones.iniciadas   -> ACTIVA -> SUSPENDIDA_TEMPORAL + cuenta.desactivada
//   RF-11  vacaciones.finalizadas -> SUSPENDIDA_TEMPORAL -> ACTIVA + cuenta.activada
// El "estado ACTIVO" del catálogo es el del empleado no retirado; aquí solo cuenta el estado
// de la propia cuenta, nunca se consulta el del empleado.

const EVENTOS_CONSUMIDOS = Object.freeze({
  EMPLEADO_CREADO: "empleado.creado",
  VACACIONES_INICIADAS: "vacaciones.iniciadas",
  VACACIONES_FINALIZADAS: "vacaciones.finalizadas"
});

const MOTIVO_VACACIONES = "VACACIONES";
const MOTIVO_FIN_VACACIONES = "FIN_VACACIONES";

function logJson(nivel, mensaje, extra = {}) {
  console.log(JSON.stringify({ nivel, servicio: "empleados-service", mensaje, ...extra }));
}

function parsearEnvelope(cuerpo) {
  let evento;
  try {
    evento = JSON.parse(Buffer.isBuffer(cuerpo) ? cuerpo.toString("utf8") : cuerpo);
  } catch (error) {
    throw new EventoInvalido(`el mensaje no es JSON válido: ${error.message}`);
  }
  if (evento === null || typeof evento !== "object" || Array.isArray(evento)) {
    throw new EventoInvalido("el mensaje no es un objeto JSON");
  }
  if (typeof evento.id !== "string" || !evento.id.trim()) {
    throw new EventoInvalido("el campo id del envelope debe ser un texto no vacío");
  }
  if (typeof evento.type !== "string" || !evento.type.trim()) {
    throw new EventoInvalido("el campo type del envelope debe ser un texto no vacío");
  }
  if (evento.data === null || typeof evento.data !== "object" || Array.isArray(evento.data)) {
    throw new EventoInvalido("el campo data debe ser un objeto");
  }
  return evento;
}

function texto(data, campo) {
  const valor = data[campo];
  if (typeof valor !== "string" || !valor.trim()) {
    throw new EventoInvalido(`data.${campo} es obligatorio`);
  }
  return valor.trim();
}

// Segundos enteros, sin fracciones (2026-03-01T14:32:05Z), como el resto de fechas de eventos.
const iso = (segundos) => new Date(segundos * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * @param repositorioCuentas  repositorio de cuentas con transaccion(fn), registrarEvento,
 *                            crearCuentaInactiva y cambiarEstado (ver los repositorios).
 * @param emisorJwt           resultado de crearEmisorJwt()
 * @param publicadorEventos   { publicar(tipo, data) }
 *
 * Fiabilidad: el id del evento, el cambio de la cuenta y la publicación del evento de salida
 * ocurren dentro de UNA transacción. Si el broker rechaza la publicación se hace ROLLBACK (el id
 * también se deshace) y el mensaje se reintenta, así el token de activación nunca se pierde en
 * silencio. Coste: si el COMMIT falla justo después de publicar, el reintento publica otra vez
 * (entrega "al menos una vez"; los consumidores deduplican por id).
 */
function crearManejadorEventosCuentas({
  repositorioCuentas,
  emisorJwt,
  publicadorEventos,
  logger = logJson
}) {
  if (!publicadorEventos) {
    throw new Error("El manejador de eventos de cuentas requiere un publicador de eventos");
  }

  // RF-09
  async function crearCuentaDesdeEmpleado(tx, evento) 
  {
    const empleadoId = texto(evento.data, "empleadoId");
    const email = texto(evento.data, "email");

    const ignorar = (motivo) => {
      logger("INFO", "empleado.creado ignorado: ya existe una cuenta", {
        type: evento.type,
        id: evento.id,
        empleadoId,
        motivo
      });
      return "ignorado";
    };

    if (await tx.buscarPorId(empleadoId)) return ignorar("empleadoId");
    if (await tx.buscarPorEmail(email)) return ignorar("email");
    if (
      typeof tx.buscarAdminSemillaPorEmail === "function" &&
      (await tx.buscarAdminSemillaPorEmail(email))
    ) {
      return ignorar("email (administrador)");
    }

    // "Sin contraseña válida": hash scrypt de 256 bits aleatorios que nadie conoce ni se guarda.
    // Nadie puede iniciar sesión con ella; la cuenta se activa solo con el token de activación.
    const resultado = await tx.crearCuentaInactiva({
      empleadoId,
      email,
      passwordHash: hashear(randomBytes(32).toString("hex"))
    });
    if (resultado === "YA_EXISTE") return ignorar("empleadoId (concurrente)");
    if (resultado === "EMPLEADO_INEXISTENTE") {
      throw new EventoInvalido(`el empleado ${empleadoId} no existe; no se puede crear su cuenta`);
    }

    //rf-38
    const versionToken = await tx.incrementarVersionToken(empleadoId);

  if (versionToken === null) {
    throw new Error(
      `No se pudo incrementar la versión del token para ${empleadoId}`
    );
}

  const tokenActivacion = emisorJwt.emitirReset({
  sub: empleadoId,
  version: Number(versionToken),
  tipoUso: "ACTIVACION"
  });
    const { exp } = emisorJwt.verificar(tokenActivacion);

    await publicadorEventos.publicar("usuario.creado", {
      empleadoId,
      email,
      tokenActivacion,
      expiraEn: iso(exp)
    });
    return "procesado";
  }

  // RF-10 y RF-11: transición de estado condicionada al estado actual de la cuenta.
  function transicion({ desde, hacia, eventoSalida, datosExtra }) {
    return async (tx, evento) => {
      const empleadoId = texto(evento.data, "empleadoId");
      const ignorar = (motivo, estado) => {
        logger("INFO", `${evento.type} ignorado: ${motivo}`, {
          type: evento.type,
          id: evento.id,
          empleadoId,
          ...(estado ? { estado } : {})
        });
        return "ignorado";
      };

      const cuenta = await tx.buscarPorId(empleadoId);
      if (!cuenta) return ignorar("no existe una cuenta para el empleado");
      if (cuenta.estado !== desde) return ignorar(`la cuenta no está ${desde}`, cuenta.estado);

      const cambiada = await tx.cambiarEstado({
        empleadoId,
        estadoEsperado: desde,
        nuevoEstado: hacia
      });
      if (!cambiada) return ignorar("la cuenta cambió de estado mientras se procesaba");

      await publicadorEventos.publicar(eventoSalida, {
        empleadoId,
        email: cuenta.email,
        ...datosExtra
      });
      return "procesado";
    };
  }

  const manejadores = {
    [EVENTOS_CONSUMIDOS.EMPLEADO_CREADO]: crearCuentaDesdeEmpleado,
    [EVENTOS_CONSUMIDOS.VACACIONES_INICIADAS]: transicion({
      desde: ESTADOS_CUENTA.ACTIVA,
      hacia: ESTADOS_CUENTA.SUSPENDIDA_TEMPORAL,
      eventoSalida: "cuenta.desactivada",
      datosExtra: { motivo: MOTIVO_VACACIONES, permanente: false }
    }),
    [EVENTOS_CONSUMIDOS.VACACIONES_FINALIZADAS]: transicion({
      desde: ESTADOS_CUENTA.SUSPENDIDA_TEMPORAL,
      hacia: ESTADOS_CUENTA.ACTIVA,
      eventoSalida: "cuenta.activada",
      datosExtra: { motivo: MOTIVO_FIN_VACACIONES }
    })
  };

  // Devuelve "procesado" | "duplicado" | "ignorado". Lanza EventoInvalido si el mensaje está
  // malformado (el consumidor lo rechaza sin reencolar) y cualquier otro error si falla algo
  // transitorio (BD o broker caídos: el consumidor reencola).
  async function manejar(cuerpo) {
    const evento = parsearEnvelope(cuerpo);
    const manejador = manejadores[evento.type];
    if (!manejador) return "ignorado";

    return repositorioCuentas.transaccion(async (tx) => {
      // La validación de data va dentro del manejador, pero DESPUÉS de registrar el id: si lanza
      // EventoInvalido, el ROLLBACK deshace también el registro y el mensaje inválido no consume el id.
      if (!(await tx.registrarEvento(evento.id))) {
        logger("INFO", "Evento duplicado descartado", { type: evento.type, id: evento.id });
        return "duplicado";
      }
      return manejador(tx, evento);
    });
  }

  return { manejar };
}

module.exports = {
  crearManejadorEventosCuentas,
  parsearEnvelope,
  EVENTOS_CONSUMIDOS,
  MOTIVO_VACACIONES,
  MOTIVO_FIN_VACACIONES
};
