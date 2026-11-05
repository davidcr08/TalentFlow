const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { crearApp } = require("../src/app");
const { crearServicioEmpleados } = require("../src/services/empleados.service");
const { crearRepositorioEmpleadosEnMemoria } = require("../src/repository/empleados.repository.memoria");

const base = (n) => ({
  id: `E00${n}`,
  nombre: "Juan",
  apellido: "Pérez",
  email: `juan${n}@empresa.com`,
  numeroEmpleado: `EMP-2026-00${n}`,
  cargo: "Desarrollador",
  area: "Tecnología",
  departamentoId: "IT",
  fechaIngreso: "2026-02-10"
});

describe("RF-32 / RF-33: retiro de empleados y listado de retirados (API)", () => {
  let servidor;
  let url;
  let publicados;

  const llamar = (metodo, ruta, cuerpo) =>
    fetch(`${url}${ruta}`, {
      method: metodo,
      headers: { "Content-Type": "application/json" },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });

  before(async () => {
    const repositorio = crearRepositorioEmpleadosEnMemoria();
    const publicador = {
      publicar: async (tipo, data) => {
        publicados.push({ tipo, data });
      }
    };
    const servicio = crearServicioEmpleados(repositorio, { existe: async () => "EXISTE" }, publicador);
    servidor = await new Promise((resolve) => {
      const s = crearApp(servicio).listen(0, () => resolve(s));
    });
    url = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(() => servidor.close());

  beforeEach(async () => {
    publicados = [];
  });

  // Los empleados quedan creados entre pruebas (repositorio compartido); cada prueba usa ids distintos.
  const registrar = async (n) => {
    const r = await llamar("POST", "/empleados", base(n));
    assert.equal(r.status, 201);
    publicados.length = 0;
  };

  it("DELETE /empleados/{id} -> 200, estado RETIRADO y fechaRetiro registrada", async () => {
    await registrar(1);

    const r = await llamar("DELETE", "/empleados/E001", { motivo: "RENUNCIA" });

    assert.ok([200, 204].includes(r.status));
    const cuerpo = await r.json();
    assert.equal(cuerpo.estado, "RETIRADO");
    assert.ok(cuerpo.fechaRetiro);
    assert.ok(!Number.isNaN(Date.parse(cuerpo.fechaRetiro)));
  });

  it("publica empleado.retirado con empleadoId, email, fechaRetiro y motivo", async () => {
    await registrar(2);

    const r = await llamar("DELETE", "/empleados/E002", { motivo: "RENUNCIA" });
    const empleado = await r.json();

    assert.equal(publicados.length, 1);
    assert.equal(publicados[0].tipo, "empleado.retirado");
    assert.deepEqual(publicados[0].data, {
      empleadoId: "E002",
      email: "juan2@empresa.com",
      fechaRetiro: empleado.fechaRetiro,
      motivo: "RENUNCIA"
    });
  });

  it("sin cuerpo, el motivo se publica igual (NO_ESPECIFICADO)", async () => {
    await registrar(3);
    const r = await llamar("DELETE", "/empleados/E003");
    assert.equal(r.status, 200);
    assert.equal(publicados[0].data.motivo, "NO_ESPECIFICADO");
  });

  it("un motivo inválido responde 400 y no retira ni publica", async () => {
    await registrar(4);
    for (const motivo of ["", "   ", 5, { a: 1 }, "x".repeat(256)]) {
      const r = await llamar("DELETE", "/empleados/E004", { motivo });
      assert.equal(r.status, 400, JSON.stringify(motivo));
    }
    assert.equal(publicados.length, 0);
    assert.equal((await (await llamar("GET", "/empleados/E004")).json()).estado, "ACTIVO");
  });

  it("el retiro es lógico: el empleado sigue consultable, ahora RETIRADO", async () => {
    await registrar(5);
    await llamar("DELETE", "/empleados/E005");
    const r = await llamar("GET", "/empleados/E005");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).estado, "RETIRADO");
  });

  it("retirar dos veces: la segunda responde 400 y no republica", async () => {
    await registrar(6);
    assert.equal((await llamar("DELETE", "/empleados/E006")).status, 200);
    publicados.length = 0;
    assert.equal((await llamar("DELETE", "/empleados/E006")).status, 400);
    assert.equal(publicados.length, 0);
  });

  it("retirar un empleado inexistente responde 404", async () => {
    assert.equal((await llamar("DELETE", "/empleados/NO-EXISTE")).status, 404);
  });

  it("GET /empleados?estado=RETIRADO lista solo los retirados, con su fechaRetiro (RF-33)", async () => {
    const lista = await (await llamar("GET", "/empleados?estado=RETIRADO")).json();

    assert.ok(lista.length >= 4);
    for (const e of lista) {
      assert.equal(e.estado, "RETIRADO");
      assert.ok(e.fechaRetiro, `${e.id} debe traer fechaRetiro`);
    }
    const ids = lista.map((e) => e.id);
    assert.ok(ids.includes("E001") && ids.includes("E005"));
    assert.ok(!ids.includes("E004"), "E004 sigue ACTIVO");
  });

  it("GET /empleados?estado=ACTIVO no incluye a los retirados", async () => {
    const lista = await (await llamar("GET", "/empleados?estado=ACTIVO")).json();
    assert.ok(lista.every((e) => e.estado === "ACTIVO"));
    assert.ok(lista.some((e) => e.id === "E004"));
  });

  it("un estado desconocido responde 400", async () => {
    const r = await llamar("GET", "/empleados?estado=DESPEDIDO");
    assert.equal(r.status, 400);
  });

  it("sin filtro lista a todos, también a los retirados", async () => {
    const lista = await (await llamar("GET", "/empleados")).json();
    assert.ok(lista.some((e) => e.estado === "RETIRADO") && lista.some((e) => e.estado === "ACTIVO"));
  });
});
