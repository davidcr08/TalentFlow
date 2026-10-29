
const amqp = require("amqplib");
const { randomUUID } = require("node:crypto");

function crearPublicadorEventos({
  url = process.env.BROKER_URL,
  exchange = process.env.BROKER_EXCHANGE || "talentflow.events"
} = {}) {
  let conexion;
  let canal;
  let conexionEnCurso;

  async function conectar() {
    if (canal) return canal;
    if (conexionEnCurso) return conexionEnCurso;

    conexionEnCurso = (async () => {
      if (!url) {
        throw new Error("No está configurada la variable BROKER_URL");
      }

      const nuevaConexion = await amqp.connect(url);

      try {
        const nuevoCanal = await nuevaConexion.createConfirmChannel();

        await nuevoCanal.assertExchange(exchange, "topic", {
          durable: true
        });

        conexion = nuevaConexion;
        canal = nuevoCanal;

        // RNF-08: si el canal se cierra o falla (sin que caiga la conexión), se descarta
        // para que la siguiente publicación reabra uno en vez de usar uno muerto.
        const descartarCanal = () => {
          if (canal === nuevoCanal) canal = undefined;
        };
        nuevoCanal.on("close", descartarCanal);
        nuevoCanal.on("error", (error) => {
          console.error("Error en el canal de RabbitMQ:", error.message);
          descartarCanal();
        });

        nuevaConexion.on("error", (error) => {
          console.error("Error en la conexión con RabbitMQ:", error.message);
        });

        nuevaConexion.on("close", () => {
          conexion = undefined;
          canal = undefined;
        });

        return canal;
      } catch (error) {
        await nuevaConexion.close().catch(() => {});
        throw error;
      }
    })();

    try {
      return await conexionEnCurso;
    } finally {
      conexionEnCurso = undefined;
    }
  }

  // RNF-08: la conexión se reabre sola. Si el intento falla (broker caído o canal
  // muerto), se reconecta y se reintenta UNA vez; si vuelve a fallar, el error sube al
  // llamador, que lo registra sin revertir la BD (RNF-06).
  async function publicar(tipo, data) {
    try {
      return await publicarUnaVez(tipo, data);
    } catch (error) {
      canal = undefined;
      return publicarUnaVez(tipo, data);
    }
  }

  async function publicarUnaVez(tipo, data) {
    const canalActual = await conectar();
    const id = randomUUID();

    const evento = {
      id,
      type: tipo,
      version: 1,
      // ISO 8601 UTC sin fracciones (2026-03-01T14:32:05Z), igual que el catálogo y los demás servicios.
      occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      producer: "empleados-service",
      data
    };

    await new Promise((resolve, reject) => {
      canalActual.publish(
        exchange,
        tipo,
        Buffer.from(JSON.stringify(evento)),
        {
          persistent: true,
          contentType: "application/json",
          messageId: id
        },
        (error) => {
          if (error) reject(error);
          else resolve();
        }
      );
    });

    // RNF-21: log estructurado por evento publicado (id y type sirven de evidencia de la dedupe).
    console.log(JSON.stringify({
      nivel: "INFO",
      servicio: "empleados-service",
      mensaje: "Evento publicado",
      type: evento.type,
      id: evento.id
    }));

    return evento;
  }

  // Cierra canal y conexión (apagado ordenado y pruebas). Una publicación posterior reconecta.
  async function cerrar() {
    const canalActual = canal;
    const conexionActual = conexion;
    canal = undefined;
    conexion = undefined;
    await canalActual?.close().catch(() => {});
    await conexionActual?.close().catch(() => {});
  }

  return { publicar, cerrar };
}

module.exports = { crearPublicadorEventos };