// RF-14: el estado de una cuenta es un ENUM de cuatro valores, nunca un booleano (ni "activo" /
// "bloqueado" sueltos). Es la única definición: los servicios, los repositorios y el CHECK de la
// tabla `cuentas` (init.sql) usan estos mismos valores.
//
//   INACTIVA               cuenta creada (RF-09) que aún no definió su contraseña inicial
//   ACTIVA                 puede iniciar sesión
//   SUSPENDIDA_TEMPORAL    en vacaciones (RF-10); vuelve a ACTIVA con vacaciones.finalizadas (RF-11)
//   DESACTIVADA_PERMANENTE empleado retirado (RF-12); estado terminal, no se reactiva (RF-13)
const ESTADOS_CUENTA = Object.freeze({
  INACTIVA: "INACTIVA",
  ACTIVA: "ACTIVA",
  SUSPENDIDA_TEMPORAL: "SUSPENDIDA_TEMPORAL",
  DESACTIVADA_PERMANENTE: "DESACTIVADA_PERMANENTE"
});

const VALORES_ESTADO_CUENTA = Object.freeze(Object.values(ESTADOS_CUENTA));

function esEstadoCuenta(valor) {
  return typeof valor === "string" && VALORES_ESTADO_CUENTA.includes(valor);
}

// Rechaza cualquier valor fuera del enum (un booleano, null, un texto en minúsculas...) antes de
// que llegue a la base de datos. Es un error de programación, no de datos de un evento.
function validarEstadoCuenta(valor) {
  if (!esEstadoCuenta(valor)) {
    throw new TypeError(
      `Estado de cuenta inválido: ${JSON.stringify(valor)}. Valores permitidos: ${VALORES_ESTADO_CUENTA.join(", ")}`
    );
  }
  return valor;
}

module.exports = { ESTADOS_CUENTA, VALORES_ESTADO_CUENTA, esEstadoCuenta, validarEstadoCuenta };
