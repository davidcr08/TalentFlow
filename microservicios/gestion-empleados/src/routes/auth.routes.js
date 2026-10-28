const { Router } = require("express");

function crearRouterAuth(servicioAuth) {
  const router = Router();

  // RF-01: POST /auth/login
  router.post("/auth/login", async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      res.status(200).json(await servicioAuth.login(email, password));
    } catch (error) {
      next(error);
    }
  });

  // RF-03: solicitud de recuperación de contraseña
  router.post("/auth/recover-password", async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    res.status(200).json(await servicioAuth.recuperarPassword(email));
  } catch (error) {
    next(error);
  }
  }); 

  // RF-04 / RF-05: restablecer contraseña con un token RESET_PASSWORD
  router.post("/auth/reset-password", async (req, res, next) => {
    try {
      const { token, newPassword } = req.body ?? {};
      res.status(200).json(await servicioAuth.resetPassword(token, newPassword));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { crearRouterAuth };
