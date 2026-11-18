package com.talentflow.notificaciones;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.talentflow.notificaciones.dominio.Notificacion;
import com.talentflow.notificaciones.dominio.TipoNotificacion;
import com.talentflow.notificaciones.eventos.Envelope;
import com.talentflow.notificaciones.eventos.EventoParser;
import com.talentflow.notificaciones.repositorio.NotificacionRepository;
import com.talentflow.notificaciones.servicio.ConstructorNotificaciones;
import com.talentflow.notificaciones.servicio.PendientesReconciliador;
import com.talentflow.notificaciones.servicio.ProcesadorEventos;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.amqp.rabbit.core.RabbitAdmin;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.RabbitMQContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@Testcontainers
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class IntegracionRF42Test {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine")
            .withDatabaseName("db_notificaciones")
            .withUsername("user_notificaciones")
            .withPassword("pass_notificaciones");

    @Container
    static RabbitMQContainer rabbitmq = new RabbitMQContainer("rabbitmq:4-management")
            .withExposedPorts(5672, 15672);

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.rabbitmq.host", rabbitmq::getHost);
        registry.add("spring.rabbitmq.port", rabbitmq::getAmqpPort);
        registry.add("spring.rabbitmq.username", rabbitmq::getAdminUsername);
        registry.add("spring.rabbitmq.password", rabbitmq::getAdminPassword);
        registry.add("app.broker.exchange", () -> "talentflow.events");
        registry.add("app.broker.queue", () -> "notificaciones-service.q");
        registry.add("app.reconciliacion.intervalo-ms", () -> "1000"); // 1 segundo para tests
    }

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private NotificacionRepository repositorio;

    @Autowired
    private AmqpAdmin amqpAdmin;

    @Autowired
    private RabbitTemplate rabbitTemplate;

    @Autowired
    private PendientesReconciliador reconciliador;

    private EventoParser parser;
    private ConstructorNotificaciones constructor;
    private ProcesadorEventos procesador;
    private TopicExchange exchange;
    private Queue queue;

    @BeforeAll
    void setupSchema() {
        // Ejecutar init.sql para crear tablas
        String initSql = """
            CREATE TABLE IF NOT EXISTS notificaciones (
                id            VARCHAR(36)  PRIMARY KEY,
                tipo          VARCHAR(20)  NOT NULL,
                destinatario  VARCHAR(150) NOT NULL,
                mensaje       TEXT         NOT NULL,
                fecha_envio   TIMESTAMPTZ  NOT NULL DEFAULT now(),
                empleado_id   VARCHAR(20)  NULL,
                evento_id     VARCHAR(64)  NOT NULL
            );
            ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_tipo_check;
            ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_tipo_check
                CHECK (tipo IN ('BIENVENIDA', 'DESVINCULACION', 'VACACIONES', 'SEGURIDAD', 'CUENTA'));
            ALTER TABLE notificaciones ALTER COLUMN empleado_id DROP NOT NULL;
            ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_evento_id_key;
            ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_evento_id_tipo_key;
            ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_evento_id_tipo_key UNIQUE (evento_id, tipo);
            CREATE INDEX IF NOT EXISTS idx_notificaciones_empleado ON notificaciones (empleado_id, fecha_envio);

            CREATE TABLE IF NOT EXISTS eventos_procesados (
                id            VARCHAR(64)  PRIMARY KEY,
                procesado_en  TIMESTAMPTZ  NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS empleados_replica (
                empleado_id       VARCHAR(20)  PRIMARY KEY,
                email             VARCHAR(150) NOT NULL,
                estado            VARCHAR(20)  NOT NULL DEFAULT 'ACTIVO',
                ultimo_evento_ts  TIMESTAMPTZ  NOT NULL,
                actualizado_en    TIMESTAMPTZ  NOT NULL DEFAULT now()
            );
            ALTER TABLE empleados_replica DROP CONSTRAINT IF EXISTS empleados_replica_estado_check;
            ALTER TABLE empleados_replica ADD CONSTRAINT empleados_replica_estado_check
                CHECK (estado IN ('ACTIVO', 'RETIRADO'));

            CREATE TABLE IF NOT EXISTS vacaciones_finalizadas_pendientes (
                id                  VARCHAR(64)  PRIMARY KEY,
                empleado_id         VARCHAR(20)  NOT NULL,
                email               VARCHAR(150) NOT NULL,
                fecha_fin           DATE         NOT NULL,
                vacaciones_id       VARCHAR(20)  NOT NULL,
                estado              VARCHAR(20)  NOT NULL DEFAULT 'PENDIENTE',
                intento_actual      INTEGER      NOT NULL DEFAULT 0,
                max_intentos        INTEGER      NOT NULL DEFAULT 10,
                reclamado_por       VARCHAR(100) NULL,
                reclamado_en        TIMESTAMPTZ  NULL,
                creado_en           TIMESTAMPTZ  NOT NULL DEFAULT now(),
                actualizado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
                procesado_en        TIMESTAMPTZ  NULL
            );
            ALTER TABLE vacaciones_finalizadas_pendientes DROP CONSTRAINT IF EXISTS vacaciones_finalizadas_pendientes_estado_check;
            ALTER TABLE vacaciones_finalizadas_pendientes ADD CONSTRAINT vacaciones_finalizadas_pendientes_estado_check
                CHECK (estado IN ('PENDIENTE', 'PROCESADO_ACTIVO', 'PROCESADO_RETIRADO', 'REQUIERE_REVISION'));
            CREATE INDEX IF NOT EXISTS idx_pendientes_empleado ON vacaciones_finalizadas_pendientes (empleado_id, estado);
            CREATE INDEX IF NOT EXISTS idx_pendientes_estado_reclamado ON vacaciones_finalizadas_pendientes (estado, reclamado_en) WHERE estado = 'PENDIENTE';
            """;
        jdbc.execute(initSql);
    }

    @BeforeEach
    void setupTest() {
        parser = new EventoParser(new ObjectMapper());
        constructor = new ConstructorNotificaciones();
        
        // Declarar topología RabbitMQ
        exchange = new TopicExchange("talentflow.events", true, false);
        queue = new Queue("notificaciones-service.q", true);
        amqpAdmin.declareExchange(exchange);
        amqpAdmin.declareQueue(queue);
        amqpAdmin.declareBinding(BindingBuilder.bind(queue).to(exchange).with("vacaciones.finalizadas"));
        amqpAdmin.declareBinding(BindingBuilder.bind(queue).to(exchange).with("empleado.creado"));
        amqpAdmin.declareBinding(BindingBuilder.bind(queue).to(exchange).with("empleado.retirado"));
        amqpAdmin.declareBinding(BindingBuilder.bind(queue).to(exchange).with("cuenta.activada"));
        amqpAdmin.declareBinding(BindingBuilder.bind(queue).to(exchange).with("cuenta.desactivada"));
        amqpAdmin.declareBinding(BindingBuilder.bind(queue).to(exchange).with("usuario.creado"));
        amqpAdmin.declareBinding(BindingBuilder.bind(queue).to(exchange).with("usuario.recuperacion"));
        amqpAdmin.declareBinding(BindingBuilder.bind(queue).to(exchange).with("vacaciones.programadas"));
    }

    private byte[] evento(String id, String tipo, String data) {
        return ("{\"id\":\"" + id + "\",\"type\":\"" + tipo + "\",\"version\":1,"
                + "\"occurredAt\":\"2026-10-10T12:00:00Z\",\"producer\":\"p\",\"data\":" + data + "}")
                .getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void vacacionesFinalizadasEmpleadoActivoGeneraBienvenida() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E001";
        String email = "juan@empresa.com";
        String vacacionesId = "V-2026-001";
        
        // 1. Insertar empleado ACTIVO en réplica
        jdbc.update(
            "INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en) VALUES (?, ?, 'ACTIVO', now(), now())",
            empleadoId, email
        );

        // 2. Publicar evento vacaciones.finalizadas
        String data = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"vacacionesId\":\"" + vacacionesId + "\",\"fechaFin\":\"2026-10-15\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId, "vacaciones.finalizadas", data));

        // 3. Esperar a que se procese (el listener es asíncrono)
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            List<Notificacion> notifs = repositorio.listarPorEmpleado(empleadoId);
            assertThat(notifs).hasSize(1);
            assertThat(notifs.get(0).tipo()).isEqualTo(TipoNotificacion.CUENTA);
            assertThat(notifs.get(0).mensaje()).contains("Bienvenido de vuelta");
        });

        // 4. Verificar que NO se creó pendiente
        Integer countPendientes = jdbc.queryForObject(
            "SELECT COUNT(*) FROM vacaciones_finalizadas_pendientes WHERE id = ?", Integer.class, eventoId);
        assertThat(countPendientes).isEqualTo(0);
    }

    @Test
    void vacacionesFinalizadasEmpleadoRetiradoNoGeneraBienvenida() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E002";
        String email = "maria@empresa.com";
        
        // 1. Insertar empleado RETIRADO en réplica
        jdbc.update(
            "INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en) VALUES (?, ?, 'RETIRADO', now(), now())",
            empleadoId, email
        );

        // 2. Publicar evento
        String data = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"vacacionesId\":\"V-2026-002\",\"fechaFin\":\"2026-10-15\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId, "vacaciones.finalizadas", data));

        // 3. Verificar que no hay notificación
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            List<Notificacion> notifs = repositorio.listarPorEmpleado(empleadoId);
            assertThat(notifs).isEmpty();
        });

        // 4. Verificar que NO se creó pendiente (RETIRADO no crea pendiente)
        Integer countPendientes = jdbc.queryForObject(
            "SELECT COUNT(*) FROM vacaciones_finalizadas_pendientes WHERE id = ?", Integer.class, eventoId);
        assertThat(countPendientes).isEqualTo(0);
    }

    @Test
    void vacacionesFinalizadasEmpleadoDesconocidoCreaPendiente() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E999";
        String email = "desconocido@empresa.com";
        
        // NO insertar empleado en réplica

        // 2. Publicar evento
        String data = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"vacacionesId\":\"V-2026-003\",\"fechaFin\":\"2026-10-15\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId, "vacaciones.finalizadas", data));

        // 3. Verificar que se creó pendiente
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            Integer countPendientes = jdbc.queryForObject(
                "SELECT COUNT(*) FROM vacaciones_finalizadas_pendientes WHERE id = ?", Integer.class, eventoId);
            assertThat(countPendientes).isEqualTo(1);
        });

        // 4. Verificar estado del pendiente
        var pendiente = jdbc.queryForObject(
            "SELECT estado, intento_actual, max_intentos FROM vacaciones_finalizadas_pendientes WHERE id = ?",
            (rs, i) -> new Object[]{rs.getString("estado"), rs.getInt("intento_actual"), rs.getInt("max_intentos")},
            eventoId
        );
        assertThat(pendiente[0]).isEqualTo("PENDIENTE");
        assertThat(pendiente[1]).isEqualTo(0);
        assertThat(pendiente[2]).isEqualTo(10);
    }

    @Test
    void empleadoCreadoPosteriorResuelvePendiente() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E998";
        String email = "nuevo@empresa.com";
        
        // 1. Publicar vacaciones.finalizadas SIN que exista el empleado
        String data = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"vacacionesId\":\"V-2026-004\",\"fechaFin\":\"2026-10-15\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId, "vacaciones.finalizadas", data));

        // 2. Verificar que se creó pendiente
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            Integer countPendientes = jdbc.queryForObject(
                "SELECT COUNT(*) FROM vacaciones_finalizadas_pendientes WHERE id = ?", Integer.class, eventoId);
            assertThat(countPendientes).isEqualTo(1);
        });

        // 3. Publicar empleado.creado
        String dataEmpleado = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"nombre\":\"Nuevo\",\"apellido\":\"Empleado\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "empleado.creado", evento(UUID.randomUUID().toString(), "empleado.creado", dataEmpleado));

        // 4. Esperar a que el reconciliador procese (intervalo 1 segundo)
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            // Verificar que el pendiente pasó a PROCESADO_ACTIVO
            String estado = jdbc.queryForObject(
                "SELECT estado FROM vacaciones_finalizadas_pendientes WHERE id = ?", String.class, eventoId);
            assertThat(estado).isEqualTo("PROCESADO_ACTIVO");
        });

        // 5. Verificar que se generó la notificación
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            List<Notificacion> notifs = repositorio.listarPorEmpleado(empleadoId);
            assertThat(notifs).hasSize(1);
            assertThat(notifs.get(0).tipo()).isEqualTo(TipoNotificacion.CUENTA);
        });
    }

    @Test
    void eventoDuplicadoNoGeneraNotificacionesDuplicadas() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E003";
        String email = "duplicado@empresa.com";
        
        // Insertar empleado ACTIVO
        jdbc.update(
            "INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en) VALUES (?, ?, 'ACTIVO', now(), now())",
            empleadoId, email
        );

        String data = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"vacacionesId\":\"V-2026-005\",\"fechaFin\":\"2026-10-15\"}";

        // Publicar primera vez
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId, "vacaciones.finalizadas", data));

        // Publicar segunda vez (duplicado)
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId, "vacaciones.finalizadas", data));

        // Verificar solo una notificación
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            List<Notificacion> notifs = repositorio.listarPorEmpleado(empleadoId);
            assertThat(notifs).hasSize(1);
        });
    }

    @Test
    void cuentaActivadaFinVacacionesNoGeneraSegundaBienvenida() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E004";
        String email = "finvac@empresa.com";
        
        // Insertar empleado ACTIVO
        jdbc.update(
            "INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en) VALUES (?, ?, 'ACTIVO', now(), now())",
            empleadoId, email
        );

        // 1. Publicar vacaciones.finalizadas (genera bienvenida)
        String dataVac = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"vacacionesId\":\"V-2026-006\",\"fechaFin\":\"2026-10-15\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId + "-vac", "vacaciones.finalizadas", dataVac));

        // 2. Publicar cuenta.activada con motivo FIN_VACACIONES (NO debe generar notificación)
        String dataCuenta = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"motivo\":\"FIN_VACACIONES\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "cuenta.activada", evento(eventoId + "-cuenta", "cuenta.activada", dataCuenta));

        // Verificar solo una notificación (la de vacaciones.finalizadas)
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            List<Notificacion> notifs = repositorio.listarPorEmpleado(empleadoId);
            assertThat(notifs).hasSize(1);
        });
    }

    @Test
    void inconsistenciaUniqueDatosIdenticosDeduplicacionValida() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E_DUP";
        String email = "dup@empresa.com";
        
        // Insertar empleado ACTIVO
        jdbc.update(
            "INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en) VALUES (?, ?, 'ACTIVO', now(), now())",
            empleadoId, email
        );

        // Insertar notificación existente con mismo evento_id y tipo
        jdbc.update("""
            INSERT INTO notificaciones (id, tipo, destinatario, mensaje, fecha_envio, empleado_id, evento_id)
            VALUES (?, 'CUENTA', ?, 'Mensaje previo', now(), ?, ?)
            """, UUID.randomUUID().toString(), email, empleadoId, eventoId);

        // Publicar evento
        String data = "{\"empleadoId\":\"" + empleadoId + "\",\"email\":\"" + email 
                + "\",\"vacacionesId\":\"V-2026-007\",\"fechaFin\":\"2026-10-15\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId, "vacaciones.finalizadas", data));

        // Verificar que el pendiente se marca como PROCESADO_ACTIVO (deduplicación válida)
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            String estado = jdbc.queryForObject(
                "SELECT estado FROM vacaciones_finalizadas_pendientes WHERE id = ?", String.class, eventoId);
            assertThat(estado).isEqualTo("PROCESADO_ACTIVO");
        });
    }

    @Test
    void inconsistenciaUniqueDatosDiferentesInconsistenciaRequiereRevision() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId1 = "E_DIFF1";
        String empleadoId2 = "E_DIFF2";
        String email1 = "diff1@empresa.com";
        String email2 = "diff2@empresa.com";
        
        // Insertar empleado 1 ACTIVO
        jdbc.update(
            "INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en) VALUES (?, ?, 'ACTIVO', now(), now())",
            empleadoId1, email1
        );

        // Insertar notificación existente con MISMO evento_id pero DATOS DIFERENTES
        jdbc.update("""
            INSERT INTO notificaciones (id, tipo, destinatario, mensaje, fecha_envio, empleado_id, evento_id)
            VALUES (?, 'CUENTA', ?, 'Mensaje previo', now(), ?, ?)
            """, UUID.randomUUID().toString(), email2, empleadoId2, eventoId);

        // Publicar evento para empleado 1
        String data = "{\"empleadoId\":\"" + empleadoId1 + "\",\"email\":\"" + email1 
                + "\",\"vacacionesId\":\"V-2026-008\",\"fechaFin\":\"2026-10-15\"}";
        rabbitTemplate.convertAndSend("talentflow.events", "vacaciones.finalizadas", evento(eventoId, "vacaciones.finalizadas", data));

        // Verificar que el pendiente NO se marca como procesado, va a REQUIERE_REVISION o reintenta
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            String estado = jdbc.queryForObject(
                "SELECT estado FROM vacaciones_finalizadas_pendientes WHERE id = ?", String.class, eventoId);
            // Debe ser REQUIERE_REVISION (tras incrementar intento) o seguir PENDIENTE
            assertThat(estado).isIn("REQUIERE_REVISION", "PENDIENTE");
        });
        
        // Verificar que el contador de intentos se incrementó
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            Integer intento = jdbc.queryForObject(
                "SELECT intento_actual FROM vacaciones_finalizadas_pendientes WHERE id = ?", Integer.class, eventoId);
            assertThat(intento).isGreaterThanOrEqualTo(1);
        });
    }

    @Test
    void errorPermanenteMaxIntentosRequiereRevision() {
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E_MAX";
        String email = "max@empresa.com";
        
        // Insertar pendiente directamente con max_intentos = 1 y intento_actual = 0
        jdbc.update("""
            INSERT INTO vacaciones_finalizadas_pendientes 
            (id, empleado_id, email, fecha_fin, vacaciones_id, estado, intento_actual, max_intentos, 
             creado_en, actualizado_en)
            VALUES (?, ?, ?, '2026-10-15', 'V-MAX', 'PENDIENTE', 0, 1, 
                    now(), now())
            """, eventoId, empleadoId, email);

        // NO insertar empleado en réplica (desconocido permanente)

        // Ejecutar reconciliador manualmente
        reconciliador.reconciliarLote();

        // Verificar que pasó a REQUIERE_REVISION (superó max_intentos)
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            String estado = jdbc.queryForObject(
                "SELECT estado FROM vacaciones_finalizadas_pendientes WHERE id = ?", String.class, eventoId);
            assertThat(estado).isEqualTo("REQUIERE_REVISION");
        });
    }

    @Test
    void expiracionTTLReclamacionAbandonada() throws InterruptedException {
        // Insertar pendiente directamente con reclamado_en antiguo (> 5 min)
        String eventoId = UUID.randomUUID().toString();
        String empleadoId = "E_TTL";
        String email = "ttl@empresa.com";
        
        jdbc.update("""
            INSERT INTO vacaciones_finalizadas_pendientes 
            (id, empleado_id, email, fecha_fin, vacaciones_id, estado, intento_actual, max_intentos, 
             reclamado_por, reclamado_en, creado_en, actualizado_en)
            VALUES (?, ?, ?, '2026-10-15', 'V-TTL', 'PENDIENTE', 0, 10, 
                    'otra-instancia', now() - interval '10 minutes', now(), now())
            """, eventoId, empleadoId, email);

        // Insertar empleado ACTIVO
        jdbc.update(
            "INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en) VALUES (?, ?, 'ACTIVO', now(), now())",
            empleadoId, email
        );

        // Ejecutar reconciliador manualmente
        reconciliador.reconciliarLote();

        // Verificar que el pendiente fue reclamado por esta instancia y procesado
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            String estado = jdbc.queryForObject(
                "SELECT estado FROM vacaciones_finalizadas_pendientes WHERE id = ?", String.class, eventoId);
            assertThat(estado).isEqualTo("PROCESADO_ACTIVO");
        });
    }
}