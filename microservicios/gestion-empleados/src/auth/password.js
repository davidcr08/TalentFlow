const crypto = require("node:crypto");

// Hash de contraseñas con scrypt (incluido en Node, sin dependencias).
// Formato almacenado: scrypt$<salt base64>$<hash base64>
const LONGITUD_CLAVE = 64;

function hashear(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, LONGITUD_CLAVE);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verificar(password, almacenado) {
  if (typeof password !== "string" || typeof almacenado !== "string") return false;
  const [esquema, saltB64, hashB64] = almacenado.split("$");
  if (esquema !== "scrypt" || !saltB64 || !hashB64) return false;
  const esperado = Buffer.from(hashB64, "base64");
  const calculado = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

module.exports = { hashear, verificar };
