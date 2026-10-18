const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// amqplib falso: no requiere RabbitMQ. Se inyecta ANTES de cargar el publicador.
function cargarPublicador(amqpFalso) {
  const cargaOriginal = Module._load;
  Module._load = function (peticion, ...resto) {
    if (peticion === "amqplib") return amqpFalso;
    return cargaOriginal.call(this, peticion, ...resto);
  };
  const ruta = require.resolve("../src/events/publicador-eventos");
  delete require.cache[ruta];
  try {
    return require(ruta).crearPublicadorEventos;
  } finally {
    Module._load = cargaOriginal;
  }
}

function canalFalso(publicados) {
  const oyentes = {};
  return {
    assertExchange: async () => {},
    on: (evento, fn) => { oyentes[evento] = fn; },
    cerrar: () => oyentes.close?.(),
    publish: (exchange, clave, buffer, opciones, cb) => {
      publicados.push({ exchange, clave, evento: JSON.parse(buffer.toString()), opciones });
      cb(null);
    }
  };
}

function conexionFalsa(canal) {
  return { on() {}, close: async () => {}, createConfirmChannel: async () => canal };
}

describe("Publicador de eventos (RNF-07 y RNF-08)", () => {
  it("publica el envelope completo como mensaje persistente (RNF-07)", async () => {
    const publicados = [];
    const amqp = { connect: async () => conexionFalsa(canalFalso(publicados)) };
    const { publicar } = cargarPublicador(amqp)({ url: "amqp://x", exchange: "talentflow.events" });

    const evento = await publicar("empleado.creado", { empleadoId: "E001" });

    assert.equal(publicados.length, 1);
    assert.equal(publicados[0].clave, "empleado.creado");
    assert.equal(publicados[0].opciones.persistent, true);
    assert.equal(publicados[0].opciones.messageId, evento.id);
    assert.equal(publicados[0].evento.data.empleadoId, "E001");
    // RNF-15/16: envelope completo, id UUID y occurredAt en ISO 8601 UTC sin fracciones
    const e = publicados[0].evento;
    assert.deepEqual(Object.keys(e), ["id", "type", "version", "occurredAt", "producer", "data"]);
    assert.match(e.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(e.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(e.version, 1);
  });

  it("si el broker no responde al primer intento, reconecta y reintenta (RNF-08)", async () => {
    const publicados = [];
    let intentos = 0;
    const amqp = {
      connect: async () => {
        intentos += 1;
        if (intentos === 1) throw new Error("ECONNREFUSED");
        return conexionFalsa(canalFalso(publicados));
      }
    };
    const { publicar } = cargarPublicador(amqp)({ url: "amqp://x" });

    await publicar("empleado.retirado", { empleadoId: "E001" });

    assert.equal(intentos, 2);
    assert.equal(publicados.length, 1);
  });

  it("si el broker sigue caído, el error sube al llamador (que lo registra sin revertir la BD)", async () => {
    const amqp = { connect: async () => { throw new Error("ECONNREFUSED"); } };
    const { publicar } = cargarPublicador(amqp)({ url: "amqp://x" });

    await assert.rejects(() => publicar("empleado.creado", {}), /ECONNREFUSED/);
  });

  it("si el canal se cierra, la siguiente publicación abre uno nuevo (RNF-08)", async () => {
    const publicados = [];
    const canales = [];
    const amqp = {
      connect: async () => {
        const canal = canalFalso(publicados);
        canales.push(canal);
        return conexionFalsa(canal);
      }
    };
    const { publicar } = cargarPublicador(amqp)({ url: "amqp://x" });

    await publicar("empleado.creado", { empleadoId: "E001" });
    canales[0].cerrar();
    await publicar("empleado.creado", { empleadoId: "E002" });

    assert.equal(canales.length, 2);
    assert.equal(publicados.length, 2);
  });
});