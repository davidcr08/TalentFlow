class AppError extends Error {
  constructor(mensaje, codigoEstado = 400, errores = []) {
    super(mensaje);
    this.name = "AppError";
    this.codigoEstado = codigoEstado;
    this.errores = errores;
  }
}

// Mensaje de broker malformado (JSON roto, faltan campos): reintentarlo no lo arregla, así que el
// consumidor lo rechaza sin reencolar. No consume el id de deduplicación.
class EventoInvalido extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "EventoInvalido";
  }
}

module.exports = { AppError, EventoInvalido };
