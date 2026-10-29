const amqp = require("amqplib");
const { EventoInvalido } = require("../errores");
const { EVENTOS_CONSUMIDOS } = require("../services/cuentas-eventos.service");

const COLA = "empleados-service.q";

const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function logJson(nivel, mensaje, extra = {}) {
  console.log(JSON.stringify({ nivel, servicio: "empleados-service", mensaje, ...extra }));
}

// Política de confirmación (igual que los demás consumidores, ver docs/eventos.md):
//   procesado / duplicado / ignorado -> ack
//   mensaje inválido                 -> reject sin reencolar
//   fallo transitorio (BD, broker)   -> pausa y nack con reencolado
function crearCallback({ manejador, canal, pausaFalloMs = 2000, logger = logJson }) {
  return async (mensaje) => {
    if (mensaje === null) return; // el broker canceló el consumidor
    try {
      const resultado = await manejador(mensaje.content);
      canal.ack(mensaje);
      logger("INFO", "Mensaje procesado", { messageId: mensaje.properties?.messageId, resultado });
    } catch (error) {
      if (error instanceof EventoInvalido) {
        logger("ERROR", "Mensaje descartado por inválido", { motivo: error.message });
        canal.reject(mensaje, false);
        return;
      }
      logger("ERROR", "Fallo procesando el mensaje; se reencola", { motivo: error.message });
      await pausa(pausaFalloMs);
      canal.nack(mensaje, false, true);
    }
  };
}

function crearConsumidorEventos({
  manejador,
  url = process.env.BROKER_URL,
  exchange = process.env.BROKER_EXCHANGE || "talentflow.events",
  cola = COLA,
  eventos = Object.values(EVENTOS_CONSUMIDOS),
  reintentoMs = 5000,
  pausaFalloMs = 2000,
  logger = logJson
}) {
  let conexion;
  let detenido = false;
  let temporizador;

  function programarReintento() {
    if (detenido) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(conectar, reintentoMs);
  }

  async function conectar() {
    if (detenido) return;
    try {
      const nuevaConexion = await amqp.connect(url);
      try {
        const canal = await nuevaConexion.createChannel();
        await canal.assertExchange(exchange, "topic", { durable: true });
        await canal.assertQueue(cola, { durable: true });
        for (const clave of eventos) await canal.bindQueue(cola, exchange, clave);
        // Un mensaje a la vez: los eventos de una misma cuenta se aplican en el orden de llegada.
        await canal.prefetch(1);
        await canal.consume(cola, crearCallback({ manejador, canal, pausaFalloMs, logger }));

        conexion = nuevaConexion;
        // Si la conexión cae, se vuelve a abrir sola: sin esto el consumidor moriría en silencio.
        nuevaConexion.on("error", (error) =>
          logger("ERROR", "Error en la conexión del consumidor con RabbitMQ", { motivo: error.message })
        );
        nuevaConexion.on("close", () => {
          if (conexion === nuevaConexion) conexion = undefined;
          if (detenido) return; // cierre intencional (detener()): no es un error ni se reintenta
          logger("ERROR", "Conexión del consumidor con RabbitMQ cerrada; se reintentará", {});
          programarReintento();
        });
        logger("INFO", "Consumiendo eventos", { cola, eventos });
      } catch (error) {
        await nuevaConexion.close().catch(() => {});
        throw error;
      }
    } catch (error) {
      logger("ERROR", "No se pudo iniciar el consumidor de eventos; se reintentará", {
        motivo: error.message
      });
      programarReintento();
    }
  }

  return {
    // No lanza ni bloquea el arranque: si el broker no está, reintenta en segundo plano.
    async iniciar() {
      if (!url) {
        logger("ERROR", "BROKER_URL no configurada: no se consumen eventos", {});
        return;
      }
      detenido = false;
      await conectar();
    },
    async detener() {
      detenido = true;
      clearTimeout(temporizador);
      const actual = conexion;
      conexion = undefined;
      if (actual) await actual.close().catch(() => {});
    }
  };
}

module.exports = { crearConsumidorEventos, crearCallback, COLA };
