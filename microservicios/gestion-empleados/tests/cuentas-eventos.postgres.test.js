// Integración contra PostgreSQL real. Se omite si no hay TEST_DB_URL, p. ej.:
//   TEST_DB_URL=postgres://user:pass@127.0.0.1:5432/tf_test npm test
// ATENCIÓN: aplica init.sql y VACÍA las tablas empleados, cuentas y eventos_procesados. Usar una
// base de datos desechable.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const { crearManejadorEventosCuentas } = require("../src/services/cuentas-eventos.service");
const { crearRepositorioCuentasPostgres } = require("../src/repository/cuentas.repository.postgres");
const { crearEmisorJwt } = require("../src/auth/jwt");
const { hashear, verificar } = require("../src/auth/password");
const { EventoInvalido } = require("../src/errores");

const URL_BD = process.env.TEST_DB_URL;
const SECRETO = "secreto-de-pruebas-con-mas-de-32-caracteres";

describe("Eventos de cuentas contra PostgreSQL (RF-09 / RF-10 / RF-11)", { skip: !URL_BD && "sin TEST_DB_URL" }, () => {
  let pool;
  let repo;
  let publicados;
  let fallaPublicacion;
  let manejador;
  let n = 0;
  const emisor = crearEmisorJwt({ secreto: SECRETO });

  before(async () => {
    pool = new Pool({ connectionString: URL_BD });
    const sql = fs.readFileSync(path.join(__dirname, "..", "init.sql"), "utf8");
    await pool.query(sql);
    await pool.query(sql); // el init.sql debe poder reaplicarse sobre una BD existente
    repo = crearRepositorioCuentasPostgres(pool);
  });

  after(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE eventos_procesados, cuentas, empleados CASCADE");
    publicados = [];
    fallaPublicacion = false;
    manejador = crearManejadorEventosCuentas({
      repositorioCuentas: repo,
      emisorJwt: emisor,
      publicadorEventos: {
        async publicar(tipo, data) {
          if (fallaPublicacion) throw new Error("broker caído");
          publicados.push({ tipo, data });
        }
      },
      logger: () => {}
    });
  });

  const empleado = (id, email) =>
    pool.query(
      `INSERT INTO empleados (id, nombre, apellido, email, numero_empleado, cargo, area, departamento_id, fecha_ingreso)
       VALUES ($1, 'N', 'A', $2, $1, 'Dev', 'TI', 'D1', '2026-01-01')`,
      [id, email]
    );
  const cuenta = async (id) => (await pool.query("SELECT * FROM cuentas WHERE empleado_id = $1", [id])).rows[0];
  const sobre = (type, data, id) =>
    Buffer.from(JSON.stringify({ id: id ?? `pg-${++n}`, type, version: 1, occurredAt: "x", producer: "t", data }));
  const salidas = (tipo) => publicados.filter((p) => p.tipo === tipo);
  const idsRegistrados = async () => (await pool.query("SELECT id FROM eventos_procesados")).rows.map((r) => r.id);

  it("init.sql deja el esquema esperado (estado DESACTIVADA_PERMANENTE permitido, token_version, eventos_procesados)", async () => {
    await empleado("E1", "e1@x.com");
    await pool.query(
      "INSERT INTO cuentas (empleado_id, password_hash, estado) VALUES ('E1', 'h', 'DESACTIVADA_PERMANENTE')"
    );
    assert.equal((await cuenta("E1")).token_version, 0);
  });

  describe("RF-09", () => {
    it("crea la cuenta INACTIVA, USER, sin contraseña válida, publica usuario.creado y registra el id", async () => {
      await empleado("E1", "ana@x.com");
      assert.equal(await manejador.manejar(sobre("empleado.creado", { empleadoId: "E1", email: "ana@x.com" }, "ev-1")), "procesado");
      const fila = await cuenta("E1");
      assert.equal(fila.estado, "INACTIVA");
      assert.equal(fila.role, "USER");
      assert.equal(fila.token_version, 0);
      assert.equal(verificar("cualquiera", fila.password_hash), false);
      assert.equal(salidas("usuario.creado").length, 1);
      assert.deepEqual(await idsRegistrados(), ["ev-1"]);
      const payload = emisor.verificar(salidas("usuario.creado")[0].data.tokenActivacion);
      assert.equal(payload.sub, "E1");
      assert.equal(payload.ver, fila.token_version);
    });

    it("ignora si ya existe cuenta con ese empleadoId o ese email", async () => {
      await empleado("E1", "ana@x.com");
      await manejador.manejar(sobre("empleado.creado", { empleadoId: "E1", email: "ana@x.com" }));
      publicados.length = 0;
      assert.equal(await manejador.manejar(sobre("empleado.creado", { empleadoId: "E1", email: "otro@x.com" })), "ignorado");
      assert.equal(await manejador.manejar(sobre("empleado.creado", { empleadoId: "E9", email: "ANA@x.com" })), "ignorado");
      assert.equal(publicados.length, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM cuentas")).rows[0].n, 1);
    });

    it("el mismo id de evento repetido se procesa una sola vez", async () => {
      await empleado("E1", "ana@x.com");
      const msg = sobre("empleado.creado", { empleadoId: "E1", email: "ana@x.com" }, "dup");
      assert.equal(await manejador.manejar(msg), "procesado");
      assert.equal(await manejador.manejar(msg), "duplicado");
      assert.equal(salidas("usuario.creado").length, 1);
    });

    it("dos eventos con ids distintos para el mismo empleado a la vez: solo uno crea la cuenta", async () => {
      await empleado("E1", "ana@x.com");
      const datos = { empleadoId: "E1", email: "ana@x.com" };
      const resultados = await Promise.all([
        manejador.manejar(sobre("empleado.creado", datos)),
        manejador.manejar(sobre("empleado.creado", datos))
      ]);
      assert.deepEqual(resultados.sort(), ["ignorado", "procesado"]);
      assert.equal(salidas("usuario.creado").length, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM cuentas")).rows[0].n, 1);
    });

    it("empleado inexistente (viola la FK): EventoInvalido y no queda rastro del id", async () => {
      await assert.rejects(
        manejador.manejar(sobre("empleado.creado", { empleadoId: "FANTASMA", email: "f@x.com" }, "fk")),
        EventoInvalido
      );
      assert.deepEqual(await idsRegistrados(), []);
      assert.equal(publicados.length, 0);
    });

    it("si falla la publicación hace ROLLBACK real (sin cuenta ni id) y el reintento funciona", async () => {
      await empleado("E1", "ana@x.com");
      const msg = sobre("empleado.creado", { empleadoId: "E1", email: "ana@x.com" }, "rb");
      fallaPublicacion = true;
      await assert.rejects(manejador.manejar(msg), /broker caído/);
      assert.equal(await cuenta("E1"), undefined);
      assert.deepEqual(await idsRegistrados(), []);
      fallaPublicacion = false;
      assert.equal(await manejador.manejar(msg), "procesado");
      assert.equal((await cuenta("E1")).estado, "INACTIVA");
    });
  });

  describe("RF-10 / RF-11", () => {
    const conCuenta = async (estado) => {
      await empleado("E1", "ana@x.com");
      await pool.query("INSERT INTO cuentas (empleado_id, password_hash, estado) VALUES ('E1', $1, $2)", [hashear("ClaveVieja#1"), estado]);
    };
    const datos = { empleadoId: "E1", email: "ana@x.com" };

    it("iniciadas: ACTIVA -> SUSPENDIDA_TEMPORAL con cuenta.desactivada {VACACIONES, permanente:false}", async () => {
      await conCuenta("ACTIVA");
      assert.equal(await manejador.manejar(sobre("vacaciones.iniciadas", datos)), "procesado");
      assert.equal((await cuenta("E1")).estado, "SUSPENDIDA_TEMPORAL");
      const s = salidas("cuenta.desactivada");
      assert.equal(s.length, 1);
      assert.equal(s[0].data.motivo, "VACACIONES");
      assert.strictEqual(s[0].data.permanente, false);
      assert.equal(s[0].data.email, "ana@x.com");
    });

    for (const estado of ["INACTIVA", "SUSPENDIDA_TEMPORAL", "DESACTIVADA_PERMANENTE"]) {
      it(`iniciadas en ${estado}: se ignora`, async () => {
        await conCuenta(estado);
        assert.equal(await manejador.manejar(sobre("vacaciones.iniciadas", datos)), "ignorado");
        assert.equal((await cuenta("E1")).estado, estado);
        assert.equal(publicados.length, 0);
      });
    }

    it("finalizadas: SUSPENDIDA_TEMPORAL -> ACTIVA con cuenta.activada {FIN_VACACIONES}", async () => {
      await conCuenta("SUSPENDIDA_TEMPORAL");
      assert.equal(await manejador.manejar(sobre("vacaciones.finalizadas", datos)), "procesado");
      assert.equal((await cuenta("E1")).estado, "ACTIVA");
      assert.equal(salidas("cuenta.activada")[0].data.motivo, "FIN_VACACIONES");
    });

    for (const estado of ["ACTIVA", "INACTIVA", "DESACTIVADA_PERMANENTE"]) {
      it(`finalizadas en ${estado}: se ignora`, async () => {
        await conCuenta(estado);
        assert.equal(await manejador.manejar(sobre("vacaciones.finalizadas", datos)), "ignorado");
        assert.equal((await cuenta("E1")).estado, estado);
        assert.equal(publicados.length, 0);
      });
    }

    it("dos iniciadas simultáneas (ids distintos): solo una suspende y publica", async () => {
      await conCuenta("ACTIVA");
      const resultados = await Promise.all(
        Array.from({ length: 5 }, () => manejador.manejar(sobre("vacaciones.iniciadas", datos)))
      );
      assert.equal(resultados.filter((r) => r === "procesado").length, 1);
      assert.equal(salidas("cuenta.desactivada").length, 1);
      assert.equal((await cuenta("E1")).estado, "SUSPENDIDA_TEMPORAL");
    });

    it("si falla la publicación de cuenta.desactivada, el estado vuelve a ACTIVA (ROLLBACK)", async () => {
      await conCuenta("ACTIVA");
      fallaPublicacion = true;
      await assert.rejects(manejador.manejar(sobre("vacaciones.iniciadas", datos, "rb2")), /broker caído/);
      assert.equal((await cuenta("E1")).estado, "ACTIVA");
      assert.deepEqual(await idsRegistrados(), []);
    });
  });
});
