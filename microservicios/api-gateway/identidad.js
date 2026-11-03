// RF-21: contrato de identidad entre el Gateway y los microservicios.
// Los nombres viven aquí, en constantes, y solo el Gateway los escribe.
const CABECERA_USER_ID = "X-User-Id"; // valor del claim `sub`
const CABECERA_USER_ROLE = "X-User-Role"; // valor del claim `role`

// Cabeceras de identidad que NINGÚN cliente puede enviar. `sub` es la que usaba el Gateway antes
// del RF-21; se sigue borrando por si algún cliente (o un servicio viejo) la envía.
const CABECERAS_IDENTIDAD_PROHIBIDAS = [CABECERA_USER_ID, CABECERA_USER_ROLE, "sub"].map((c) => c.toLowerCase());

// Node entrega los nombres de cabecera de la petición entrante en minúsculas.
const clave = (cabecera) => cabecera.toLowerCase();

/** Borra de la petición cualquier cabecera de identidad enviada por el cliente (rutas públicas incluidas). */
function eliminarCabecerasDeIdentidad(headers) {
  for (const cabecera of CABECERAS_IDENTIDAD_PROHIBIDAS) delete headers[cabecera];
}

/** Escribe la identidad VERIFICADA del token: X-User-Id = sub, X-User-Role = role. */
function propagarIdentidad(headers, { sub, role }) {
  headers[clave(CABECERA_USER_ID)] = sub;
  headers[clave(CABECERA_USER_ROLE)] = role;
}

module.exports = {
  CABECERA_USER_ID,
  CABECERA_USER_ROLE,
  CABECERAS_IDENTIDAD_PROHIBIDAS,
  eliminarCabecerasDeIdentidad,
  propagarIdentidad
};
