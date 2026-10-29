// Extremo a extremo con RabbitMQ y PostgreSQL reales. Se omite si faltan las variables:
//   TEST_DB_URL=postgres://user:pass@127.0.0.1:5432/tf_test \
//   TEST_BROKER_URL=amqp://user:pass@127.0.0.1:5672/ npm test
// ATENCIÓN: vacía las tablas empleados, cuentas y eventos_procesados, y usa colas "test-*".
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const amqp = require("amqplib");
const { Pool } = require("pg");

const { crearManejadorEventosCuentas } = require("../src/services/cuentas-eventos.service");
const { crearConsumidorEventos } = require("../src/events/consumidor-eventos");
const { crearPublicadorEventos } = require("../src/events/publicador-eventos");
const { crearRepositorioCuentasPostgres } = require("../src/repository/cuentas.repository.postgres");
const { crearEmisorJwt } = require("../src/auth/jwt");

const URL_BD = process.env.TEST_DB_URL;
const URL_BROKER = process.env.TEST_BROKER_URL;
const SECRETO = "secreto-de-pruebas-con-mas-de-32-caracteres";
const EXCHANGE = `test-exchange-${randomUUID().slice(0, 8)}`;
const COLA = `test-empleados-${randomUUID().slice(0, 8)}`;
const COLA_SONDA = `test-sonda-${randomUUID().slice(0, 8)}`;

const esperar = async (condicion, ms = 8000) => {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const valor = await condicion();
    if (valor) return valor;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("tiempo de espera agotado");
};

describe(
  "Consumidor de eventos contra RabbitMQ y PostgreSQL reales",
  { skip: (!URL_BD || !URL_BROKER) && "sin TEST_DB_URL / TEST_BROKER_URL" },
  () => {
    let pool;
    let conexion;
    let canal;
    let consumidor;
    let publicadorSalida;
    const recibidos = [];
    const logs = [];

    const publicar = (type, data, id = randomUUID()) =>
      canal.publish(
        EXCHANGE,
        type,
        Buffer.from(JSON.stringify({ id, type, version: 1, occurredAt: "2026-03-01T14:32:05Z", producer: "test", data })),
        { persistent: true, contentType: "application/json", messageId: id }
      );

    const estado = async (id) =>
      (await pool.query("SELECT estado FROM cuentas WHERE empleado_id = $1", [id])).rows[0]?.estado;

    before(async () => {
      pool = new Pool({ connectionString: URL_BD });
      await pool.query(fs.readFileSync(path.join(__dirname, "..", "init.sql"), "utf8"));
      await pool.query("TRUNCATE eventos_procesados, cuentas, empleados CASCADE");
      await pool.query(
        `INSERT INTO empleados (id, nombre, apellido, email, numero_empleado, cargo, area, departamento_id, fecha_ingreso)
         VALUES ('E1', 'Ana', 'P', 'ana@x.com', 'E1', 'Dev', 'TI', 'D1', '2026-01-01')`
      );

      conexion = await amqp.connect(URL_BROKER);
      canal = await conexion.createChannel();
      await canal.assertExchange(EXCHANGE, "topic", { durable: true }); // igual que el publicador y el consumidor
      await canal.assertQueue(COLA_SONDA, { exclusive: true });
      for (const clave of ["usuario.creado", "cuenta.desactivada", "cuenta.activada"]) {
        await canal.bindQueue(COLA_SONDA, EXCHANGE, clave);
      }
      await canal.consume(COLA_SONDA, (m) => {
        recibidos.push(JSON.parse(m.content.toString()));
        canal.ack(m);
      });

      const emisor = crearEmisorJwt({ secreto: SECRETO });
      publicadorSalida = crearPublicadorEventos({ url: URL_BROKER, exchange: EXCHANGE });
      const manejador = crearManejadorEventosCuentas({
        repositorioCuentas: crearRepositorioCuentasPostgres(pool),
        emisorJwt: emisor,
        publicadorEventos: publicadorSalida,
        logger: (nivel, mensaje, extra) => logs.push({ nivel, mensaje, ...extra })
      });
      consumidor = crearConsumidorEventos({
        manejador: manejador.manejar,
        url: URL_BROKER,
        exchange: EXCHANGE,
        cola: COLA,
        logger: (nivel, mensaje, extra) => logs.push({ nivel, mensaje, ...extra })
      });
      await consumidor.iniciar();
      // Si el consumidor no pudo conectarse, que falle aquí y diga por qué (no por timeouts).
      assert.ok(
        logs.some((l) => l.mensaje === "Consumiendo eventos"),
        `el consumidor no arrancó: ${JSON.stringify(logs)}`
      );
    });

    after(async () => {
      await consumidor?.detener();
      await publicadorSalida?.cerrar();
      await canal?.deleteQueue(COLA).catch(() => {});
      await canal?.deleteExchange(EXCHANGE).catch(() => {});
      await conexion?.close().catch(() => {});
      await pool?.end();
    });

    const salida = (tipo) => recibidos.filter((e) => e.type === tipo);

    it("empleado.creado -> cuenta INACTIVA en BD y usuario.creado en el broker (con envelope completo)", async () => {
      publicar("empleado.creado", { empleadoId: "E1", email: "ana@x.com" });
      const evento = await esperar(() => salida("usuario.creado")[0]);
      assert.equal(await estado("E1"), "INACTIVA");
      assert.equal(evento.producer, "empleados-service");
      assert.equal(evento.data.empleadoId, "E1");
      assert.equal(evento.data.email, "ana@x.com");
      assert.ok(evento.data.tokenActivacion);
      assert.ok(evento.data.expiraEn);
    });

    it("un mensaje inválido se descarta sin bloquear la cola y el siguiente se procesa", async () => {
      canal.publish(EXCHANGE, "empleado.creado", Buffer.from("{no es json"), { persistent: true });
      publicar("empleado.creado", { email: "sin-id@x.com" }); // falta empleadoId
      await pool.query("UPDATE cuentas SET estado = 'ACTIVA' WHERE empleado_id = 'E1'");
      publicar("vacaciones.iniciadas", { empleadoId: "E1", email: "ana@x.com" });
      const evento = await esperar(() => salida("cuenta.desactivada")[0]);
      assert.equal(evento.data.motivo, "VACACIONES");
      assert.strictEqual(evento.data.permanente, false);
      assert.equal(await estado("E1"), "SUSPENDIDA_TEMPORAL");
      const { messageCount } = await canal.checkQueue(COLA);
      assert.equal(messageCount, 0, "los mensajes inválidos no deben quedar reencolados");
      assert.equal(logs.filter((l) => l.mensaje === "Mensaje descartado por inválido").length, 2);
    });

    it("vacaciones.finalizadas -> ACTIVA y cuenta.activada con FIN_VACACIONES", async () => {
      publicar("vacaciones.finalizadas", { empleadoId: "E1", email: "ana@x.com" });
      const evento = await esperar(() => salida("cuenta.activada")[0]);
      assert.equal(evento.data.motivo, "FIN_VACACIONES");
      assert.equal(await estado("E1"), "ACTIVA");
    });

    it("el mismo mensaje entregado dos veces (mismo id) tiene efecto una sola vez", async () => {
      const antes = salida("cuenta.desactivada").length;
      const id = randomUUID();
      publicar("vacaciones.iniciadas", { empleadoId: "E1", email: "ana@x.com" }, id);
      publicar("vacaciones.iniciadas", { empleadoId: "E1", email: "ana@x.com" }, id);
      await esperar(() => salida("cuenta.desactivada").length > antes);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(salida("cuenta.desactivada").length, antes + 1);
    });

    it("eventos que no son de su interés (otra routing key) ni siquiera llegan a la cola", async () => {
      publicar("empleado.retirado", { empleadoId: "E1", email: "ana@x.com" });
      await new Promise((r) => setTimeout(r, 300));
      const { messageCount } = await canal.checkQueue(COLA);
      assert.equal(messageCount, 0);
    });
  }
);
