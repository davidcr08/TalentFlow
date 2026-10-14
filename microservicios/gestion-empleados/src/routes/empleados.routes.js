const { Router } = require("express");

function crearRouterEmpleados(servicioEmpleados) {
  const router = Router();

  router.post("/empleados", async (req, res, next) => {
    try {
      const empleado = await servicioEmpleados.registrar(req.body ?? {});
      res.status(201).location(`/empleados/${empleado.id}`).json(empleado);
    } catch (error) {
      next(error);
    }
  });

  
router.put("/empleados/:id", async (req, res, next) => {
  try {
    const empleado = await servicioEmpleados.actualizar(
      req.params.id,
      req.body ?? {}
    );

    res.status(200).json(empleado);
  } catch (error) {
    next(error);
  }
});



//reto 4

  
  router.delete("/empleados/:id", async (req, res, next) => {
    try {
      const empleado = await servicioEmpleados.retirar(req.params.id);
      res.status(200).json(empleado);
     } catch (error) {
      next(error);
    }
  });



  
  router.get("/empleados", async (req, res, next) => {
    try {
      const empleados = await servicioEmpleados.listar(req.query.estado);
      res.status(200).json(empleados);
    } catch (error) {
      next(error);
    }
  });



  router.get("/empleados/:id", async (req, res, next) => {
    try {
      const empleado = await servicioEmpleados.consultarPorId(req.params.id);
      res.status(200).json(empleado);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { crearRouterEmpleados };