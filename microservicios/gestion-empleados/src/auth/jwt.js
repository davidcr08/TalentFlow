const crypto = require("node:crypto");

// JWT de acceso HS256 implementado con crypto nativo.
// RF-02: el payload contiene SOLO sub, role, iat y exp. No lleva "type" ni datos sensibles
// (nunca la contraseña ni su hash).
const SECRETO_MINIMO = 32;

// RF-04/RF-05: tipo de los tokens de reset (activación inicial y recuperación). Ambos llevan
// el mismo type; el servicio los distingue por el estado de la cuenta, no por el token.
const TIPO_RESET_PASSWORD = "RESET_PASSWORD";


// RF-08
const EXPIRACION_ACTIVACION_SEGUNDOS =
  Number(process.env.JWT_ACTIVACION_EXPIRA_SEGUNDOS) || 24 * 60 * 60;

const EXPIRACION_RECUPERACION_SEGUNDOS =
  Number(process.env.JWT_RECUPERACION_EXPIRA_SEGUNDOS) || 30 * 60;


const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

function crearEmisorJwt({ secreto, expiracionSegundos = 3600, ahora = () => Date.now() }) {
  if (typeof secreto !== "string" || secreto.length < SECRETO_MINIMO) {
    throw new Error(`JWT_SECRET es obligatorio y debe tener al menos ${SECRETO_MINIMO} caracteres`);
  }

  function firmar(datos) {
    return crypto.createHmac("sha256", secreto).update(datos).digest("base64url");
  }

  return {
    expiracionSegundos,

    emitir({ sub, role }) {
      const iat = Math.floor(ahora() / 1000);
      const cabecera = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = b64url(JSON.stringify({ sub, role, iat, exp: iat + expiracionSegundos }));
      return `${cabecera}.${payload}.${firmar(`${cabecera}.${payload}`)}`;
    },

    // Token de un solo uso lógico: `ver` es la versión de tokens de la cuenta al emitirlo; al
    // hacer el reset la cuenta incrementa su versión y el token queda obsoleto.
    emitirReset({
     sub,
     version,
     tipoUso = "RECUPERACION",
       expiracionSegundosReset
           }) {
              const iat = Math.floor(ahora() / 1000);
              const duracion = expiracionSegundosReset ??
                               (tipoUso === "ACTIVACION"
                               ? EXPIRACION_ACTIVACION_SEGUNDOS
                               : EXPIRACION_RECUPERACION_SEGUNDOS);

                const cabecera = b64url(
                JSON.stringify({ alg: "HS256", typ: "JWT" })
                );

         const payload = b64url(
         JSON.stringify({
         sub,
         type: TIPO_RESET_PASSWORD,
         ver: version,
         iat,
         exp: iat + duracion
         })
  );

  return `${cabecera}.${payload}.${firmar(`${cabecera}.${payload}`)}`;
},

    // Devuelve el payload si la firma y la vigencia son válidas; null en otro caso.
    verificar(token) {
      if (typeof token !== "string") return null;
      const partes = token.split(".");
      if (partes.length !== 3) return null;
      const [cabecera, payload, firma] = partes;
      const esperada = Buffer.from(firmar(`${cabecera}.${payload}`));
      const recibida = Buffer.from(firma);
      if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) {
        return null;
      }
      try {
        const datos = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return datos.exp > Math.floor(ahora() / 1000) ? datos : null;
      } catch {
        return null;
      }
    }
  };
}

module.exports = {
  crearEmisorJwt,
  TIPO_RESET_PASSWORD,
  EXPIRACION_ACTIVACION_SEGUNDOS,
  EXPIRACION_RECUPERACION_SEGUNDOS
};
