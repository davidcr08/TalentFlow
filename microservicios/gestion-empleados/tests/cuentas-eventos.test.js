const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { crearServicioAuth } = require("../src/services/auth.service");
const { crearManejadorEventosCuentas } = require("../src/services/cuentas-eventos.service");
const { crearCallback } = require("../src/events/consumidor-eventos");
const { crearRepositorioCuentasEnMemoria } = require("../src/repository/cuentas.repository.memoria");
const { crearEmisorJwt, EXPIRACION_ACTIVACION_SEGUNDOS } = require("../src/auth/jwt");
const { hashear, verificar } = require("../src/auth/password");
const { EventoInvalido } = require("../src/errores");

const SECRETO = "secreto-de-pruebas-con-mas-de-32-caracteres";
const AHORA = 1_700_000_000_000;

describe("Consumo de eventos de cuentas (RF-09 / RF-10 / RF-11)", () => {
  let cuentas;
  let publicados;
  let fallaPublicacion;
  let logs;
  let manejador;
  let servicioAuth;
  let contador;
  const emisor = crearEmisorJwt({ secreto: SECRETO, ahora: () => AHORA });

  const publicador = {
    async publicar(tipo, data) {
      if (fallaPublicacion) throw new Error("broker caído");
      publicados.push({ tipo, data });
    }
  };

  beforeEach(() => {
    cuentas = crearRepositorioCuentasEnMemoria();
    publicados = [];
    logs = [];
    fallaPublicacion = false;
    contador = 0;
    manejador = crearManejadorEventosCuentas({
      repositorioCuentas: cuentas,
      emisorJwt: emisor,
      publicadorEventos: publicador,
      logger: (nivel, mensaje, extra) => logs.push({ nivel, mensaje, ...extra })
    });
    servicioAuth = crearServicioAuth(cuentas, emisor, null, publicador);
  });

  const evento = (type, data, id) =>
    Buffer.from(JSON.stringify({ id: id ?? `evt-${++contador}`, type, version: 1, occurredAt: "2026-03-01T14:32:05Z", producer: "test", data }));

  const creado = (data = { empleadoId: "E001", email: "ana@empresa.com" }, id) => evento("empleado.creado", data, id);
  const iniciadas = (empleadoId = "E001", id) => evento("vacaciones.iniciadas", { empleadoId, email: "ana@empresa.com" }, id);
  const finalizadas = (empleadoId = "E001", id) => evento("vacaciones.finalizadas", { empleadoId, email: "ana@empresa.com" }, id);
  const soloEventos = (tipo) => publicados.filter((p) => p.tipo === tipo);

  const cuentaConEstado = (estado, empleadoId = "E001", email = "ana@empresa.com") =>
    cuentas.agregar({ email, empleadoId, passwordHash: hashear("ClaveVieja#1"), estado });

  describe("RF-09: empleado.creado", () => {
    it("crea la cuenta INACTIVA, rol USER, identificada por empleadoId y email", async () => {
      assert.equal(await manejador.manejar(creado()), "procesado");
      const cuenta = await cuentas.buscarPorId("E001");
      assert.equal(cuenta.estado, "INACTIVA");
      assert.equal(cuenta.role, "USER");
      assert.equal(cuenta.empleadoId, "E001");
      assert.equal((await cuentas.buscarPorEmail("ANA@empresa.com")).empleadoId, "E001");
    });

    it("la cuenta nace sin contraseña válida: ninguna clave sirve y cada cuenta tiene un hash distinto", async () => {
      await manejador.manejar(creado());
      await manejador.manejar(creado({ empleadoId: "E002", email: "luis@empresa.com" }));
      const a = await cuentas.buscarPorId("E001");
      const b = await cuentas.buscarPorId("E002");
      for (const intento of ["", "password", "Admin#1234", "relleno-sin-uso", a.passwordHash]) {
        assert.equal(verificar(intento, a.passwordHash), false);
      }
      assert.notEqual(a.passwordHash, b.passwordHash);
      assert.match(a.passwordHash, /^scrypt\$/);
      await assert.rejects(servicioAuth.login("ana@empresa.com", "password"), { codigoEstado: 401 });
    });

    it("publica usuario.creado con empleadoId, email, tokenActivacion y expiraEn", async () => {
      await manejador.manejar(creado());
      const salida = soloEventos("usuario.creado");
      assert.equal(salida.length, 1);
      assert.deepEqual(Object.keys(salida[0].data).sort(), ["email", "empleadoId", "expiraEn", "tokenActivacion"]);
      assert.equal(salida[0].data.empleadoId, "E001");
      assert.equal(salida[0].data.email, "ana@empresa.com");
    });

    it("el tokenActivacion es un RESET_PASSWORD de la cuenta, con la vigencia de activación y expiraEn coherente", async () => {
      await manejador.manejar(creado());
      const { tokenActivacion, expiraEn } = soloEventos("usuario.creado")[0].data;
      const payload = emisor.verificar(tokenActivacion);
      assert.equal(payload.type, "RESET_PASSWORD");
      assert.equal(payload.sub, "E001");
      assert.equal(payload.ver, 0);
      assert.equal(payload.exp - payload.iat, EXPIRACION_ACTIVACION_SEGUNDOS);
      assert.equal(expiraEn, new Date(payload.exp * 1000).toISOString().replace(".000Z", "Z"));
    });

    it("de punta a punta: el token activa la cuenta con reset-password y publica cuenta.activada", async () => {
      await manejador.manejar(creado());
      const { tokenActivacion } = soloEventos("usuario.creado")[0].data;
      await servicioAuth.resetPassword(tokenActivacion, "ClaveNueva#2024");
      assert.equal((await cuentas.buscarPorId("E001")).estado, "ACTIVA");
      const activada = soloEventos("cuenta.activada");
      assert.equal(activada.length, 1);
      assert.equal(activada[0].data.motivo, "ACTIVACION_INICIAL");
      assert.ok((await servicioAuth.login("ana@empresa.com", "ClaveNueva#2024")).accessToken);
    });

    it("ignora con log si ya existe una cuenta con ese empleadoId (no la toca ni publica)", async () => {
      cuentaConEstado("ACTIVA");
      assert.equal(await manejador.manejar(creado()), "ignorado");
      assert.equal((await cuentas.buscarPorId("E001")).estado, "ACTIVA");
      assert.equal(publicados.length, 0);
      assert.ok(logs.some((l) => /ignorado/.test(l.mensaje) && l.empleadoId === "E001" && l.motivo === "empleadoId"));
    });

    it("ignora con log si ya existe una cuenta con ese email (sin importar mayúsculas) bajo otro empleadoId", async () => {
      cuentaConEstado("ACTIVA", "E999", "ANA@empresa.com");
      assert.equal(await manejador.manejar(creado()), "ignorado");
      assert.equal(await cuentas.buscarPorId("E001"), null);
      assert.equal(publicados.length, 0);
      assert.ok(logs.some((l) => l.motivo === "email"));
    });

    it("ignora con log si el email es el del administrador semilla", async () => {
      cuentas.agregarAdminSemilla({ id: "ADMIN", email: "ana@empresa.com" });
      assert.equal(await manejador.manejar(creado()), "ignorado");
      assert.equal(await cuentas.buscarPorId("E001"), null);
      assert.equal(publicados.length, 0);
    });

    it("un evento con el mismo id llegado dos veces se procesa una sola vez (deduplicación)", async () => {
      assert.equal(await manejador.manejar(creado(undefined, "dup-1")), "procesado");
      assert.equal(await manejador.manejar(creado(undefined, "dup-1")), "duplicado");
      assert.equal(soloEventos("usuario.creado").length, 1);
    });

    it("si falla la publicación de usuario.creado se hace rollback (ni cuenta ni id) y el reintento lo completa", async () => {
      fallaPublicacion = true;
      await assert.rejects(manejador.manejar(creado(undefined, "evt-r")), /broker caído/);
      assert.equal(await cuentas.buscarPorId("E001"), null);
      assert.equal(cuentas.eventoRegistrado("evt-r"), false);

      fallaPublicacion = false;
      assert.equal(await manejador.manejar(creado(undefined, "evt-r")), "procesado");
      assert.equal((await cuentas.buscarPorId("E001")).estado, "INACTIVA");
      assert.equal(soloEventos("usuario.creado").length, 1);
    });

    it("mensajes inválidos lanzan EventoInvalido y no consumen el id", async () => {
      const malos = [
        Buffer.from("{no es json"),
        Buffer.from("[]"),
        Buffer.from(JSON.stringify({ type: "empleado.creado", data: {} })),
        Buffer.from(JSON.stringify({ id: "x", data: {} })),
        Buffer.from(JSON.stringify({ id: "x", type: "empleado.creado", data: "texto" })),
        creado({ email: "ana@empresa.com" }, "x"),
        creado({ empleadoId: "E001" }, "x"),
        creado({ empleadoId: "  ", email: "ana@empresa.com" }, "x")
      ];
      for (const malo of malos) {
        await assert.rejects(manejador.manejar(malo), EventoInvalido);
      }
      assert.equal(cuentas.eventoRegistrado("x"), false);
      assert.equal(publicados.length, 0);
    });

    it("si el empleado no existe (FK) es un evento inválido y se deshace todo", async () => {
      const repo = crearRepositorioCuentasEnMemoria();
      const original = repo.crearCuentaInactiva;
      repo.crearCuentaInactiva = async () => "EMPLEADO_INEXISTENTE";
      const m = crearManejadorEventosCuentas({ repositorioCuentas: repo, emisorJwt: emisor, publicadorEventos: publicador, logger: () => {} });
      await assert.rejects(m.manejar(creado(undefined, "fk-1")), EventoInvalido);
      assert.equal(repo.eventoRegistrado("fk-1"), false);
      repo.crearCuentaInactiva = original;
    });

    it("eventos de otros tipos se ignoran sin tocar nada", async () => {
      assert.equal(await manejador.manejar(evento("empleado.retirado", { empleadoId: "E001", email: "a@b.c" })), "ignorado");
      assert.equal(publicados.length, 0);
    });
  });

  describe("RF-10: vacaciones.iniciadas", () => {
    it("ACTIVA pasa a SUSPENDIDA_TEMPORAL y publica cuenta.desactivada con motivo VACACIONES y permanente false", async () => {
      cuentaConEstado("ACTIVA");
      assert.equal(await manejador.manejar(iniciadas()), "procesado");
      assert.equal((await cuentas.buscarPorId("E001")).estado, "SUSPENDIDA_TEMPORAL");
      const salida = soloEventos("cuenta.desactivada");
      assert.equal(salida.length, 1);
      assert.equal(salida[0].data.empleadoId, "E001");
      assert.equal(salida[0].data.email, "ana@empresa.com");
      assert.equal(salida[0].data.motivo, "VACACIONES");
      assert.strictEqual(salida[0].data.permanente, false);
    });

    for (const estado of ["INACTIVA", "SUSPENDIDA_TEMPORAL", "DESACTIVADA_PERMANENTE"]) {
      it(`en estado ${estado} se ignora con log: sin cambio de estado ni evento`, async () => {
        cuentaConEstado(estado);
        assert.equal(await manejador.manejar(iniciadas()), "ignorado");
        assert.equal((await cuentas.buscarPorId("E001")).estado, estado);
        assert.equal(publicados.length, 0);
        assert.ok(logs.some((l) => /ignorado/.test(l.mensaje) && l.estado === estado));
      });
    }

    it("sin cuenta para el empleado (p. ej. el ADMIN semilla) se ignora con log", async () => {
      assert.equal(await manejador.manejar(iniciadas("ADMIN")), "ignorado");
      assert.equal(publicados.length, 0);
      assert.ok(logs.some((l) => /ignorado/.test(l.mensaje)));
    });

    it("la cuenta suspendida no puede iniciar sesión", async () => {
      cuentaConEstado("ACTIVA");
      await manejador.manejar(iniciadas());
      await assert.rejects(servicioAuth.login("ana@empresa.com", "ClaveVieja#1"), { codigoEstado: 401 });
    });

    it("si falla la publicación se hace rollback: la cuenta sigue ACTIVA y el reintento la suspende", async () => {
      cuentaConEstado("ACTIVA");
      fallaPublicacion = true;
      await assert.rejects(manejador.manejar(iniciadas("E001", "evt-v")), /broker caído/);
      assert.equal((await cuentas.buscarPorId("E001")).estado, "ACTIVA");
      fallaPublicacion = false;
      assert.equal(await manejador.manejar(iniciadas("E001", "evt-v")), "procesado");
      assert.equal((await cuentas.buscarPorId("E001")).estado, "SUSPENDIDA_TEMPORAL");
    });

    it("sin empleadoId es un mensaje inválido", async () => {
      await assert.rejects(manejador.manejar(evento("vacaciones.iniciadas", { email: "a@b.c" })), EventoInvalido);
    });
  });

  describe("RF-11: vacaciones.finalizadas", () => {
    it("SUSPENDIDA_TEMPORAL pasa a ACTIVA y publica cuenta.activada con motivo FIN_VACACIONES", async () => {
      cuentaConEstado("SUSPENDIDA_TEMPORAL");
      assert.equal(await manejador.manejar(finalizadas()), "procesado");
      assert.equal((await cuentas.buscarPorId("E001")).estado, "ACTIVA");
      const salida = soloEventos("cuenta.activada");
      assert.equal(salida.length, 1);
      assert.equal(salida[0].data.empleadoId, "E001");
      assert.equal(salida[0].data.email, "ana@empresa.com");
      assert.equal(salida[0].data.motivo, "FIN_VACACIONES");
    });

    for (const estado of ["ACTIVA", "INACTIVA", "DESACTIVADA_PERMANENTE"]) {
      it(`en estado ${estado} se ignora con log: sin cambio de estado ni evento`, async () => {
        cuentaConEstado(estado);
        assert.equal(await manejador.manejar(finalizadas()), "ignorado");
        assert.equal((await cuentas.buscarPorId("E001")).estado, estado);
        assert.equal(publicados.length, 0);
        assert.ok(logs.some((l) => /ignorado/.test(l.mensaje) && l.estado === estado));
      });
    }

    it("ciclo completo: iniciadas suspende, finalizadas reactiva y una finalizadas repetida se ignora", async () => {
      cuentaConEstado("ACTIVA");
      await manejador.manejar(iniciadas());
      assert.equal((await cuentas.buscarPorId("E001")).estado, "SUSPENDIDA_TEMPORAL");
      await manejador.manejar(finalizadas());
      assert.equal((await cuentas.buscarPorId("E001")).estado, "ACTIVA");
      assert.equal(await manejador.manejar(finalizadas()), "ignorado");
      assert.deepEqual(publicados.map((p) => p.tipo), ["cuenta.desactivada", "cuenta.activada"]);
      assert.ok((await servicioAuth.login("ana@empresa.com", "ClaveVieja#1")).accessToken);
    });

    it("no depende del estado del empleado: solo cuenta el estado de la propia cuenta", async () => {
      // Una cuenta ACTIVA no se "reactiva" aunque llegue finalizadas; una SUSPENDIDA sí.
      cuentaConEstado("ACTIVA", "E010", "a@empresa.com");
      cuentaConEstado("SUSPENDIDA_TEMPORAL", "E011", "b@empresa.com");
      assert.equal(await manejador.manejar(finalizadas("E010")), "ignorado");
      assert.equal(await manejador.manejar(finalizadas("E011")), "procesado");
    });
  });

  describe("Política de ack del consumidor", () => {
    const canalFalso = () => {
      const llamadas = [];
      return {
        llamadas,
        ack: (m) => llamadas.push(["ack", m]),
        reject: (m, requeue) => llamadas.push(["reject", m, requeue]),
        nack: (m, todos, requeue) => llamadas.push(["nack", m, todos, requeue])
      };
    };
    const mensaje = { content: Buffer.from("{}"), properties: { messageId: "m1" } };
    const silencioso = () => {};

    for (const resultado of ["procesado", "duplicado", "ignorado"]) {
      it(`${resultado} -> ack`, async () => {
        const canal = canalFalso();
        await crearCallback({ manejador: async () => resultado, canal, logger: silencioso })(mensaje);
        assert.deepEqual(canal.llamadas, [["ack", mensaje]]);
      });
    }

    it("mensaje inválido -> reject sin reencolar", async () => {
      const canal = canalFalso();
      await crearCallback({
        manejador: async () => { throw new EventoInvalido("roto"); },
        canal,
        logger: silencioso
      })(mensaje);
      assert.deepEqual(canal.llamadas, [["reject", mensaje, false]]);
    });

    it("fallo transitorio -> nack con reencolado", async () => {
      const canal = canalFalso();
      await crearCallback({
        manejador: async () => { throw new Error("BD caída"); },
        canal,
        pausaFalloMs: 0,
        logger: silencioso
      })(mensaje);
      assert.deepEqual(canal.llamadas, [["nack", mensaje, false, true]]);
    });

    it("cancelación del consumidor por el broker (mensaje null) no hace nada", async () => {
      const canal = canalFalso();
      await crearCallback({ manejador: async () => "procesado", canal, logger: silencioso })(null);
      assert.deepEqual(canal.llamadas, []);
    });
  });
});
