const { AppError } = require("../errores");


function filaAEmpleado(fila) {
  if (!fila) return null;

  return {
    id: fila.id,
    nombre: fila.nombre,
    apellido: fila.apellido,
    email: fila.email,
    numeroEmpleado: fila.numero_empleado,
    cargo: fila.cargo,
    area: fila.area,
    departamentoId: fila.departamento_id,
    fechaIngreso:
      fila.fecha_ingreso instanceof Date
        ? fila.fecha_ingreso.toISOString().slice(0, 10)
        : fila.fecha_ingreso,
    estado: fila.estado,
    fechaRetiro: fila.fecha_retiro
      ? fila.fecha_retiro.toISOString()
      : null,
    validacionDepartamento: fila.validacion_departamento
  };
}


function crearRepositorioEmpleadosPostgres(pool) {
  return {
    async guardar(empleado) {
      
      const texto = `
        INSERT INTO empleados
          (id, nombre, apellido, email, numero_empleado, cargo, area, departamento_id, fecha_ingreso, estado, validacion_departamento)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `;
      const valores = [
        empleado.id,
        empleado.nombre,
        empleado.apellido,
        empleado.email,
        empleado.numeroEmpleado,
        empleado.cargo,
        empleado.area,
        empleado.departamentoId,
        empleado.fechaIngreso,
        empleado.estado,
        empleado.validacionDepartamento ?? "ACEPTADO"
      ];
      try {
        const resultado = await pool.query(texto, valores);
        return filaAEmpleado(resultado.rows[0]);
      } catch (error) {
        if (error.code === "23505") {
          // Violación de restricción UNIQUE (red de seguridad ante condiciones de carrera:
          // dos peticiones simultáneas pasaron la verificación previa en el servicio).
          if (error.constraint?.includes("email")) {
            throw new AppError(`El email ${empleado.email} ya está registrado`, 400, [
              { field: "email", message: "Ya está registrado", rejectedValue: empleado.email }
            ]);
          }
          if (error.constraint?.includes("numero_empleado")) {
            throw new AppError(
              `El numeroEmpleado ${empleado.numeroEmpleado} ya está registrado`,
              400,
              [
                {
                  field: "numeroEmpleado",
                  message: "Ya está registrado",
                  rejectedValue: empleado.numeroEmpleado
                }
              ]
            );
          }
          throw new AppError(`El empleado con id ${empleado.id} ya existe`, 400, [
            { field: "id", message: "Ya está registrado", rejectedValue: empleado.id }
          ]);
        }
        throw error;
      }
    },
    
 async actualizar(id, empleado) {
  const texto = `
    UPDATE empleados
    SET nombre = $1,
        apellido = $2,
        email = $3,
        numero_empleado = $4,
        cargo = $5,
        area = $6,
        departamento_id = $7,
        fecha_ingreso = $8,
        estado = $9,
        validacion_departamento = $10
    WHERE id = $11
    RETURNING *
  `;

  const valores = [
    empleado.nombre,
    empleado.apellido,
    empleado.email,
    empleado.numeroEmpleado,
    empleado.cargo,
    empleado.area,
    empleado.departamentoId,
    empleado.fechaIngreso,
    empleado.estado,
    empleado.validacionDepartamento ?? "ACEPTADO",
    id
  ];

  try {
    const resultado = await pool.query(texto, valores);
    return filaAEmpleado(resultado.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      if (error.constraint?.includes("email")) {
        throw new AppError(`El email ${empleado.email} ya está registrado`, 400, [
          { field: "email", message: "Ya está registrado", rejectedValue: empleado.email }
        ]);
      }

      if (error.constraint?.includes("numero_empleado")) {
        throw new AppError(
          `El numeroEmpleado ${empleado.numeroEmpleado} ya está registrado`,
          400,
          [
            {
              field: "numeroEmpleado",
              message: "Ya está registrado",
              rejectedValue: empleado.numeroEmpleado
            }
          ]
        );
      }
    }

    throw error;
  }
},
 
async retirar(id) {
  const texto = `
    UPDATE empleados
    SET estado = 'RETIRADO',
        fecha_retiro = NOW()
    WHERE id = $1
      AND estado <> 'RETIRADO'
    RETURNING *
  `;

  const resultado = await pool.query(texto, [id]);
  return filaAEmpleado(resultado.rows[0]);
},



    async buscarPorId(id) {
      const resultado = await pool.query("SELECT * FROM empleados WHERE id = $1", [id]);
      return filaAEmpleado(resultado.rows[0]);
    },

    async buscarPorEmail(email) {
      const resultado = await pool.query(
        "SELECT * FROM empleados WHERE lower(email) = lower($1)",
        [email]
      );
      return filaAEmpleado(resultado.rows[0]);
    },

    async buscarPorNumeroEmpleado(numeroEmpleado) {
      const resultado = await pool.query(
        "SELECT * FROM empleados WHERE numero_empleado = $1",
        [numeroEmpleado]
      );
      return filaAEmpleado(resultado.rows[0]);
    },

    //Reto 4: Listar empleados pendientes de validación de departamento
      

async listar(estado, desde, hasta) {
  const estadosValidos = [
    "ACTIVO",
    "EN_VACACIONES",
    "RETIRADO"
  ];

  if (estado && !estadosValidos.includes(estado)) {
    throw new AppError(`El estado "${estado}" no es válido`, 400, [
      {
        field: "estado",
        message: "No es un estado válido",
        rejectedValue: estado
      }
    ]);
  }

  const validarFecha = (campo, valor) => {
    if (valor === undefined || valor === "") return;

    if (
      typeof valor !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(valor)
    ) {
      throw new AppError(
        `La fecha "${campo}" debe tener formato YYYY-MM-DD`,
        400,
        [
          {
            field: campo,
            message: "Formato inválido. Use YYYY-MM-DD",
            rejectedValue: valor
          }
        ]
      );
    }

    const fecha = new Date(`${valor}T00:00:00.000Z`);

    if (
      Number.isNaN(fecha.getTime()) ||
      fecha.toISOString().slice(0, 10) !== valor
    ) {
      throw new AppError(`La fecha "${campo}" no es válida`, 400, [
        {
          field: campo,
          message: "Fecha inexistente",
          rejectedValue: valor
        }
      ]);
    }
  };

  validarFecha("desde", desde);
  validarFecha("hasta", hasta);

  if (desde && hasta && desde > hasta) {
    throw new AppError("'desde' no puede ser posterior a 'hasta'", 400, [
      {
        field: "desde",
        message: "Debe ser anterior o igual a hasta",
        rejectedValue: desde
      }
    ]);
  }

  const condiciones = [];
  const valores = [];

  if (estado) {
    valores.push(estado);
    condiciones.push(`estado = $${valores.length}`);
  }

  if (desde) {
    valores.push(desde);
    condiciones.push(`fecha_retiro >= $${valores.length}::date`);
  }

  if (hasta) {
    valores.push(hasta);
    condiciones.push(
      `fecha_retiro < ($${valores.length}::date + INTERVAL '1 day')`
    );
  }

  const where = condiciones.length
    ? `WHERE ${condiciones.join(" AND ")}`
    : "";

  const resultado = await pool.query(
    `SELECT * FROM empleados ${where} ORDER BY creado_en ASC`,
    valores
  );

  return resultado.rows.map(filaAEmpleado);
},



    async listarPendientes() {
      const resultado = await pool.query(
        "SELECT * FROM empleados WHERE validacion_departamento = 'PENDIENTE' ORDER BY creado_en ASC"
      );
      return resultado.rows.map(filaAEmpleado);
    },

    async actualizarValidacionDepartamento(id, validacionDepartamento) {
      await pool.query("UPDATE empleados SET validacion_departamento = $1 WHERE id = $2", [
        validacionDepartamento,
        id
      ]);
    }
  };
}

module.exports = { crearRepositorioEmpleadosPostgres };