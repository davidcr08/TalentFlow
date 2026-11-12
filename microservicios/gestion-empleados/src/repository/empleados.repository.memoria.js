function crearRepositorioEmpleadosEnMemoria() {
  const empleados = new Map();

  return {
    guardar(empleado) {
      empleados.set(empleado.id, empleado);
      return empleado;
    },
    
    actualizar(id, empleado) {
      if (!empleados.has(id)) return null;
      empleados.set(id, { ...empleado, id });
      return empleados.get(id);
    },

    retirar(id) {
      const empleado = empleados.get(id);
      if (!empleado || empleado.estado === "RETIRADO") return null;
      const retirado = { ...empleado, estado: "RETIRADO", fechaRetiro: new Date().toISOString() };
      empleados.set(id, retirado);
      return retirado;
    },
    buscarPorId(id) {
      return empleados.get(id) ?? null;
    },

    buscarPorEmail(email) {
      const emailBuscado = email.toLowerCase();
      for (const empleado of empleados.values()) {
        if (empleado.email.toLowerCase() === emailBuscado) {
          return empleado;
        }
      }
      return null;
    },

    buscarPorNumeroEmpleado(numeroEmpleado) {
      for (const empleado of empleados.values()) {
        if (empleado.numeroEmpleado === numeroEmpleado) {
          return empleado;
        }
      }
      return null;
    },

    async listar(estado, desde, hasta) {
          let resultado = Array.from(empleados.values());

          if (estado) {
            const estadosValidos = ["ACTIVO", "EN_VACACIONES", "RETIRADO"];
            if (!estadosValidos.includes(estado)) {
              const { AppError } = require("../errores");
              throw new AppError(`El estado "${estado}" no es válido`, 400, [
                {
                  field: "estado",
                  message: "No es un estado válido",
                  rejectedValue: estado
                }
              ]);
            }
            resultado = resultado.filter((e) => e.estado === estado);
          }

          if (desde) {
            resultado = resultado.filter((e) => e.fechaRetiro && e.fechaRetiro >= desde);
          }

          if (hasta) {
            const hastaDate = new Date(`${hasta}T23:59:59.999Z`);
            resultado = resultado.filter((e) => e.fechaRetiro && new Date(e.fechaRetiro) <= hastaDate);
          }

          return resultado;
        },

    async listarPendientes() {
      return Array.from(empleados.values()).filter(
        (empleado) => empleado.validacionDepartamento === "PENDIENTE"
      );
    },

    async actualizarValidacionDepartamento(id, validacionDepartamento) {
      const empleado = empleados.get(id);
      if (empleado) {
        empleados.set(id, { ...empleado, validacionDepartamento });
      }
    }
  };
}

module.exports = { crearRepositorioEmpleadosEnMemoria };