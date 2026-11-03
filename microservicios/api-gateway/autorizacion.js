// RF-22 a RF-25: autorización por rol, en un único lugar. Función pura (sin I/O) para poder probarla.
const ROLES = Object.freeze({ ADMIN: "ADMIN", USER: "USER" });

const METODOS_LECTURA = Object.freeze(["GET"]);

const MENSAJE_PROHIBIDO = "No tiene permisos para realizar esta operación";

const normalizar = (ruta) => (ruta.length > 1 && ruta.endsWith("/") ? ruta.slice(0, -1) : ruta);

// Un solo segmento después de /perfiles/, decodificado. Devuelve null si no es exactamente
// /perfiles/{empleadoId} (p. ej. /perfiles/E001/otra o /perfiles/E001/../E002) o si el %-encoding es inválido.
function empleadoIdDePerfil(ruta) {
  const coincidencia = /^\/perfiles\/([^/]+)$/.exec(ruta);
  if (!coincidencia) return null;
  try {
    return decodeURIComponent(coincidencia[1]);
  } catch {
    return null;
  }
}

/**
 * RF-24: operaciones de escritura que un USER SÍ puede hacer, y solo sobre lo suyo.
 *  - POST /auth/change-password: siempre sobre su propia cuenta (el servicio usa X-User-Id, nunca un
 *    id del cuerpo), así que aquí no hay otro dueño posible.
 *  - PUT /perfiles/{empleadoId}: solo si empleadoId == sub.
 */
function esDuenioDelRecurso({ sub, metodo, ruta }) {
  if (metodo === "POST" && ruta === "/auth/change-password") return true;
  if (metodo === "PUT") {
    const empleadoId = empleadoIdDePerfil(ruta);
    return empleadoId !== null && empleadoId === sub;
  }
  return false;
}

/**
 * RF-25: orden de la regla.
 *   1. ADMIN                                  -> permite (RF-22, acceso total)
 *   2. USER con método de lectura (GET)       -> permite (RF-23)
 *   3. USER dueño del recurso                 -> permite (RF-24)
 *   4. cualquier otro caso (incluido un rol desconocido) -> 403, nunca 401
 * Devuelve { permitido: true, regla } o { permitido: false, regla: "denegado" }.
 */
function autorizar({ role, sub, metodo, ruta }) {
  const m = String(metodo).toUpperCase();
  const r = normalizar(ruta);

  if (role === ROLES.ADMIN) return { permitido: true, regla: "admin" };
  if (role === ROLES.USER && METODOS_LECTURA.includes(m)) return { permitido: true, regla: "user-lectura" };
  if (role === ROLES.USER && esDuenioDelRecurso({ sub, metodo: m, ruta: r })) {
    return { permitido: true, regla: "user-duenio" };
  }
  return { permitido: false, regla: "denegado" };
}

module.exports = { autorizar, ROLES, METODOS_LECTURA, MENSAJE_PROHIBIDO };
