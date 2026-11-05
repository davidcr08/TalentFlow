# Eventos — TalentFlow

Documento vivo. La fuente de verdad de nombres, productores, consumidores y cargas útiles es el
**Catálogo de Eventos** (`catalogo-de-eventos.docx`); este archivo solo registra lo implementado.

## Topología del broker (RabbitMQ)

| Elemento | Valor |
|---|---|
| Exchange | `talentflow.events` — tipo `topic`, durable (lo declara cada servicio al conectar) |
| Routing key | el nombre del evento: `empleado.creado`, `vacaciones.programadas`, ... |
| Mensaje | JSON con el envelope `id, type, version, occurredAt, producer, data`; `delivery_mode=2`; `message_id` = `id` |
| Colas | una durable por servicio consumidor (abajo) |

> **Contrato para `empleados-service`:** publicar en el exchange `talentflow.events` con
> routing key = `type`. Variables: `BROKER_URL`, `BROKER_EXCHANGE`.

## Implementados

| Evento | Productor | Consumidores (cola) | Reto |
|---|---|---|---|
| `empleado.creado` | empleados-service  ✅ | perfiles (`perfiles-service.q`), notificaciones (`notificaciones-service.q`, **solo traza**, RF-18), vacaciones (`vacaciones-service.q`), **empleados** (`empleados-service.q`, RF-09) | 4 / 5 |
| `empleado.actualizado` | empleados-service  ✅ | perfiles | 4 |
| `empleado.retirado` | empleados-service  ✅ | perfiles, notificaciones (**solo traza**, RF-18), vacaciones, **empleados** (`empleados-service.q`, RF-12) | 4 / 5 |
| `vacaciones.programadas` | **vacaciones-service** ✅ | notificaciones | 4 |
| `usuario.creado` | empleados-service ✅ | notificaciones (`notificaciones-service.q`, RF-16 y RF-18) | 5 |
| `cuenta.activada` | empleados-service ✅ | notificaciones (RF-17) | 5 |
| `usuario.recuperacion` | empleados-service ✅ | notificaciones (RF-16) | 5 |
| `cuenta.desactivada` | empleados-service ✅ | notificaciones (RF-17) | 5 |
| `vacaciones.iniciadas` | **vacaciones-service** ✅ (RF-27) | empleados (`empleados-service.q`) | 5 |
| `vacaciones.finalizadas` | **vacaciones-service** ✅ (RF-28) | empleados (`empleados-service.q`) | 5 |

Reacciones: ver README raíz, sección *Reto 4*.

### Desviación documentada respecto del Catálogo

`vacaciones-service` consume también `empleado.creado` y `empleado.retirado`, que en el catálogo
(3.1, 3.3) no lo listan como consumidor. Es la opción (b) del enunciado (réplica local), que el
Reto 4 permite explícitamente. **Pendiente:** agregar a `vacaciones-service` como consumidor en
el catálogo (la regla del catálogo es "se agrega aquí primero").

### Nota sobre la bienvenida

El enunciado del Reto 4 pide que `notificaciones-service` registre la BIENVENIDA al consumir
`empleado.creado`. El catálogo indica que, desde el Reto 5, la bienvenida pasa a dispararse con
`usuario.creado` (que trae el token de activación). Se sigue el enunciado del Reto 4 y habrá que
moverlo en el Reto 5.

## Deduplicación (catálogo 2.1)

Cada consumidor tiene su propia tabla `eventos_procesados(id, procesado_en)`. El `INSERT` del id y el
efecto del evento van en **la misma transacción**: duplicado → no inserta → se confirma (ack) sin repetir
el efecto; si el efecto falla → se deshace también el id → la reentrega reintenta.

Política de confirmación (igual en los tres servicios):

| Situación | Acción |
|---|---|
| procesado / duplicado / evento ajeno | `ack` |
| mensaje inválido (JSON roto, faltan campos) | `reject` sin reencolar (la DLQ formal es del Reto 29) |
| fallo transitorio (p. ej. BD caída) | pausa de 2 s y `nack` con reencolado |

## Carga de los eventos de empleado

`empleados-service` publica solo los campos del catálogo (3.1 a 3.3), con `empleadoId` (copia de `id`):

| Evento | `data` |
|---|---|
| `empleado.creado` / `empleado.actualizado` | `empleadoId, nombre, apellido, email, cargo, area, departamentoId` |
| `empleado.retirado` | `empleadoId, email, fechaRetiro` (+ `motivo` si el `DELETE` lo trae en el cuerpo) |

Sin `empleadoId` y `email` los consumidores rechazan el mensaje como inválido.

### `cuenta.activada` (Reto 5, RF-05 y RF-11)

`data`: `empleadoId, email, motivo`. Dos orígenes: `POST /auth/reset-password` al activar una cuenta `INACTIVA`
(`motivo` = `ACTIVACION_INICIAL`) y el consumo de `vacaciones.finalizadas` (`motivo` = `FIN_VACACIONES`).
**Pendiente:** contrastar la carga con el Catálogo de Eventos, que no está en el repositorio.

### Eventos de cuentas (Reto 5, RF-09 a RF-14)

`empleados-service` actúa también como servicio de autenticación y consume, en la cola durable `empleados-service.q`
(routing keys `empleado.creado`, `empleado.retirado`, `vacaciones.iniciadas`, `vacaciones.finalizadas`):

| Consume | Efecto sobre la cuenta | Publica (`data`) |
|---|---|---|
| `empleado.creado` | Crea la cuenta `INACTIVA`, rol `USER`, sin contraseña válida. Si ya existe cuenta con ese `empleadoId` o `email` (o el email es el del admin semilla): se ignora con log. | `usuario.creado`: `empleadoId, email, tokenActivacion, expiraEn` |
| `vacaciones.iniciadas` | `ACTIVA` → `SUSPENDIDA_TEMPORAL`. Cualquier otro estado (o sin cuenta): se ignora con log. | `cuenta.desactivada`: `empleadoId, email, motivo: "VACACIONES", permanente: false` |
| `vacaciones.finalizadas` | Solo `SUSPENDIDA_TEMPORAL` → `ACTIVA`. Cualquier otro estado: se ignora con log. **RF-13 (caso borde):** sobre una cuenta `DESACTIVADA_PERMANENTE` se ignora con log y **no** se reactiva. | `cuenta.activada`: `empleadoId, email, motivo: "FIN_VACACIONES"` |
| `empleado.retirado` (RF-12) | Si la cuenta no está ya `DESACTIVADA_PERMANENTE`, pasa a ese estado desde cualquier otro (`INACTIVA`, `ACTIVA`, `SUSPENDIDA_TEMPORAL`). Si ya lo estaba (o no hay cuenta): se ignora con log, **sin republicar**. | `cuenta.desactivada`: `empleadoId, email, motivo: "RETIRO", permanente: true` |

- Las reacciones de vacaciones solo miran el **estado de la cuenta**; nunca consultan el estado del empleado.
- **RF-14**: el estado de la cuenta es un enum (`INACTIVA`, `ACTIVA`, `SUSPENDIDA_TEMPORAL`, `DESACTIVADA_PERMANENTE`) definido en
  `src/dominio/cuenta.js`, respaldado por el `CHECK` de la columna `cuentas.estado`; nunca un booleano. `DESACTIVADA_PERMANENTE` es terminal:
  solo se sale de él con una intervención manual en la BD, nunca por un evento.
- `tokenActivacion` es el mismo JWT `RESET_PASSWORD` de `POST /auth/reset-password` (vigencia `JWT_ACTIVACION_EXPIRA_SEGUNDOS`,
  24 h por defecto); `expiraEn` es su `exp` en ISO-8601 UTC.
- Mensajes con `data.empleadoId` (y `data.email` en `empleado.creado`) ausente → inválidos: `reject` sin reencolar.
- **Orden de operaciones**: el id del evento, el cambio de la cuenta **y la publicación del evento de salida** van en una sola
  transacción. Si el broker rechaza la publicación se hace `ROLLBACK` y el mensaje se reintenta, de modo que el token de activación
  no se pierde en silencio. Contrapartida: si el `COMMIT` falla justo después de publicar, el reintento publica de nuevo
  (al menos una vez; los consumidores deduplican por `id`).
- `vacaciones.iniciadas` y `vacaciones.finalizadas` los publica la tarea periódica de `vacaciones-service` (ver más abajo, RF-27 a RF-30).

### Notificaciones (Reto 5, RF-16 a RF-18)

`notificaciones-service` (`notificaciones-service.q`) consume, además de `vacaciones.programadas`:

| Consume | Notificación (log `[NOTIFICACIÓN] Tipo: … \| Para: … \| Mensaje: …`) |
|---|---|
| `usuario.creado` | **`BIENVENIDA`** (RF-18) y **`SEGURIDAD`** (RF-16) con el enlace y el token de activación (`tokenActivacion`). |
| `usuario.recuperacion` | **`SEGURIDAD`** con el enlace y el token de recuperación (`tokenRecuperacion`). El evento no trae `empleadoId`, así que la notificación se guarda sin él. |
| `cuenta.activada` | **`CUENTA`**: `ACTIVACION_INICIAL` → cuenta activada, ya puede iniciar sesión; `FIN_VACACIONES` → cuenta reactivada. |
| `cuenta.desactivada` | **`CUENTA`**: `VACACIONES` → suspensión temporal; `RETIRO` → **correo de despedida** (cuenta desactivada de forma permanente). Un motivo desconocido usa un mensaje genérico según `permanente`. |
| `empleado.creado`, `empleado.retirado` | Solo una traza en el log (`[TRAZA] …`; catálogo 3.1 y 3.3). **Ya no** envían bienvenida ni desvinculación (quedaron del Reto 4). |

- El enlace es `ENLACE_RESET_PASSWORD` + `?token=<token>` (por defecto `http://localhost:8080/auth/reset-password`).
- **El token solo se escribe en el log del envío; no se guarda.** El mensaje guardado (el que devuelve `GET /notificaciones`) dice únicamente que se
  envió un enlace, porque cualquiera con acceso a esa API podría usar el token para apropiarse de la cuenta.
- Un evento puede producir varias notificaciones (`usuario.creado`: dos); el id del evento se registra una vez, todas se guardan en la misma
  transacción y la unicidad en BD es `(evento_id, tipo)`.
- `DESVINCULACION` ya no se genera; se conserva en el `CHECK` y en el enum solo para leer las filas del Reto 4.
- En volúmenes ya creados `init.sql` no se reejecuta: aplique a mano el bloque `ALTER TABLE notificaciones …` o use `docker compose down -v`.

### Scheduler de vacaciones (Reto 5, RF-27 a RF-30)

`vacaciones-service` ejecuta una tarea periódica (`app/scheduler.py`) que llama a `VacacionesService.ejecutar_transiciones()`:

| Paso | Busca | Hace | Publica (`data`) |
|---|---|---|---|
| 1 (RF-27) | `PROGRAMADA` con `fechaInicio <= hoy` | → `EN_CURSO` | `vacaciones.iniciadas`: `vacacionesId, empleadoId, email, fechaInicio, fechaFin` |
| 2 (RF-28) | `EN_CURSO` con `fechaFin < hoy` | → `FINALIZADA` | `vacaciones.finalizadas`: `vacacionesId, empleadoId, email, fechaFin` |

- Las vacaciones **incluyen** el día `fechaFin`: el último día sigue `EN_CURSO` y se cierra al día siguiente. "Hoy" es la fecha en `TZ_NEGOCIO`
  (`America/Bogota`), no la UTC.
- El orden es siempre iniciar y luego finalizar: un período con las fechas ya pasadas por completo (p. ej. el servicio estuvo caído) sale en
  la misma pasada con `iniciadas` y después `finalizadas`, así la cuenta se suspende y se reactiva en ese orden.
- **Frecuencia (RF-29)**: `SCHEDULER_INTERVALO_SEGUNDOS` (por defecto `60`; `0` la desactiva). Primera pasada al arrancar.
- **No se pierde ningún evento**: cada transición bloquea la fila, publica y recién entonces confirma. Si el broker falla se revierte y el
  período conserva su estado, así que la siguiente pasada lo reintenta. Si el `COMMIT` fallara justo después de publicar, el reintento
  republica con otro `id`; `empleados-service` lo tolera porque decide por el estado de la cuenta (RF-10 / RF-11 / RF-13).
- Dos pasadas simultáneas (o dos instancias) no duplican: la segunda ve el estado ya cambiado.
- Un período que falla (p. ej. sin réplica del empleado) no impide procesar los demás.

**Estrategia de prueba (RF-30)** — para no esperar a las fechas reales:

| Endpoint | Efecto | Errores |
|---|---|---|
| `POST /vacaciones/{id}/forzar-inicio` | `PROGRAMADA` → `EN_CURSO` + `vacaciones.iniciadas`, **ignorando las fechas** | 404 no existe · 409 no está `PROGRAMADA` · 503 no se pudo publicar |
| `POST /vacaciones/{id}/forzar-fin` | `EN_CURSO` → `FINALIZADA` + `vacaciones.finalizadas`, **ignorando las fechas** | 404 · 409 no está `EN_CURSO` · 503 |

- Solo existen con `ENDPOINTS_DESARROLLO_HABILITADOS=true` (por defecto `false`: la ruta responde 404 y ni aparece en Swagger). Al estar
  habilitados salen en Swagger con la etiqueta *Desarrollo (no usar en producción)* y el prefijo `[DESARROLLO]`.
- **Solo ADMIN**: lo aplica el Gateway (cualquier `POST` de un `USER` recibe 403); el servicio no repite esa validación.
- Reutilizan `VacacionesService.transicionar()`, la misma función que usa el scheduler (con `forzar=True`).
- Prueba de punta a punta sin esperar fechas:

```bash
# habilitar: ENDPOINTS_DESARROLLO_HABILITADOS=true en .env, luego `docker compose up -d --build vacaciones-service`
TOKEN=$(curl -s -X POST localhost:8080/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<admin>","password":"<clave>"}' | jq -r .token)   # el nombre del campo puede variar: ver la respuesta
curl -X POST localhost:8080/vacaciones/V-2026-0001/forzar-inicio -H "Authorization: Bearer $TOKEN"   # cuenta -> SUSPENDIDA_TEMPORAL
curl -X POST localhost:8080/vacaciones/V-2026-0001/forzar-fin    -H "Authorization: Bearer $TOKEN"   # cuenta -> ACTIVA
```

