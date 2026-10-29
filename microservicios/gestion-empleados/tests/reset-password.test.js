const { describe, it, beforeEach, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { crearApp } = require("../src/app");
const { crearServicioEmpleados } = require("../src/services/empleados.service");
const { crearServicioAuth } = require("../src/services/auth.service");
const { crearRepositorioEmpleadosEnMemoria } = require("../src/repository/empleados.repository.memoria");
const { crearRepositorioCuentasEnMemoria } = require("../src/repository/cuentas.repository.memoria");
const { crearEmisorJwt } = require("../src/auth/jwt");
const { hashear, verificar } = require("../src/auth/password");

const SECRETO = "secreto-de-pruebas-con-mas-de-32-caracteres";
const CLAVE_VIEJA = "ClaveVieja#1";
const CLAVE_NUEVA = "ClaveNueva#2024";

describe("POST /auth/reset-password (RF-04 / RF-05)", () => {
  let servidor;
  let baseUrl;
  let cuentas;
  let eventos;
  let fallaBroker;
  let reloj;
  const ahora = () => reloj;
  const emisor = crearEmisorJwt({ secreto: SECRETO, expiracionSegundos: 600, ahora });

  const publicadorEventos = {
    async publicar(tipo, data) {
      if (fallaBroker) throw new Error("broker caído");
      eventos.push({ tipo, data });
    }
  };

  before(async () => {
    cuentas = crearRepositorioCuentasEnMemoria();
    const admin = { id: "ADMIN", email: "admin@talentflow.local", passwordHash: hashear("admin-pass") };
    const servicioAuth = crearServicioAuth(cuentas, emisor, admin, publicadorEventos);
    const servicio = crearServicioEmpleados(crearRepositorioEmpleadosEnMemoria(), { existe: async () => "EXISTE" });
    const app = crearApp(servicio, undefined, { servicioAuth });
    servidor = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(() => servidor.close());

  beforeEach(() => {
    reloj = 1_700_000_000_000;
    eventos = [];
    fallaBroker = false;
    const hash = hashear(CLAVE_VIEJA);
    cuentas.agregar({ email: "inactiva@empresa.com", empleadoId: "E001", passwordHash: hash, estado: "INACTIVA" });
    cuentas.agregar({ email: "activa@empresa.com", empleadoId: "E002", passwordHash: hash, estado: "ACTIVA" });
    cuentas.agregar({ email: "susp@empresa.com", empleadoId: "E003", passwordHash: hash, estado: "SUSPENDIDA_TEMPORAL" });
    cuentas.agregar({ email: "baja@empresa.com", empleadoId: "E004", passwordHash: hash, estado: "DESACTIVADA_PERMANENTE" });
  });

  const reset = (cuerpo) =>
    fetch(`${baseUrl}/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo)
    });

  const tokenDe = (sub, version = 0) => emisor.emitirReset({ sub, version });
  const cuentaDe = (email) => cuentas.buscarPorEmail(email);

  describe("RF-04: éxito y rechazos", () => {
    it("200 y la contraseña nueva reemplaza a la vieja (hash scrypt)", async () => {
      const respuesta = await reset({ token: tokenDe("E002"), newPassword: CLAVE_NUEVA });
      assert.equal(respuesta.status, 200);
      const cuenta = await cuentaDe("activa@empresa.com");
      assert.ok(verificar(CLAVE_NUEVA, cuenta.passwordHash));
      assert.ok(!verificar(CLAVE_VIEJA, cuenta.passwordHash));
      assert.ok(!cuenta.passwordHash.includes(CLAVE_NUEVA));
    });

    it("400 si faltan token o newPassword", async () => {
      assert.equal((await reset({ newPassword: CLAVE_NUEVA })).status, 400);
      assert.equal((await reset({ token: tokenDe("E002") })).status, 400);
      assert.equal((await reset({})).status, 400);
    });

    it("400 con token expirado", async () => {
      const token = emisor.emitirReset({ sub: "E002", version: 0, expiracionSegundosReset: 60 });
      reloj += 61_000;
      const respuesta = await reset({ token, newPassword: CLAVE_NUEVA });
      assert.equal(respuesta.status, 400);
      assert.ok(verificar(CLAVE_VIEJA, (await cuentaDe("activa@empresa.com")).passwordHash));
    });

    it("400 con token alterado (payload o firma modificados) y con basura", async () => {
      const [h, , f] = tokenDe("E002").split(".");
      const payloadFalso = Buffer.from(
        JSON.stringify({ sub: "E003", type: "RESET_PASSWORD", ver: 0, iat: 1, exp: 9999999999 })
      ).toString("base64url");
      assert.equal((await reset({ token: `${h}.${payloadFalso}.${f}`, newPassword: CLAVE_NUEVA })).status, 400);
      assert.equal((await reset({ token: `${tokenDe("E002")}x`, newPassword: CLAVE_NUEVA })).status, 400);
      assert.equal((await reset({ token: "no-es-un-jwt", newPassword: CLAVE_NUEVA })).status, 400);
      assert.equal((await reset({ token: 12345, newPassword: CLAVE_NUEVA })).status, 400);
    });

    it("400 con token firmado por otro secreto", async () => {
      const ajeno = crearEmisorJwt({ secreto: "otro-secreto-distinto-de-mas-de-32-caracteres", ahora });
      const token = ajeno.emitirReset({ sub: "E002", version: 0 });
      assert.equal((await reset({ token, newPassword: CLAVE_NUEVA })).status, 400);
    });

    it("400 con token de otro type, incluido un JWT de acceso (login)", async () => {
      const acceso = emisor.emitir({ sub: "E002", role: "USER" });
      assert.equal((await reset({ token: acceso, newPassword: CLAVE_NUEVA })).status, 400);

      // Mismo secreto, firma válida, pero type distinto.
      const crypto = require("node:crypto");
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const cabecera = b64({ alg: "HS256", typ: "JWT" });
      const payload = b64({ sub: "E002", type: "OTRO_TIPO", ver: 0, iat: 1_700_000_000, exp: 1_700_000_600 });
      const firma = crypto.createHmac("sha256", SECRETO).update(`${cabecera}.${payload}`).digest("base64url");
      assert.equal((await reset({ token: `${cabecera}.${payload}.${firma}`, newPassword: CLAVE_NUEVA })).status, 400);
    });

    it("400 si el token ya se usó (versión obsoleta) y la segunda contraseña no se aplica", async () => {
      const token = tokenDe("E002", 0);
      assert.equal((await reset({ token, newPassword: CLAVE_NUEVA })).status, 200);
      const segunda = await reset({ token, newPassword: "OtraClave#9999" });
      assert.equal(segunda.status, 400);
      const cuenta = await cuentaDe("activa@empresa.com");
      assert.ok(verificar(CLAVE_NUEVA, cuenta.passwordHash));
      assert.equal(cuenta.versionToken, 1);
    });

    it("un token con versión anterior a la vigente queda obsoleto aunque no se haya usado", async () => {
      const viejo = tokenDe("E002", 0);
      const nuevo = tokenDe("E002", 0);
      assert.equal((await reset({ token: nuevo, newPassword: CLAVE_NUEVA })).status, 200);
      assert.equal((await reset({ token: viejo, newPassword: "OtraClave#9999" })).status, 400);
    });

    it("dos usos concurrentes del mismo token: solo uno gana", async () => {
      const token = tokenDe("E002", 0);
      const resultados = await Promise.all([
        reset({ token, newPassword: "PrimeraClave#11" }),
        reset({ token, newPassword: "SegundaClave#22" })
      ]);
      const codigos = resultados.map((r) => r.status).sort();
      assert.deepEqual(codigos, [200, 400]);
    });

    it("400 si la cuenta está DESACTIVADA_PERMANENTE y no se modifica", async () => {
      const respuesta = await reset({ token: tokenDe("E004"), newPassword: CLAVE_NUEVA });
      assert.equal(respuesta.status, 400);
      const cuenta = await cuentaDe("baja@empresa.com");
      assert.ok(verificar(CLAVE_VIEJA, cuenta.passwordHash));
      assert.equal(cuenta.estado, "DESACTIVADA_PERMANENTE");
      assert.equal(eventos.length, 0);
    });

    it("400 con el mismo mensaje para token inválido, cuenta inexistente y DESACTIVADA_PERMANENTE", async () => {
      const casos = [
        { token: "basura", newPassword: CLAVE_NUEVA },
        { token: tokenDe("NO-EXISTE"), newPassword: CLAVE_NUEVA },
        { token: tokenDe("E004"), newPassword: CLAVE_NUEVA },
        { token: tokenDe("ADMIN"), newPassword: CLAVE_NUEVA }
      ];
      const mensajes = new Set();
      for (const caso of casos) {
        const respuesta = await reset(caso);
        assert.equal(respuesta.status, 400);
        mensajes.add((await respuesta.json()).message);
      }
      assert.equal(mensajes.size, 1);
    });

    it("400 si la contraseña incumple la política (RNF-05) y el token NO se consume", async () => {
      const token = tokenDe("E002");
      const debiles = ["Cor1#ta", "sinmayuscula1#", "SINMINUSCULA1#", "SinDigitos###", "SinEspecial123", "Ab1#", "x".repeat(129) + "A1#"];
      for (const newPassword of debiles) {
        const respuesta = await reset({ token, newPassword });
        assert.equal(respuesta.status, 400, newPassword);
        const cuerpo = await respuesta.json();
        assert.ok(cuerpo.errors.some((e) => e.field === "newPassword"));
      }
      const cuenta = await cuentaDe("activa@empresa.com");
      assert.ok(verificar(CLAVE_VIEJA, cuenta.passwordHash));
      assert.equal(cuenta.versionToken, 0);
      // El mismo token sigue sirviendo con una contraseña válida.
      assert.equal((await reset({ token, newPassword: CLAVE_NUEVA })).status, 200);
    });
  });

  describe("RF-05: efecto sobre el estado de la cuenta", () => {
    it("INACTIVA pasa a ACTIVA y publica cuenta.activada con motivo ACTIVACION_INICIAL", async () => {
      const respuesta = await reset({ token: tokenDe("E001"), newPassword: CLAVE_NUEVA });
      assert.equal(respuesta.status, 200);
      assert.equal((await cuentaDe("inactiva@empresa.com")).estado, "ACTIVA");
      assert.equal(eventos.length, 1);
      assert.equal(eventos[0].tipo, "cuenta.activada");
      assert.equal(eventos[0].data.motivo, "ACTIVACION_INICIAL");
      assert.equal(eventos[0].data.empleadoId, "E001");
      assert.equal(eventos[0].data.email, "inactiva@empresa.com");
    });

    it("tras la activación inicial se puede iniciar sesión con la contraseña nueva", async () => {
      await reset({ token: tokenDe("E001"), newPassword: CLAVE_NUEVA });
      const login = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "inactiva@empresa.com", password: CLAVE_NUEVA })
      });
      assert.equal(login.status, 200);
    });

    it("ACTIVA: solo cambia la contraseña; sin cambio de estado ni evento", async () => {
      assert.equal((await reset({ token: tokenDe("E002"), newPassword: CLAVE_NUEVA })).status, 200);
      const cuenta = await cuentaDe("activa@empresa.com");
      assert.equal(cuenta.estado, "ACTIVA");
      assert.ok(verificar(CLAVE_NUEVA, cuenta.passwordHash));
      assert.equal(eventos.length, 0);
    });

    it("SUSPENDIDA_TEMPORAL: solo cambia la contraseña; sigue suspendida y sin evento", async () => {
      assert.equal((await reset({ token: tokenDe("E003"), newPassword: CLAVE_NUEVA })).status, 200);
      const cuenta = await cuentaDe("susp@empresa.com");
      assert.equal(cuenta.estado, "SUSPENDIDA_TEMPORAL");
      assert.ok(verificar(CLAVE_NUEVA, cuenta.passwordHash));
      assert.equal(eventos.length, 0);
    });

    it("el reset inicial y el de recuperación usan tokens idénticos en forma: decide el estado", async () => {
      const t1 = tokenDe("E001");
      const t2 = tokenDe("E002");
      const tipo = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url")).type;
      assert.equal(tipo(t1), "RESET_PASSWORD");
      assert.equal(tipo(t2), "RESET_PASSWORD");
    });

    it("si el broker falla, la activación igual se guarda y responde 200 (RNF-06)", async () => {
      fallaBroker = true;
      const respuesta = await reset({ token: tokenDe("E001"), newPassword: CLAVE_NUEVA });
      assert.equal(respuesta.status, 200);
      assert.equal((await cuentaDe("inactiva@empresa.com")).estado, "ACTIVA");
    });
  });

  describe("integración con RF-03 (recover-password emite un token válido para RF-04)", () => {
    it("el token publicado por recover-password sirve en reset-password una sola vez", async () => {
      await fetch(`${baseUrl}/auth/recover-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "activa@empresa.com" })
      });
      const publicado = eventos.find((e) => e.tipo === "usuario.recuperacion");
      assert.ok(publicado);
      const token = publicado.data.tokenRecuperacion;
      assert.equal((await reset({ token, newPassword: CLAVE_NUEVA })).status, 200);
      assert.equal((await reset({ token, newPassword: "OtraClave#9999" })).status, 400);
    });
  });



  it("RF-08: recuperación genera JWT con claims correctos y expiración de 30 minutos", async () => {
  await fetch(`${baseUrl}/auth/recover-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "activa@empresa.com" })
  });

  const publicado = eventos.find((e) => e.tipo === "usuario.recuperacion");
  assert.ok(publicado);

  const token = publicado.data.tokenRecuperacion;
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8")
  );

  assert.deepEqual(
    Object.keys(payload).sort(),
    ["exp", "iat", "sub", "type", "ver"].sort()
  );
  assert.equal(payload.sub, "E002");
  assert.equal(payload.type, "RESET_PASSWORD");
  assert.equal(payload.ver, 0);
  assert.equal(payload.exp - payload.iat, 30 * 60);
  assert.equal(
    Date.parse(publicado.data.expiraEn) / 1000,
    payload.exp
  );
});

it("RF-08: activación inicial genera JWT con expiración de 24 horas", async () => {
  await fetch(`${baseUrl}/auth/recover-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "inactiva@empresa.com" })
  });

  const publicado = eventos.find((e) => e.tipo === "usuario.recuperacion");
  assert.ok(publicado);

  const token = publicado.data.tokenRecuperacion;
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8")
  );

  assert.equal(payload.sub, "E001");
  assert.equal(payload.type, "RESET_PASSWORD");
  assert.equal(payload.ver, 0);
  assert.equal(payload.exp - payload.iat, 24 * 60 * 60);
  assert.equal(
    Date.parse(publicado.data.expiraEn) / 1000,
    payload.exp
  );
});
});
