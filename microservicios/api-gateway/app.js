const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { verificarAutorizacion, SECRETO_MINIMO } = require("./jwt");
const { eliminarCabecerasDeIdentidad, propagarIdentidad } = require("./identidad");
const { autorizar, MENSAJE_PROHIBIDO } = require("./autorizacion");

const TIMEOUT_HEALTH_MS = 2000;

/**
 * Tabla de rutas: dónde se enruta cada prefijo y qué rutas son públicas (RF-19 / RF-20). Todo lo
 * que NO figura como público exige un JWT de acceso válido y pasa por la autorización por rol
 * (RF-22 a RF-25, autorizacion.js).
 *   publicas: [[método, ruta exacta]]
 */
function crearTablaRutas(urls) {
  return [
    { prefijo: "/empleados", destino: urls.empleados },
    {
      prefijo: "/auth",
      destino: urls.empleados,
      publicas: [
        ["POST", "/auth/login"],
        ["POST", "/auth/recover-password"],
        ["POST", "/auth/reset-password"]
      ]
    },
    { prefijo: "/departamentos", destino: urls.departamentos },
    { prefijo: "/perfiles", destino: urls.perfiles },
    { prefijo: "/notificaciones", destino: urls.notificaciones },
    { prefijo: "/vacaciones", destino: urls.vacaciones }
  ];
}

const coincidePrefijo = (ruta, prefijo) => ruta === prefijo || ruta.startsWith(`${prefijo}/`);

const normalizar = (ruta) => (ruta.length > 1 && ruta.endsWith("/") ? ruta.slice(0, -1) : ruta);

function esPublica(regla, metodo, ruta) {
  return (regla.publicas ?? []).some(([m, r]) => m === metodo && r === ruta);
}

function respuestaError(res, status, error, message, req) {
  res.status(status).json({ error, message, path: req.originalUrl });
}

// Consulta el /health interno de un servicio. Nunca lanza: si no responde a tiempo,
// o responde algo que no es JSON, lo reporta como DOWN con el motivo.
async function consultarSalud(url) {
  try {
    const respuesta = await fetch(`${url}/health`, { signal: AbortSignal.timeout(TIMEOUT_HEALTH_MS) });
    const cuerpo = await respuesta.json();
    return { status: cuerpo.status ?? "DOWN", ...cuerpo.components };
  } catch (error) {
    return { status: "DOWN", detalle: "No responde" };
  }
}

function crearApp({ secreto, urls, ahora = () => Date.now(), logger = console }) {
  // Sin secreto válido el Gateway no arranca: nunca debe quedar sirviendo rutas sin proteger.
  if (typeof secreto !== "string" || secreto.length < SECRETO_MINIMO) {
    throw new Error(`JWT_SECRET es obligatorio y debe tener al menos ${SECRETO_MINIMO} caracteres`);
  }
  const rutas = crearTablaRutas(urls);
  const app = express();

  // Salud propia del Gateway (siempre 200 mientras el Gateway esté vivo, por eso sirve
  // para su healthcheck de Docker) + el estado de cada servicio y del Circuit Breaker.
  // Es pública: la usa Docker y no expone datos de negocio.
  app.get("/health", async (req, res) => {
    const [empleados, departamentos] = await Promise.all([
      consultarSalud(urls.empleados),
      consultarSalud(urls.departamentos)
    ]);
    const todoOk =
      empleados.status === "UP" && departamentos.status === "UP" && empleados.circuitoDepartamentos === "CLOSED";
    res.status(200).json({
      status: "UP",
      service: "api-gateway",
      timestamp: new Date().toISOString(),
      sistema: todoOk ? "OK" : "DEGRADADO",
      servicios: { "empleados-service": empleados, "departamentos-service": departamentos }
    });
  });

  // RF-19 / RF-20: autenticación y autorización centralizadas, antes de cualquier proxy.
  app.use((req, res, next) => {
    // RF-21: se borra primero, también en rutas públicas.
    eliminarCabecerasDeIdentidad(req.headers);

    const ruta = normalizar(req.path);
    const regla = rutas.find((r) => coincidePrefijo(ruta, r.prefijo));
    if (!regla) return next(); // ruta no enrutada: la atiende el 404 JSON del final

    // RF-06: change-password solo existe como POST.
    if (ruta === "/auth/change-password" && req.method !== "POST") {
      return respuestaError(res, 404, "Not Found", "Ruta no encontrada", req);
    }
    if (esPublica(regla, req.method, ruta)) return next();

    const resultado = verificarAutorizacion(req.headers.authorization, { secreto, ahora });
    if (!resultado.valido) {
      logger.warn?.(`[Gateway] 401 ${req.method} ${ruta}: ${resultado.motivo}`);
      return respuestaError(res, 401, "Unauthorized", resultado.mensaje, req);
    }

    const { sub, role } = resultado.payload;

    // RF-22 a RF-25: token válido pero sin permiso -> 403 (no 401).
    const decision = autorizar({ role, sub, metodo: req.method, ruta });
    if (!decision.permitido) {
      logger.warn?.(`[Gateway] 403 ${req.method} ${ruta}: rol=${role} sub=${sub}`);
      return respuestaError(res, 403, "Forbidden", MENSAJE_PROHIBIDO, req);
    }

    // RF-21: la identidad que ven los servicios es la del token, nunca la del cliente.
    propagarIdentidad(req.headers, { sub, role });
    next();
  });

  const manejarErrorProxy = (err, req, res) => {
    logger.error?.(`[Gateway Error] ${err.message}`);
    res.status(503).json({
      error: "Service Unavailable",
      message: "El servicio solicitado no está disponible temporalmente",
      path: req.originalUrl
    });
  };

  // Se monta en '/' y se filtra con pathFilter: Express recortaría el prefijo del mount y rompería
  // rutas con parámetros como /empleados/:id.
  for (const regla of rutas) {
    app.use(
      createProxyMiddleware({
        target: regla.destino,
        changeOrigin: true,
        pathFilter: (pathname) => coincidePrefijo(normalizar(pathname), regla.prefijo),
        on: { error: manejarErrorProxy }
      })
    );
  }

  // Cualquier otra ruta: 404 en JSON con el mismo formato que el 503.
  app.use((req, res) => respuestaError(res, 404, "Not Found", "Ruta no enrutada por el API Gateway", req));

  return app;
}

module.exports = { crearApp, crearTablaRutas };
