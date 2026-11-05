const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// RF-40: el auth-service declara su PROPIA cola durable y la enlaza a los cuatro eventos que consume.
// amqplib falso: no requiere RabbitMQ.
function cargarConsumidor(amqpFalso) {
  const cargaOriginal = Module._load;
  Module._load = function (peticion, ...resto) {
    if (peticion === "amqplib") return amqpFalso;
    return cargaOriginal.call(this, peticion, ...resto);
  };
  const ruta = require.resolve("../src/events/consumidor-eventos");
  delete require.cache[ruta];
  try {
    return require(ruta);
  } finally {
    Module._load = cargaOriginal;
  }
}

describe("Cola del auth-service (RF-40)", () => {
  it("declara auth-service.q como cola durable, con exchange topic durable", async () => {
    const llamadas = { exchanges: [], colas: [], bindings: [], consumidas: [] };
    const canal = {
      assertExchange: async (nombre, tipo, opciones) => llamadas.exchanges.push({ nombre, tipo, opciones }),
      assertQueue: async (nombre, opciones) => llamadas.colas.push({ nombre, opciones }),
      bindQueue: async (cola, exchange, clave) => llamadas.bindings.push({ cola, exchange, clave }),
      prefetch: async () => {},
      consume: async (cola) => llamadas.consumidas.push(cola)
    };
    const amqp = { connect: async () => ({ on() {}, close: async () => {}, createChannel: async () => canal }) };

    const { crearConsumidorEventos, COLA } = cargarConsumidor(amqp);
    assert.equal(COLA, "auth-service.q");

    await crearConsumidorEventos({ manejador: async () => "ok", url: "amqp://x", logger: () => {} }).iniciar();

    assert.deepEqual(llamadas.exchanges, [
      { nombre: "talentflow.events", tipo: "topic", opciones: { durable: true } }
    ]);
    assert.deepEqual(llamadas.colas, [{ nombre: "auth-service.q", opciones: { durable: true } }]);
    assert.deepEqual(
      llamadas.bindings.map((b) => b.clave).sort(),
      ["empleado.creado", "empleado.retirado", "vacaciones.finalizadas", "vacaciones.iniciadas"]
    );
    assert.ok(llamadas.bindings.every((b) => b.cola === "auth-service.q" && b.exchange === "talentflow.events"));
    assert.deepEqual(llamadas.consumidas, ["auth-service.q"]);
  });

  it("la cola no se comparte con ningún otro servicio", () => {
    const { COLA } = cargarConsumidor({ connect: async () => {} });
    for (const ajena of ["perfiles-service.q", "notificaciones-service.q", "vacaciones-service.q", "empleados-service.q"]) {
      assert.notEqual(COLA, ajena);
    }
  });
});
