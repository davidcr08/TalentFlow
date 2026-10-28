// RNF-05: política de contraseñas.
// SUPUESTO: el texto de RNF-05 no está en el repositorio. Se aplica una política estándar:
// 8 a 128 caracteres, con mayúscula, minúscula, dígito y carácter especial. Si RNF-05 define
// otra cosa, basta con ajustar este archivo: es el único lugar donde vive la regla.
const LONGITUD_MINIMA = 8;
const LONGITUD_MAXIMA = 128;

// Devuelve la lista de incumplimientos (vacía si la contraseña es válida).
function validarPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    return ["Es un campo obligatorio"];
  }
  const errores = [];
  if (password.length < LONGITUD_MINIMA) errores.push(`Debe tener al menos ${LONGITUD_MINIMA} caracteres`);
  if (password.length > LONGITUD_MAXIMA) errores.push(`No debe superar ${LONGITUD_MAXIMA} caracteres`);
  if (!/[A-Z]/.test(password)) errores.push("Debe incluir una letra mayúscula");
  if (!/[a-z]/.test(password)) errores.push("Debe incluir una letra minúscula");
  if (!/[0-9]/.test(password)) errores.push("Debe incluir un dígito");
  if (!/[^A-Za-z0-9]/.test(password)) errores.push("Debe incluir un carácter especial");
  return errores;
}

module.exports = { validarPassword, LONGITUD_MINIMA, LONGITUD_MAXIMA };
