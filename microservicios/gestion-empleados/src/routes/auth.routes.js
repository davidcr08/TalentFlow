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

  return router;
}

module.exports = { crearRouterAuth };
