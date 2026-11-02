const { crearApp } = require("./app");

const PORT = process.env.PORT || 8080;

const urls = {
  empleados: process.env.EMPLEADOS_SERVICE_URL || "http://empleados-service:8081",
  departamentos: process.env.DEPARTAMENTOS_SERVICE_URL || "http://departamentos-service:8082",
  perfiles: process.env.PERFILES_SERVICE_URL || "http://perfiles-service:8083",
  notificaciones: process.env.NOTIFICACIONES_SERVICE_URL || "http://notificaciones-service:8084",
  vacaciones: process.env.VACACIONES_SERVICE_URL || "http://vacaciones-service:8085"
};

let app;
try {
  app = crearApp({ secreto: process.env.JWT_SECRET, urls });
} catch (error) {
  console.error(`[Gateway] ${error.message}`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`API Gateway ejecutandose en el puerto ${PORT}`);
});
