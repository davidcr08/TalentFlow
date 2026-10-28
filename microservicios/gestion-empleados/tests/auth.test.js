const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { crearApp } = require("../src/app");
const { crearServicioEmpleados } = require("../src/services/empleados.service");
const { crearServicioAuth } = require("../src/services/auth.service");
const { crearRepositorioEmpleadosEnMemoria } = require("../src/repository/empleados.repository.memoria");
const { crearRepositorioCuentasEnMemoria } = require("../src/repository/cuentas.repository.memoria");
const { crearEmisorJwt } = require("../src/auth/jwt");
const { hashear } = require("../src/auth/password");

const SECRETO = "secreto-de-pruebas-con-mas-de-32-caracteres";

describe("POST /auth/login (RF-01 / RF-02)", () => {
  let servidor;
  let baseUrl;
  const emisor = crearEmisorJwt({ secreto: SECRETO, expiracionSegundos: 600 });

  before(async () => {
    const cuentas = crearRepositorioCuentasEnMemoria();
    const hash = hashear("clave-correcta");
    cuentas.agregar({ email: "ana@empresa.com", empleadoId: "E001", passwordHash: hash });
    cuentas.agregar({ email: "inactiva@empresa.com", empleadoId: "E002", passwordHash: hash, estado: "INACTIVA" });
    cuentas.agregar({ email: "susp@empresa.com", empleadoId: "E003", passwordHash: hash, estado: "SUSPENDIDA_TEMPORAL" });
    cuentas.agregar({ email: "desactivada@empresa.com", empleadoId: "E004", passwordHash: hash, estado: "DESACTIVADA_PERMANENTE" });

    const admin = { id: "ADMIN", email: "admin@talentflow.local", passwordHash: hashear("admin-pass") };
    const servicioAuth = crearServicioAuth(cuentas, emisor, admin);
    const servicio = crearServicioEmpleados(crearRepositorioEmpleadosEnMemoria(), { existe: async () => "EXISTE" });
    const app = crearApp(servicio, undefined, { servicioAuth });

    servidor = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(() => servidor.close());

  const login = (cuerpo) =>
    fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo)
    });

  const decodificar = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

  it("200 con JWT cuyo payload tiene exactamente sub, role, iat y exp (USER)", async () => {
    const respuesta = await login({ email: "ana@empresa.com", password: "clave-correcta" });
    assert.equal(respuesta.status, 200);
    const cuerpo = await respuesta.json();
    const payload = decodificar(cuerpo.accessToken);
    assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "role", "sub"]);
    assert.equal(payload.sub, "E001");
    assert.equal(payload.role, "USER");
    assert.equal(payload.exp - payload.iat, 600);
    assert.ok(!("type" in payload));
    assert.ok(emisor.verificar(cuerpo.accessToken));
  });

  it("el ADMIN semilla recibe role ADMIN y su identificador como sub", async () => {
    const respuesta = await login({ email: "admin@talentflow.local", password: "admin-pass" });
    assert.equal(respuesta.status, 200);
    const payload = decodificar((await respuesta.json()).accessToken);
    assert.equal(payload.sub, "ADMIN");
    assert.equal(payload.role, "ADMIN");
  });

  it("el JWT nunca contiene la contraseña ni el hash", async () => {
    const respuesta = await login({ email: "ana@empresa.com", password: "clave-correcta" });
    const token = (await respuesta.json()).accessToken;
    const payload = Buffer.from(token.split(".")[1], "base64url").toString();
    assert.ok(!payload.includes("clave-correcta"));
    assert.ok(!payload.includes("scrypt"));
  });

  it("401 con el mismo mensaje: password incorrecta, email inexistente, INACTIVA y SUSPENDIDA_TEMPORAL", async () => {
    const casos = [
      { email: "ana@empresa.com", password: "mala" },
      { email: "nadie@empresa.com", password: "clave-correcta" },
      { email: "inactiva@empresa.com", password: "clave-correcta" },
      { email: "susp@empresa.com", password: "clave-correcta" },
      { email: "desactivada@empresa.com", password: "clave-correcta" }
    ];
    const mensajes = new Set();
    for (const caso of casos) {
      const respuesta = await login(caso);
      assert.equal(respuesta.status, 401, JSON.stringify(caso));
      mensajes.add((await respuesta.json()).message);
    }
    assert.equal(mensajes.size, 1);
  });

  it("400 si falta email o password", async () => {
    assert.equal((await login({ email: "ana@empresa.com" })).status, 400);
    assert.equal((await login({})).status, 400);
  });

  it("un token manipulado o vencido no verifica", () => {
    const token = emisor.emitir({ sub: "E001", role: "USER" });
    const [h, , f] = token.split(".");
    const falso = `${h}.${Buffer.from(JSON.stringify({ sub: "E001", role: "ADMIN", iat: 1, exp: 9999999999 })).toString("base64url")}.${f}`;
    assert.equal(emisor.verificar(falso), null);
    const vencido = crearEmisorJwt({ secreto: SECRETO, expiracionSegundos: 1, ahora: () => 0 }).emitir({ sub: "x", role: "USER" });
    assert.equal(emisor.verificar(vencido), null);
  });

});
