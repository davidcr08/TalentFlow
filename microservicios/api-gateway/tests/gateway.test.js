const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");

const { crearApp } = require("../app");
const { verificarAutorizacion } = require("../jwt");
const { autorizar } = require("../autorizacion");
const { CABECERA_USER_ID, CABECERA_USER_ROLE } = require("../identidad");

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
    assert.equal(ultima.headers[CABECERA_USER_ID.toLowerCase()], "E001");
    assert.equal(ultima.headers[CABECERA_USER_ROLE.toLowerCase()], "USER");
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
    assert.equal(ultima.headers.sub, undefined, "el sub heredado tampoco llega a los servicios");
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

  describe("RF-21: identidad por cabeceras", () => {
    it("las constantes son X-User-Id y X-User-Role", () => {
      assert.equal(CABECERA_USER_ID, "X-User-Id");
      assert.equal(CABECERA_USER_ROLE, "X-User-Role");
    });

    it("se descartan variantes de mayúsculas de las cabeceras falsas", async () => {
      await llamar("GET", "/empleados", {
        headers: {
          authorization: bearer(token({ sub: "E005", role: "USER" })),
          "X-User-Id": "ADMIN",
          "X-USER-ROLE": "ADMIN",
          "Sub": "ADMIN"
        }
      });
      assert.equal(ultima.headers["x-user-id"], "E005");
      assert.equal(ultima.headers["x-user-role"], "USER");
    });

    for (const ruta of ["/auth/login", "/auth/recover-password", "/auth/reset-password"]) {
      it(`ruta pública ${ruta}: no llegan cabeceras de identidad enviadas por el cliente`, async () => {
        await llamar("POST", ruta, {
          headers: { "X-User-Id": "ADMIN", "X-User-Role": "ADMIN", sub: "ADMIN" },
          cuerpo: { x: 1 }
        });
        assert.equal(ultima.headers["x-user-id"], undefined);
        assert.equal(ultima.headers["x-user-role"], undefined);
        assert.equal(ultima.headers.sub, undefined);
      });
    }

    it("con un token ADMIN el servicio recibe X-User-Role: ADMIN y el sub del token", async () => {
      await llamar("GET", "/empleados", { headers: { authorization: bearer(token({ sub: "ADMIN", role: "ADMIN" })) } });
      assert.equal(ultima.headers["x-user-id"], "ADMIN");
      assert.equal(ultima.headers["x-user-role"], "ADMIN");
    });
  });

  describe("RF-22 a RF-25: autorización por rol", () => {
    const admin = () => ({ authorization: bearer(token({ sub: "ADMIN", role: "ADMIN" })) });
    const user = (sub = "E001") => ({ authorization: bearer(token({ sub, role: "USER" })) });

    const escrituras = [
      ["DELETE", "/empleados/E001"],
      ["POST", "/empleados"],
      ["PUT", "/empleados/E001"],
      ["POST", "/departamentos"],
      ["DELETE", "/departamentos/IT"],
      ["POST", "/vacaciones"],
      ["POST", "/perfiles"],
      ["DELETE", "/perfiles/E001"],
      ["POST", "/notificaciones"]
    ];

    for (const [metodo, ruta] of escrituras) {
      it(`ADMIN: ${metodo} ${ruta} -> pasa al servicio (RF-22)`, async () => {
        ultima = undefined;
        const r = await llamar(metodo, ruta, { headers: admin() });
        assert.equal(r.status, 200);
        assert.equal(ultima.url, ruta);
      });

      it(`USER: ${metodo} ${ruta} -> 403, no llega al servicio (RF-23)`, async () => {
        ultima = undefined;
        const r = await llamar(metodo, ruta, { headers: user() });
        assert.equal(r.status, 403);
        const cuerpo = await r.json();
        assert.equal(cuerpo.error, "Forbidden");
        assert.equal(cuerpo.path, ruta);
        assert.equal(ultima, undefined);
      });
    }

    for (const ruta of ["/empleados", "/empleados/E002", "/departamentos", "/perfiles/E002", "/notificaciones", "/vacaciones"]) {
      it(`USER: GET ${ruta} -> pasa (lectura, RF-23)`, async () => {
        ultima = undefined;
        assert.equal((await llamar("GET", ruta, { headers: user() })).status, 200);
        assert.equal(ultima.url, ruta);
      });
    }

    it("USER: POST /auth/change-password -> pasa, con su propia identidad en X-User-Id (RF-24)", async () => {
      const r = await llamar("POST", "/auth/change-password", {
        headers: user("E007"),
        cuerpo: { currentPassword: "a", newPassword: "b", empleadoId: "E999", sub: "E999" }
      });
      assert.equal(r.status, 200);
      assert.equal(ultima.headers["x-user-id"], "E007");
    });

    it("USER: PUT /perfiles/{su id} -> 200 (RF-24)", async () => {
      ultima = undefined;
      const r = await llamar("PUT", "/perfiles/E001", { headers: user("E001"), cuerpo: { cargo: "x" } });
      assert.equal(r.status, 200);
      assert.equal(ultima.url, "/perfiles/E001");
    });

    it("USER: PUT /perfiles/{otro id} -> 403 y NO 401 (RF-24)", async () => {
      ultima = undefined;
      const r = await llamar("PUT", "/perfiles/E002", { headers: user("E001"), cuerpo: { cargo: "x" } });
      assert.equal(r.status, 403);
      assert.equal(ultima, undefined);
    });

    it("ADMIN: PUT /perfiles/{cualquier id} -> 200", async () => {
      assert.equal((await llamar("PUT", "/perfiles/E002", { headers: admin(), cuerpo: {} })).status, 200);
    });

    it("sin token sigue siendo 401 (no 403), también en rutas de escritura", async () => {
      assert.equal((await llamar("DELETE", "/empleados/E001")).status, 401);
      assert.equal((await llamar("PUT", "/perfiles/E001")).status, 401);
    });

    it("un rol desconocido solo con token válido recibe 403 hasta en lecturas", async () => {
      const r = await llamar("GET", "/empleados", { headers: { authorization: bearer(token({ role: "AUDITOR" })) } });
      assert.equal(r.status, 403);
    });

    it("las cabeceras falsas no dan permisos: un USER con X-User-Role: ADMIN sigue sin poder escribir", async () => {
      const r = await llamar("DELETE", "/empleados/E001", { headers: { ...user(), "X-User-Role": "ADMIN" } });
      assert.equal(r.status, 403);
    });
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

describe("RF-25: autorizar() — orden de la regla", () => {
  const caso = (role, metodo, ruta, sub = "E001") => autorizar({ role, sub, metodo, ruta });

  it("1) ADMIN: cualquier método y ruta", () => {
    for (const metodo of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const r = caso("ADMIN", metodo, "/empleados/E001");
      assert.equal(r.permitido, true);
      assert.equal(r.regla, "admin");
    }
    assert.equal(caso("ADMIN", "PUT", "/perfiles/E999", "ADMIN").permitido, true);
  });

  it("2) USER + GET: permite en cualquier ruta", () => {
    for (const ruta of ["/empleados", "/departamentos/IT", "/perfiles/E002", "/notificaciones", "/vacaciones/V1"]) {
      const r = caso("USER", "GET", ruta);
      assert.equal(r.permitido, true);
      assert.equal(r.regla, "user-lectura");
    }
    assert.equal(caso("USER", "get", "/empleados").permitido, true);
  });

  it("3) USER dueño: POST /auth/change-password y PUT /perfiles/{su id}", () => {
    assert.equal(caso("USER", "POST", "/auth/change-password").regla, "user-duenio");
    assert.equal(caso("USER", "PUT", "/perfiles/E001").regla, "user-duenio");
    assert.equal(caso("USER", "PUT", "/perfiles/E001/").permitido, true);
    assert.equal(caso("USER", "PUT", "/perfiles/%45001").permitido, true, "%45 = E");
  });

  it("4) cualquier otro caso: denegado", () => {
    const denegados = [
      ["USER", "PUT", "/perfiles/E002"],
      ["USER", "PUT", "/perfiles/e001"],
      ["USER", "PUT", "/perfiles/E001/otra"],
      ["USER", "PUT", "/perfiles/E001/../E002"],
      ["USER", "PUT", "/perfiles/E001%2F..%2FE002"],
      ["USER", "PUT", "/perfiles/%E0%A4%A"],
      ["USER", "PUT", "/perfiles"],
      ["USER", "PUT", "/empleados/E001"],
      ["USER", "PATCH", "/perfiles/E001"],
      ["USER", "DELETE", "/perfiles/E001"],
      ["USER", "DELETE", "/empleados/E001"],
      ["USER", "POST", "/empleados"],
      ["USER", "POST", "/departamentos"],
      ["USER", "POST", "/vacaciones"],
      ["USER", "POST", "/auth/reset-password-x"],
      ["USER", "PUT", "/auth/change-password"],
      ["USER", "HEAD", "/empleados"],
      ["AUDITOR", "GET", "/empleados"],
      [undefined, "GET", "/empleados"],
      [null, "DELETE", "/empleados/E001"]
    ];
    for (const [role, metodo, ruta] of denegados) {
      const r = caso(role, metodo, ruta);
      assert.equal(r.permitido, false, `${role} ${metodo} ${ruta}`);
      assert.equal(r.regla, "denegado");
    }
  });

  it("el id de /perfiles se compara con el sub, no con el cuerpo ni con otra fuente", () => {
    assert.equal(autorizar({ role: "USER", sub: "E002", metodo: "PUT", ruta: "/perfiles/E001" }).permitido, false);
    assert.equal(autorizar({ role: "USER", sub: "E002", metodo: "PUT", ruta: "/perfiles/E002" }).permitido, true);
  });
});
