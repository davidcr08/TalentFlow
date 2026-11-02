const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");

const { crearApp } = require("../app");
const { verificarAutorizacion } = require("../jwt");

const SECRETO = "secreto-de-pruebas-con-mas-de-32-caracteres";
const AHORA = 1_700_000_000_000;
const SEG = Math.floor(AHORA / 1000);

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function firmar(cabecera, payload, secreto = SECRETO) {
  const c = typeof cabecera === "string" ? cabecera : b64(cabecera);
  const p = typeof payload === "string" ? payload : b64(payload);
  const f = crypto.createHmac("sha256", secreto).update(`${c}.${p}`).digest("base64url");
  return `${c}.${p}.${f}`;
}
const CAB = { alg: "HS256", typ: "JWT" };
const accesoValido = { sub: "E001", role: "USER", iat: SEG, exp: SEG + 3600 };
const token = (cambios = {}, quitar = []) => {
  const payload = { ...accesoValido, ...cambios };
  for (const k of quitar) delete payload[k];
  return firmar(CAB, payload);
};
const bearer = (t) => `Bearer ${t}`;

describe("RF-19: verificarAutorizacion (única implementación de la validación del JWT)", () => {
  const verificar = (cabecera) => verificarAutorizacion(cabecera, { secreto: SECRETO, ahora: () => AHORA });

  it("acepta un token de acceso válido", () => {
    const r = verificar(bearer(token()));
    assert.equal(r.valido, true);
    assert.equal(r.payload.sub, "E001");
    assert.equal(r.payload.role, "USER");
  });

  const rechazos = {
    "sin cabecera Authorization": undefined,
    "cabecera vacía": "",
    "esquema distinto de Bearer": `Basic ${token()}`,
    "Bearer sin token": "Bearer",
    "mal formado (no tiene tres partes)": bearer("abc.def"),
    "mal formado (caracteres inválidos)": bearer("a!b.c d.e"),
    "firma inválida (otro secreto)": bearer(firmar(CAB, accesoValido, "otro-secreto-distinto-de-mas-de-32-chars")),
    "alterado (payload cambiado, firma original)": (() => {
      const [c, , f] = token().split(".");
      return bearer(`${c}.${b64({ ...accesoValido, role: "ADMIN" })}.${f}`);
    })(),
    "expirado": bearer(token({ exp: SEG - 1 })),
    "expira justo ahora": bearer(token({ exp: SEG })),
    "sin claim role": bearer(token({}, ["role"])),
    "role vacío": bearer(token({ role: "  " })),
    "role no es texto": bearer(token({ role: 7 })),
    "trae el claim type (token de reset)": bearer(token({ type: "RESET_PASSWORD", ver: 1 })),
    "trae type aunque sea vacío": bearer(token({ type: "" })),
    "sin sub": bearer(token({}, ["sub"])),
    "sin exp": bearer(token({}, ["exp"])),
    "algoritmo none": bearer(`${b64({ alg: "none", typ: "JWT" })}.${b64(accesoValido)}.`),
    "alg none con firma falsa": bearer(`${b64({ alg: "none", typ: "JWT" })}.${b64(accesoValido)}.xxxx`),
    "alg distinto de HS256": bearer(firmar({ alg: "HS512", typ: "JWT" }, accesoValido)),
    "payload que no es un objeto": bearer(firmar(CAB, b64("[1,2]"))),
    "iat en el futuro": bearer(token({ iat: SEG + 600 }))
  };
  for (const [nombre, cabecera] of Object.entries(rechazos)) {
    it(`rechaza: ${nombre}`, () => {
      assert.equal(verificar(cabecera).valido, false);
    });
  }

  it("no revela el motivo al cliente: mismo mensaje para todos los fallos del token", () => {
    const mensajes = new Set(
      Object.entries(rechazos)
        .filter(([n]) => n !== "sin cabecera Authorization" && n !== "cabecera vacía")
        .map(([, c]) => verificar(c).mensaje)
    );
    assert.equal(mensajes.size, 1);
  });

  it("falta el token: mensaje propio", () => {
    assert.equal(verificar(undefined).mensaje, "Token de autenticación requerido");
  });

  it("sin secreto válido lanza (el Gateway no arranca desprotegido)", () => {
    assert.throws(() => verificarAutorizacion(bearer(token()), { secreto: "corto" }), /JWT_SECRET/);
    assert.throws(() => crearApp({ secreto: undefined, urls: {} }), /JWT_SECRET/);
  });
});

describe("RF-19 / RF-20: el Gateway protege los endpoints y propaga la identidad", () => {
  let upstream;
  let servidor;
  let base;
  let ultima; // última petición que llegó al servicio interno

  const llamar = (metodo, ruta, { headers = {}, cuerpo } = {}) =>
    fetch(`${base}${ruta}`, {
      method: metodo,
      headers: { "content-type": "application/json", ...headers },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });

  before(async () => {
    upstream = http.createServer((req, res) => {
      ultima = { metodo: req.method, url: req.url, headers: req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const destino = `http://127.0.0.1:${upstream.address().port}`;
    const urls = {
      empleados: destino,
      departamentos: destino,
      perfiles: destino,
      notificaciones: destino,
      vacaciones: destino
    };
    const app = crearApp({ secreto: SECRETO, urls, ahora: () => AHORA, logger: { warn() {}, error() {} } });
    servidor = http.createServer(app);
    await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    await new Promise((r) => servidor.close(r));
    await new Promise((r) => upstream.close(r));
  });

  const protegidas = [
    ["GET", "/empleados"],
    ["GET", "/empleados/E001"],
    ["POST", "/empleados"],
    ["DELETE", "/empleados/E001"],
    ["GET", "/departamentos"],
    ["POST", "/departamentos"],
    ["GET", "/perfiles/E001"],
    ["GET", "/notificaciones"],
    ["GET", "/notificaciones/E001"],
    ["GET", "/vacaciones"],
    ["POST", "/vacaciones"],
    ["POST", "/auth/change-password"],
    ["GET", "/empleados/circuito-departamentos"]
  ];

  for (const [metodo, ruta] of protegidas) {
    it(`${metodo} ${ruta} sin token -> 401 y no llega al servicio`, async () => {
      ultima = undefined;
      const r = await llamar(metodo, ruta);
      assert.equal(r.status, 401);
      const cuerpo = await r.json();
      assert.equal(cuerpo.error, "Unauthorized");
      assert.equal(cuerpo.message, "Token de autenticación requerido");
      assert.equal(cuerpo.path, ruta);
      assert.equal(ultima, undefined);
    });
  }

  it("401 con token alterado, expirado, sin role, o de reset (type) en un endpoint protegido", async () => {
    const [c, , f] = token().split(".");
    const malos = [
      `${c}.${b64({ ...accesoValido, role: "ADMIN" })}.${f}`,
      token({ exp: SEG - 10 }),
      token({}, ["role"]),
      token({ type: "RESET_PASSWORD", ver: 0 }, ["role"]),
      token({ type: "RESET_PASSWORD" }),
      "basura",
      firmar(CAB, accesoValido, "otro-secreto-distinto-de-mas-de-32-chars")
    ];
    for (const t of malos) {
      ultima = undefined;
      const r = await llamar("GET", "/empleados", { headers: { authorization: bearer(t) } });
      assert.equal(r.status, 401, t);
      assert.equal((await r.json()).message, "Token inválido o expirado");
      assert.equal(ultima, undefined);
    }
  });

  it("con un token válido pasa al servicio con la identidad del token", async () => {
    const r = await llamar("GET", "/empleados/E001?x=1", { headers: { authorization: bearer(token()) } });
    assert.equal(r.status, 200);
    assert.equal(ultima.url, "/empleados/E001?x=1");
    assert.equal(ultima.headers["x-user-id"], "E001");
    assert.equal(ultima.headers["x-user-role"], "USER");
    assert.equal(ultima.headers.sub, "E001");
  });

  it("la identidad enviada por el cliente se descarta y se sustituye por la del token", async () => {
    await llamar("GET", "/departamentos", {
      headers: {
        authorization: bearer(token({ sub: "E002", role: "USER" })),
        "x-user-id": "ADMIN",
        "x-user-role": "ADMIN",
        sub: "ADMIN"
      }
    });
    assert.equal(ultima.headers["x-user-id"], "E002");
    assert.equal(ultima.headers["x-user-role"], "USER");
    assert.equal(ultima.headers.sub, "E002");
  });

  it("también en rutas públicas se borran las cabeceras de identidad falsas", async () => {
    await llamar("POST", "/auth/login", {
      headers: { "x-user-id": "ADMIN", "x-user-role": "ADMIN", sub: "ADMIN" },
      cuerpo: { email: "a@b.c", password: "x" }
    });
    assert.equal(ultima.headers["x-user-id"], undefined);
    assert.equal(ultima.headers["x-user-role"], undefined);
    assert.equal(ultima.headers.sub, undefined);
  });

  for (const [metodo, ruta] of [
    ["POST", "/auth/login"],
    ["POST", "/auth/recover-password"],
    ["POST", "/auth/reset-password"]
  ]) {
    it(`${metodo} ${ruta} es público: llega al servicio sin token`, async () => {
      ultima = undefined;
      const r = await llamar(metodo, ruta, { cuerpo: { x: 1 } });
      assert.equal(r.status, 200);
      assert.equal(ultima.url, ruta);
    });
  }

  it("GET /health es público y lo atiende el propio Gateway", async () => {
    const r = await llamar("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).service, "api-gateway");
  });

  it("las rutas públicas de auth solo lo son con su método: GET /auth/login exige token", async () => {
    assert.equal((await llamar("GET", "/auth/login")).status, 401);
  });

  it("GET /auth/change-password -> 404 (solo existe como POST), con o sin token", async () => {
    assert.equal((await llamar("GET", "/auth/change-password")).status, 404);
    assert.equal(
      (await llamar("GET", "/auth/change-password", { headers: { authorization: bearer(token()) } })).status,
      404
    );
  });

  it("un prefijo parecido no queda protegido por accidente ni se enruta (/empleadosX -> 404)", async () => {
    assert.equal((await llamar("GET", "/empleadosX")).status, 404);
  });

  it("una ruta no enrutada responde 404 JSON del Gateway, con o sin token", async () => {
    const r = await llamar("GET", "/otra-cosa");
    assert.equal(r.status, 404);
    assert.equal((await r.json()).message, "Ruta no enrutada por el API Gateway");
  });

  it("si el servicio interno no responde: 503 JSON (con token válido)", async () => {
    const app = crearApp({
      secreto: SECRETO,
      urls: {
        empleados: "http://127.0.0.1:1",
        departamentos: "http://127.0.0.1:1",
        perfiles: "http://127.0.0.1:1",
        notificaciones: "http://127.0.0.1:1",
        vacaciones: "http://127.0.0.1:1"
      },
      ahora: () => AHORA,
      logger: { warn() {}, error() {} }
    });
    const s = http.createServer(app);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    try {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/empleados`, {
        headers: { authorization: bearer(token()) }
      });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, "Service Unavailable");
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});
