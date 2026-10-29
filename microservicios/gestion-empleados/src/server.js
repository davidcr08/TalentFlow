const { crearApp } = require("./app");
const { crearServicioEmpleados } = require("./services/empleados.service");
const { crearRepositorioEmpleadosPostgres } = require("./repository/empleados.repository.postgres");
const { crearClienteDepartamentos } = require("./clients/departamentos.client");
const { crearPool } = require("./db/pool");
const { crearPublicadorEventos } = require("./events/publicador-eventos");
const { crearEmisorJwt } = require("./auth/jwt");
const { hashear } = require("./auth/password");
const { crearServicioAuth } = require("./services/auth.service");
const { crearManejadorEventosCuentas } = require("./services/cuentas-eventos.service");
const { crearConsumidorEventos } = require("./events/consumidor-eventos");
//rf-07
const {
  crearRepositorioCuentasPostgres,
  inicializarAdminSemilla
} = require("./repository/cuentas.repository.postgres");





const PUERTO = process.env.PORT || 8080;
const DEPARTAMENTOS_SERVICE_URL =
  process.env.DEPARTAMENTOS_SERVICE_URL || "http://localhost:8081";

const pool = crearPool();
const repositorio = crearRepositorioEmpleadosPostgres(pool);


const clienteDepartamentos = crearClienteDepartamentos({
  baseUrl: DEPARTAMENTOS_SERVICE_URL,
  timeoutMs: process.env.DEPARTAMENTOS_TIMEOUT_MS
    ? Number(process.env.DEPARTAMENTOS_TIMEOUT_MS)
    : 5000,
  maxReintentos: process.env.DEPARTAMENTOS_MAX_REINTENTOS
    ? Number(process.env.DEPARTAMENTOS_MAX_REINTENTOS)
    : 3
});


//RETO 4
const publicadorEventos = crearPublicadorEventos();
const servicio = crearServicioEmpleados(
  repositorio,
  clienteDepartamentos,
  publicadorEventos
);
// RF-01/RF-02: autenticación. El ADMIN semilla sale de variables de entorno (su
// contraseña se hashea al arrancar; nunca se guarda en claro). Los demás usuarios viven en
// la tabla `cuentas`.
const emisorJwt = crearEmisorJwt({
  secreto: process.env.JWT_SECRET,
  expiracionSegundos: process.env.JWT_EXPIRA_SEGUNDOS ? Number(process.env.JWT_EXPIRA_SEGUNDOS) : 3600
});
const repositorioCuentas = crearRepositorioCuentasPostgres(pool);

const servicioAuth = crearServicioAuth(
  repositorioCuentas,
  emisorJwt,
  null,
  publicadorEventos
);
/*
const app = crearApp(
  servicio,
  clienteDepartamentos,
  {
    verificarBaseDeDatos: () => pool.query("SELECT 1"),
    servicioAuth
  }
);
*/
// Cuando el Circuit Breaker vuelve a CERRAR (departamentos-service se restableció),
// revisa automáticamente a los empleados que quedaron PENDIENTE y los mueve a
// ACEPTADO o RECHAZADO según la respuesta real del servicio.
clienteDepartamentos.onRecuperado(() => {
  servicio
    .reconciliarPendientes()
    .then((resultados) => {
      if (resultados.length > 0) {
        console.info(`🔁 Reconciliados ${resultados.length} empleado(s) pendiente(s):`, resultados);
      }
    })
    .catch((error) => console.error("Error reconciliando empleados pendientes:", error));
});

async function iniciarServidor() {
  try {
    const adminId = process.env.ADMIN_ID || "ADMIN";
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      throw new Error(
        "Faltan las variables ADMIN_EMAIL o ADMIN_PASSWORD"
      );
    }

    await inicializarAdminSemilla(pool, {
      id: adminId,
      email: adminEmail,
      passwordHash: hashear(adminPassword)
    });

    console.log("Administrador semilla inicializado en PostgreSQL.");

    const app = crearApp(
      servicio,
      clienteDepartamentos,
      {
        verificarBaseDeDatos: () => pool.query("SELECT 1"),
        servicioAuth
      }
    );

    app.listen(PUERTO, () => {
      console.log(`Servicio de empleados escuchando en http://localhost:${PUERTO}`);
      console.log(`Documentación Swagger en http://localhost:${PUERTO}/docs`);
    });

    // RF-09/RF-10/RF-11: consume empleado.creado y vacaciones.iniciadas/finalizadas. Va al final,
    // con la BD y el administrador semilla ya listos; si el broker no está, reintenta solo.
    crearConsumidorEventos({
      manejador: crearManejadorEventosCuentas({
        repositorioCuentas,
        emisorJwt,
        publicadorEventos
      }).manejar
    }).iniciar();
  } catch (error) {
    console.error("Error al iniciar el servicio de empleados:", error);
    await pool.end();
    process.exit(1);
  }
}

iniciarServidor();