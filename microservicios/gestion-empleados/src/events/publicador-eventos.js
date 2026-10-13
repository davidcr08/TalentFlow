
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

  async function publicar(tipo, data) {
    const canalActual = await conectar();
    const id = randomUUID();

    const evento = {
      id,
      type: tipo,
      version: 1,
      occurredAt: new Date().toISOString(),
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

    return evento;
  }

  return { publicar };
}

module.exports = { crearPublicadorEventos };
