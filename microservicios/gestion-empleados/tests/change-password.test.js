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

// RF-21 / RF-24: el servicio no valida el JWT (lo hace el Gateway); solo confía en X-User-Id y
// cambia SIEMPRE la contraseña de esa cuenta, nunca la de un id que venga en el cuerpo.
describe("POST /auth/change-password con la identidad del Gateway (RF-21 / RF-24)", () => {
  let servidor;
  let baseUrl;
  let servicioAuth;

  before(async () => {
    const cuentas = crearRepositorioCuentasEnMemoria();
    cuentas.agregar({ email: "ana@empresa.com", empleadoId: "E001", passwordHash: hashear("ClaveVieja#1") });
    cuentas.agregar({ email: "luis@empresa.com", empleadoId: "E002", passwordHash: hashear("ClaveVieja#1") });
    const emisor = crearEmisorJwt({ secreto: SECRETO, expiracionSegundos: 600 });
    const admin = { id: "ADMIN", email: "admin@talentflow.local", passwordHash: hashear("admin-pass") };
    servicioAuth = crearServicioAuth(cuentas, emisor, admin);
    const servicio = crearServicioEmpleados(crearRepositorioEmpleadosEnMemoria(), { existe: async () => "EXISTE" });
    const app = crearApp(servicio, undefined, { servicioAuth });
    servidor = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(() => servidor.close());

  const cambiar = (headers, cuerpo) =>
    fetch(`${baseUrl}/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(cuerpo)
    });

  const puedeIniciarSesion = async (email, password) => {
    try {
      await servicioAuth.login(email, password);
      return true;
    } catch {
      return false;
    }
  };

  it("sin X-User-Id no cambia nada (no llegó por el Gateway)", async () => {
    const r = await cambiar({}, { currentPassword: "ClaveVieja#1", newPassword: "ClaveNueva#2026" });
    assert.notEqual(r.status, 200);
    assert.equal(await puedeIniciarSesion("ana@empresa.com", "ClaveVieja#1"), true);
  });

  it("la cabecera sub heredada ya no se usa como identidad", async () => {
    const r = await cambiar({ sub: "E001" }, { currentPassword: "ClaveVieja#1", newPassword: "ClaveNueva#2026" });
    assert.notEqual(r.status, 200);
    assert.equal(await puedeIniciarSesion("ana@empresa.com", "ClaveVieja#1"), true);
  });

  it("con X-User-Id cambia la contraseña de esa cuenta, aunque el cuerpo nombre a otra", async () => {
    const r = await cambiar(
      { "X-User-Id": "E001" },
      { currentPassword: "ClaveVieja#1", newPassword: "ClaveNueva#2026", empleadoId: "E002", sub: "E002" }
    );
    assert.equal(r.status, 200);
    assert.equal(await puedeIniciarSesion("ana@empresa.com", "ClaveNueva#2026"), true);
    assert.equal(await puedeIniciarSesion("ana@empresa.com", "ClaveVieja#1"), false);
    // la cuenta que el cuerpo intentaba apuntar no cambió
    assert.equal(await puedeIniciarSesion("luis@empresa.com", "ClaveVieja#1"), true);
  });
});
