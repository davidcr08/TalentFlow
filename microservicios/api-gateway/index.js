const express = require('express')
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;


//rf 06
const crypto = require("node:crypto");
const JWT_SECRET = process.env.JWT_SECRET;

// Empleados
const EMPLEADOS_URL = process.env.EMPLEADOS_SERVICE_URL || 'http://empleados-service:8081';
//Departamentos
const DEPARTAMENTOS_URL = process.env.DEPARTAMENTOS_SERVICE_URL || 'http://departamentos-service:8082';
//Perfiles
const PERFILES_URL = process.env.PERFILES_SERVICE_URL || 'http://perfiles-service:8083';
//Notificaciones
const NOTIFICACIONES_URL = process.env.NOTIFICACIONES_SERVICE_URL || 'http://notificaciones-service:8084';
//vacaciones    
const VACACIONES_URL = process.env.VACACIONES_SERVICE_URL || 'http://vacaciones-service:8085'

const TIMEOUT_HEALTH_MS = 2000;

// Consulta el /health interno de un servicio. Nunca lanza: si no responde a tiempo,
// o responde algo que no es JSON, lo reporta como DOWN con el motivo.
async function consultarSalud(url) {
    try {
        const respuesta = await fetch(`${url}/health`, { signal: AbortSignal.timeout(TIMEOUT_HEALTH_MS) });
        const cuerpo = await respuesta.json();
        return { status: cuerpo.status ?? 'DOWN', ...cuerpo.components };
    } catch (error) {
        return { status: 'DOWN', detalle: 'No responde' };
    }
}

// Salud propia del Gateway (siempre 200 mientras el Gateway esté vivo, por eso sirve
// para su healthcheck de Docker) + el estado de cada servicio y del Circuit Breaker,
// para ver todo el sistema desde la única URL base. "sistema" es OK solo si todo está
// UP y el circuito CLOSED; si no, DEGRADADO.
app.get('/health', async (req, res) => {
    const [empleados, departamentos] = await Promise.all([
        consultarSalud(EMPLEADOS_URL),
        consultarSalud(DEPARTAMENTOS_URL)
    ]);

    const todoOk =
        empleados.status === 'UP' &&
        departamentos.status === 'UP' &&
        empleados.circuitoDepartamentos === 'CLOSED';

    res.status(200).json({
        status: 'UP',
        service: 'api-gateway',
        timestamp: new Date().toISOString(),
        sistema: todoOk ? 'OK' : 'DEGRADADO',
        servicios: {
            'empleados-service': empleados,
            'departamentos-service': departamentos
        }
    });
});

const handleProxyError = (err, req, res) => {
    console.error(`[Gateway Error] ${err.message}`);
    res.status(503).json({
        error: 'Service Unavailable',
        message: 'El servicio solicitado no está disponible temporalmente',
        path: req.originalUrl
    });
};


//        PROXY
// Nota: se monta en '/' (sin prefijo) y se usa pathFilter en vez de mount-path,
// porque Express recorta el prefijo del mount antes de invocar el proxy y
// pathRewrite solo puede reponer un string fijo, rompiendo rutas con parámetros
// como /empleados/:id (verificado: producía /empleadosE001 en vez de /empleados/E001).

app.use(
    createProxyMiddleware({
        target: EMPLEADOS_URL,
        changeOrigin: true,
        pathFilter: ['/empleados'],
        on: { error: handleProxyError }
    })
);

// Auth (RF-01): POST /auth/login lo atiende empleados-service.
// RF-06: proteger únicamente el cambio de contraseña.
app.use(
    "/auth/change-password",
    (req, res, next) => {
        if (req.method !== "POST") {
            return res.status(404).json({
                error: "Not Found",
                message: "Ruta no encontrada"
            });
        }
        next();
    },
    verificarTokenAcceso
);

// El resto de las rutas de autenticación conserva su comportamiento.
app.use(
    createProxyMiddleware({
        target: EMPLEADOS_URL,
        changeOrigin: true,
        pathFilter: ["/auth"],
        on: { error: handleProxyError }
    })
);

app.use(
    createProxyMiddleware({
        target: DEPARTAMENTOS_URL,
        changeOrigin: true,
        pathFilter: ['/departamentos'],
        on: { error: handleProxyError }
    })
);

// RETO4
app.use(
    createProxyMiddleware({
        target: PERFILES_URL,
        changeOrigin: true,
        pathFilter: ['/perfiles'],
        on: { error: handleProxyError }
    })
);

app.use(
    createProxyMiddleware({
        target: NOTIFICACIONES_URL,
        changeOrigin: true,
        pathFilter: ['/notificaciones'],
        on: { error: handleProxyError }
    })
);

app.use(
    createProxyMiddleware({
        target: VACACIONES_URL,
        changeOrigin: true,
        pathFilter: ['/vacaciones'],
        on: { error: handleProxyError }
    })
); 

// Cualquier ruta fuera de /health, /empleados/* y /departamentos/*: 404 en JSON con el + las otras 3 proxys
// mismo formato que el 503, en vez de la página HTML por defecto de Express.
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: 'Ruta no enrutada por el API Gateway',
        path: req.originalUrl
    });
});

app.listen(PORT, () => {
    console.log(`API Gateway ejecutandose en el puerto ${PORT}`);
});


function verificarTokenAcceso(req, res, next) {
    const autorizacion = req.headers.authorization;

    if (!JWT_SECRET || JWT_SECRET.length < 32) {
        return res.status(500).json({
            error: "Error de configuración de autenticación"
        });
    }

    if (!autorizacion || !autorizacion.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Token de autenticación requerido"
        });
    }

    const partes = autorizacion.slice(7).split(".");
    if (partes.length !== 3) {
        return res.status(401).json({ error: "Token inválido o expirado" });
    }

    const [cabecera, payload, firma] = partes;

    try {
        const datosCabecera = JSON.parse(
            Buffer.from(cabecera, "base64url").toString("utf8")
        );

        if (datosCabecera.alg !== "HS256" || datosCabecera.typ !== "JWT") {
            return res.status(401).json({ error: "Token inválido o expirado" });
        }

        const firmaEsperada = crypto
            .createHmac("sha256", JWT_SECRET)
            .update(`${cabecera}.${payload}`)
            .digest();

        const firmaRecibida = Buffer.from(firma, "base64url");

        if (
            firmaEsperada.length !== firmaRecibida.length ||
            !crypto.timingSafeEqual(firmaEsperada, firmaRecibida)
        ) {
            return res.status(401).json({ error: "Token inválido o expirado" });
        }

        const datos = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8")
        );

        const ahora = Math.floor(Date.now() / 1000);

        if (
            typeof datos.sub !== "string" ||
            !datos.sub.trim() ||
            !Number.isFinite(datos.exp) ||
            datos.exp <= ahora ||
            !Number.isFinite(datos.iat) ||
            datos.iat > ahora
        ) {
            return res.status(401).json({ error: "Token inválido o expirado" });
        }

        // Nunca confiar en un sub enviado por el cliente.
        delete req.headers.sub;
        req.headers.sub = datos.sub;

        next();
    } catch {
        return res.status(401).json({ error: "Token inválido o expirado" });
    }
}
