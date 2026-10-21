
#!/usr/bin/env bash
# Demo de sustentacion del Reto 4 - TalentFlow.
# Flujo asincrono: empleados, perfiles, notificaciones y vacaciones.
#
# Requisitos:
#   docker compose up --build -d
#   curl, python3 y acceso a la API HTTP de RabbitMQ
#
# Ejecucion:
#   bash docs/reto-04/demo.sh
#
# Por defecto se simulan los eventos de empleados publicandolos en RabbitMQ.
# Para probar empleados-service directamente:
#   SIMULAR_EMPLEADOS=0 bash docs/reto-04/demo.sh

set -u

BASE="${BASE:-http://localhost:8080}"
MQ="${MQ:-http://localhost:15672}"
MQ_USER="${RABBITMQ_USER:-talentflow}"
MQ_PASS="${RABBITMQ_PASS:-talentflow_dev}"
EXCHANGE="talentflow.events"
SIMULAR_EMPLEADOS="${SIMULAR_EMPLEADOS:-1}"

ANIO=$(( $(date +%Y) + 1 ))
EMP="E001"
EMAIL="juan.perez@empresa.com"

# Identificadores exclusivos para que la prueba de deduplicacion
# pueda repetirse sin reutilizar eventos de ejecuciones anteriores.
RUN_ID="$(date +%s)"
EMP_DEDUP="EMP-DEDUP-$RUN_ID"
MSG_DEDUP="DEDUP-TEST-$RUN_ID"

paso() {
  printf '\n\033[1;36m==================================================\033[0m\n'
  printf '\033[1;36m== %s\033[0m\n' "$*"
  printf '\033[1;36m==================================================\033[0m\n'
}

explicar() {
  printf '\n  EXPLICACION: %s\n\n' "$*"
}

get() {
  curl -sS -w '\n[HTTP %{http_code}]\n' "$@"
}

# Publica un evento usando la API HTTP de RabbitMQ.
# Argumentos:
#   publicar <routing_key> <message_id> <json-data> [occurredAt]
#
# Si se especifica occurredAt, se conserva. Esto permite publicar
# el mismo evento dos veces con exactamente el mismo contenido.
publicar() {
  python3 - "$1" "$2" "$3" "$MQ" "$EXCHANGE" \
    "$MQ_USER" "$MQ_PASS" "${4:-}" <<'PY'
import sys, json, base64, urllib.request, datetime

clave, mid, data, mq, ex, usuario, password, fecha = sys.argv[1:9]

if not fecha:
    fecha = datetime.datetime.now(
        datetime.timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

evento = {
    "id": mid,
    "type": clave,
    "version": 1,
    "occurredAt": fecha,
    "producer": "empleados-service",
    "data": json.loads(data)
}

cuerpo = {
    "properties": {
        "message_id": mid,
        "content_type": "application/json",
        "delivery_mode": 2
    },
    "routing_key": clave,
    "payload": json.dumps(evento, ensure_ascii=False),
    "payload_encoding": "string"
}

url = f"{mq}/api/exchanges/%2F/{ex}/publish"
body = json.dumps(cuerpo).encode("utf-8")
credenciales = base64.b64encode(
    f"{usuario}:{password}".encode()
).decode()

req = urllib.request.Request(
    url,
    body,
    {
        "Content-Type": "application/json",
        "Authorization": "Basic " + credenciales
    }
)

with urllib.request.urlopen(req) as respuesta:
    resultado = json.load(respuesta)

print(
    f"  Evento: {clave} | id={mid} | "
    f"enrutado={resultado.get('routed')} | fecha={fecha}"
)
PY
}

paso "0. Salud del sistema"

explicar "Verificamos que el API Gateway responda antes de comenzar las pruebas."
get "$BASE/health"

paso "1. Crear el empleado $EMP"

if [ "$SIMULAR_EMPLEADOS" = "1" ]; then
  explicar "Simulamos el evento empleado.creado desde el broker. Los consumidores deben crear el perfil y generar la bienvenida."
  publicar empleado.creado "msg-creado-$EMP" \
    "{\"empleadoId\":\"$EMP\",\"nombre\":\"Juan\",\"apellido\":\"Pérez\",\"email\":\"$EMAIL\",\"numeroEmpleado\":\"EMP-2026-001\",\"cargo\":\"Desarrollador Senior\",\"area\":\"Tecnología\",\"departamentoId\":\"IT\",\"fechaIngreso\":\"2026-03-01\",\"estado\":\"ACTIVO\"}"
else
  explicar "Creamos el departamento IT si corresponde y registramos al empleado por REST. El servicio de empleados debe publicar el evento."
  curl -sS -X POST "$BASE/departamentos" \
    -H 'Content-Type: application/json' \
    -d '{"id":"IT","nombre":"Tecnología","descripcion":"Departamento de TI"}' \
    >/dev/null || true

  get -X POST "$BASE/empleados" \
    -H 'Content-Type: application/json' \
    -d "{\"id\":\"$EMP\",\"nombre\":\"Juan\",\"apellido\":\"Pérez\",\"email\":\"$EMAIL\",\"numeroEmpleado\":\"EMP-2026-001\",\"cargo\":\"Desarrollador Senior\",\"area\":\"Tecnología\",\"departamentoId\":\"IT\",\"fechaIngreso\":\"2026-03-01\"}"
fi

sleep 2

paso "2. Consultar perfil y notificaciones"

explicar "El consumidor de perfiles procesa empleado.creado y crea el perfil. Notificaciones procesa el mismo evento y genera una bienvenida."
echo "-- Perfil del empleado:"
get "$BASE/perfiles/$EMP"

echo "-- Notificaciones del empleado:"
get "$BASE/notificaciones/$EMP"

paso "3. Actualizar el perfil"

explicar "Probamos el PUT del servicio de perfiles. Los campos enviados deben persistirse y aparecer en la respuesta."
get -X PUT "$BASE/perfiles/$EMP" \
  -H 'Content-Type: application/json' \
  -d '{"telefono":"3001234567","ciudad":"Armenia","biografia":"Ingeniero de sistemas"}'

echo "-- Consultar nuevamente para verificar la persistencia:"
get "$BASE/perfiles/$EMP"

paso "4. Programar vacaciones válidas"

explicar "Se envía una solicitud con fechas futuras y un empleado existente. La API debe registrar las vacaciones y publicar vacaciones.programadas."
get -X POST "$BASE/vacaciones" \
  -H 'Content-Type: application/json' \
  -d "{\"empleadoId\":\"$EMP\",\"fechaInicio\":\"$ANIO-06-15\",\"fechaFin\":\"$ANIO-06-30\"}"

sleep 2

explicar "El consumidor de notificaciones debe registrar una notificación de tipo VACACIONES al recibir el evento."
get "$BASE/notificaciones/$EMP"

paso "5. Validaciones negativas de vacaciones"

explicar "Caso 5.1: fecha final anterior a la fecha inicial. Se espera HTTP 400 porque el rango es incoherente."
get -X POST "$BASE/vacaciones" \
  -H 'Content-Type: application/json' \
  -d "{\"empleadoId\":\"$EMP\",\"fechaInicio\":\"$ANIO-06-30\",\"fechaFin\":\"$ANIO-06-15\"}"

explicar "Caso 5.2: fechas en el pasado. Se espera HTTP 400 porque no se permite programar vacaciones retroactivas."
get -X POST "$BASE/vacaciones" \
  -H 'Content-Type: application/json' \
  -d "{\"empleadoId\":\"$EMP\",\"fechaInicio\":\"2020-01-10\",\"fechaFin\":\"2020-01-20\"}"

explicar "Caso 5.3: solapamiento. Se espera HTTP 400 porque el periodo solicitado se cruza con las vacaciones ya registradas."
get -X POST "$BASE/vacaciones" \
  -H 'Content-Type: application/json' \
  -d "{\"empleadoId\":\"$EMP\",\"fechaInicio\":\"$ANIO-06-20\",\"fechaFin\":\"$ANIO-07-05\"}"

explicar "Caso 5.4: empleado inexistente. Se espera HTTP 400 porque NO-EXISTE no está registrado."
get -X POST "$BASE/vacaciones" \
  -H 'Content-Type: application/json' \
  -d "{\"empleadoId\":\"NO-EXISTE\",\"fechaInicio\":\"$ANIO-08-01\",\"fechaFin\":\"$ANIO-08-15\"}"

paso "6. Deduplicación de eventos"

explicar "Publicaremos dos veces el mismo evento empleado.creado. Ambas publicaciones usan el mismo id, la misma fecha y los mismos datos. Se espera una sola notificación, aunque RabbitMQ entregue el mensaje repetido."

DEDUP_FECHA="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEDUP_DATA="{\"empleadoId\":\"$EMP_DEDUP\",\"nombre\":\"Empleado\",\"apellido\":\"Prueba\",\"email\":\"$EMP_DEDUP@empresa.com\",\"cargo\":\"QA\",\"area\":\"TI\",\"departamentoId\":\"IT\"}"

echo "-- Primera publicación:"
publicar empleado.creado "$MSG_DEDUP" "$DEDUP_DATA" "$DEDUP_FECHA"

sleep 2

echo "-- Segunda publicación: mismo evento e identificador:"
publicar empleado.creado "$MSG_DEDUP" "$DEDUP_DATA" "$DEDUP_FECHA"

sleep 2

explicar "Consultamos las notificaciones del empleado de prueba. El resultado esperado es una sola notificación BIENVENIDA, no dos."
get "$BASE/notificaciones/$EMP_DEDUP"

explicar "Consultamos los logs para buscar la evidencia explícita del descarte del duplicado."
docker compose logs --since=5m notificaciones-service 2>&1 |
  grep -E "Evento duplicado descartado|DUPLICADO|$MSG_DEDUP" || true

explicar "También consultamos el perfil creado por el consumidor de perfiles."
get "$BASE/perfiles/$EMP_DEDUP"

paso "7. Retirar al empleado $EMP"

if [ "$SIMULAR_EMPLEADOS" = "1" ]; then
  explicar "Simulamos empleado.retirado. El consumidor debe archivar el perfil y generar una notificación de desvinculación."
  publicar empleado.retirado "msg-retirado-$EMP" \
    "{\"empleadoId\":\"$EMP\",\"email\":\"$EMAIL\",\"fechaRetiro\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"motivo\":\"RENUNCIA\"}"
else
  explicar "Solicitamos el retiro por REST. El endpoint debe registrar el retiro lógico del empleado."
  get -X DELETE "$BASE/empleados/$EMP"
fi

sleep 2

echo "-- Perfil del empleado (debe quedar archivado, no eliminado):"
get "$BASE/perfiles/$EMP"

echo "-- Notificaciones (debe aparecer DESVINCULACION):"
get "$BASE/notificaciones/$EMP"

explicar "Un empleado retirado no debe poder programar nuevas vacaciones. Se espera HTTP 400."
get -X POST "$BASE/vacaciones" \
  -H 'Content-Type: application/json' \
  -d "{\"empleadoId\":\"$EMP\",\"fechaInicio\":\"$ANIO-09-01\",\"fechaFin\":\"$ANIO-09-10\"}"

paso "8. Evidencias y documentación"

echo "Swagger UI:"
echo "  Perfiles:      $BASE/perfiles/docs"
echo "  Notificaciones: $BASE/notificaciones/docs"
echo "  Vacaciones:    $BASE/vacaciones/docs"
echo
echo "Logs de Notificaciones:"
echo "  docker compose logs --since=10m notificaciones-service"
echo
echo "Logs del broker:"
echo "  docker compose logs --since=10m message-broker"
echo
echo "Fin de la demostración."

echo
echo "La ventana se cerrará en 10 minutos..."
sleep 600