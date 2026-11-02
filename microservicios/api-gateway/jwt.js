// RF-19 / RF-20: ÚNICA implementación de la validación del JWT de acceso (HS256, crypto nativo).
// Los microservicios NO validan JWT de acceso: confían en la identidad que propaga este Gateway
// (cabeceras x-user-id / x-user-role), porque ninguno publica puertos al host.
const crypto = require("node:crypto");

const SECRETO_MINIMO = 32;

const NO_AUTORIZADO = Object.freeze({
  FALTA_TOKEN: "Token de autenticación requerido",
  INVALIDO: "Token inválido o expirado"
});

const invalido = (motivo) => ({ valido: false, mensaje: NO_AUTORIZADO.INVALIDO, motivo });

function esObjetoPlano(valor) {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor);
}

/**
 * Devuelve { valido: true, payload } o { valido: false, mensaje, motivo }.
 * `motivo` es solo para logs y pruebas; al cliente se le devuelve `mensaje`, el mismo para todos
 * los fallos del token (no se revela por qué se rechazó).
 *
 * Es 401 cuando: falta la cabecera o no es "Bearer <token>", el token está mal formado, la firma
 * es inválida (o el token fue alterado), expiró, no trae el claim `role`, o trae el claim `type`
 * (los tokens de reset de contraseña llevan type: RESET_PASSWORD y no sirven como token de acceso).
 */
function verificarAutorizacion(cabeceraAutorizacion, { secreto, ahora = () => Date.now() }) {
  if (typeof secreto !== "string" || secreto.length < SECRETO_MINIMO) {
    throw new Error(`JWT_SECRET es obligatorio y debe tener al menos ${SECRETO_MINIMO} caracteres`);
  }

  if (typeof cabeceraAutorizacion !== "string" || !cabeceraAutorizacion.trim()) {
    return { valido: false, mensaje: NO_AUTORIZADO.FALTA_TOKEN, motivo: "sin-cabecera" };
  }
  const coincidencia = /^Bearer ([^\s]+)$/i.exec(cabeceraAutorizacion.trim());
  if (!coincidencia) return invalido("esquema-no-bearer");

  const partes = coincidencia[1].split(".");
  if (partes.length !== 3 || partes.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    return invalido("mal-formado");
  }
  const [cabecera, payload, firma] = partes;

  let datosCabecera;
  try {
    datosCabecera = JSON.parse(Buffer.from(cabecera, "base64url").toString("utf8"));
  } catch {
    return invalido("cabecera-ilegible");
  }
  // Solo HS256: rechaza alg "none" y cualquier otro algoritmo (ataque de confusión de algoritmo).
  if (!esObjetoPlano(datosCabecera) || datosCabecera.alg !== "HS256" || datosCabecera.typ !== "JWT") {
    return invalido("algoritmo");
  }

  const esperada = crypto.createHmac("sha256", secreto).update(`${cabecera}.${payload}`).digest();
  const recibida = Buffer.from(firma, "base64url");
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) {
    return invalido("firma");
  }

  let datos;
  try {
    datos = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return invalido("payload-ilegible");
  }
  if (!esObjetoPlano(datos)) return invalido("payload-no-objeto");

  const ahoraSegundos = Math.floor(ahora() / 1000);
  if (!Number.isFinite(datos.exp) || datos.exp <= ahoraSegundos) return invalido("expirado");
  if (!Number.isFinite(datos.iat) || datos.iat > ahoraSegundos) return invalido("iat");
  if (typeof datos.sub !== "string" || !datos.sub.trim()) return invalido("sin-sub");

  // RF-19: un token de acceso lleva `role` y nunca `type`.
  if (typeof datos.role !== "string" || !datos.role.trim()) return invalido("sin-role");
  if (Object.prototype.hasOwnProperty.call(datos, "type")) return invalido("trae-type");

  return { valido: true, payload: datos };
}

module.exports = { verificarAutorizacion, NO_AUTORIZADO, SECRETO_MINIMO };
