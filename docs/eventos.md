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
| `empleado.creado` | empleados-service  ✅ | perfiles (`perfiles-service.q`), notificaciones (`notificaciones-service.q`), vacaciones (`vacaciones-service.q`), **empleados** (`empleados-service.q`, RF-09) | 4 / 5 |
| `empleado.actualizado` | empleados-service  ✅ | perfiles | 4 |
| `empleado.retirado` | empleados-service  ✅ | perfiles, notificaciones, vacaciones | 4 |
| `vacaciones.programadas` | **vacaciones-service** ✅ | notificaciones | 4 |
| `usuario.creado` | empleados-service ✅ | _(ninguno aún)_ | 5 |
| `cuenta.activada` | empleados-service ✅ | _(ninguno aún)_ | 5 |
| `cuenta.desactivada` | empleados-service ✅ | _(ninguno aún)_ | 5 |
| `vacaciones.iniciadas` | **vacaciones-service** ⚠️ _aún no lo publica_ | empleados (`empleados-service.q`) | 5 |
| `vacaciones.finalizadas` | **vacaciones-service** ⚠️ _aún no lo publica_ | empleados (`empleados-service.q`) | 5 |

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

### Eventos de cuentas (Reto 5, RF-09 a RF-11)

`empleados-service` actúa también como servicio de autenticación y consume, en la cola durable `empleados-service.q`
(routing keys `empleado.creado`, `vacaciones.iniciadas`, `vacaciones.finalizadas`):

| Consume | Efecto sobre la cuenta | Publica (`data`) |
|---|---|---|
| `empleado.creado` | Crea la cuenta `INACTIVA`, rol `USER`, sin contraseña válida. Si ya existe cuenta con ese `empleadoId` o `email` (o el email es el del admin semilla): se ignora con log. | `usuario.creado`: `empleadoId, email, tokenActivacion, expiraEn` |
| `vacaciones.iniciadas` | `ACTIVA` → `SUSPENDIDA_TEMPORAL`. Cualquier otro estado (o sin cuenta): se ignora con log. | `cuenta.desactivada`: `empleadoId, email, motivo: "VACACIONES", permanente: false` |
| `vacaciones.finalizadas` | Solo `SUSPENDIDA_TEMPORAL` → `ACTIVA`. Cualquier otro estado: se ignora con log. | `cuenta.activada`: `empleadoId, email, motivo: "FIN_VACACIONES"` |

- Las reacciones de vacaciones solo miran el **estado de la cuenta**; nunca consultan el estado del empleado.
- `tokenActivacion` es el mismo JWT `RESET_PASSWORD` de `POST /auth/reset-password` (vigencia `JWT_ACTIVACION_EXPIRA_SEGUNDOS`,
  24 h por defecto); `expiraEn` es su `exp` en ISO-8601 UTC.
- Mensajes con `data.empleadoId` (y `data.email` en `empleado.creado`) ausente → inválidos: `reject` sin reencolar.
- **Orden de operaciones**: el id del evento, el cambio de la cuenta **y la publicación del evento de salida** van en una sola
  transacción. Si el broker rechaza la publicación se hace `ROLLBACK` y el mensaje se reintenta, de modo que el token de activación
  no se pierde en silencio. Contrapartida: si el `COMMIT` falla justo después de publicar, el reintento publica de nuevo
  (al menos una vez; los consumidores deduplican por `id`).
- **Pendiente (fuera de este alcance)**: `vacaciones-service` todavía no publica `vacaciones.iniciadas` ni `vacaciones.finalizadas`
  (el scheduler del Reto 5), y `notificaciones-service` aún no consume `usuario.creado` (la bienvenida sigue colgada de `empleado.creado`).
