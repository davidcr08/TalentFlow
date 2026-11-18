package com.talentflow.notificaciones.servicio;

import com.talentflow.notificaciones.dominio.NotificacionNueva;
import com.talentflow.notificaciones.dominio.TipoNotificacion;
import com.talentflow.notificaciones.repositorio.NotificacionRepository;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Reconciliador de pendientes de vacaciones.finalizadas.
 * 
 * Política de errores:
 * - Errores transitorios (deadlock, timeout, pérdida temporal de conexión): rollback, log, 
 *   no incrementar intento_actual, permitir reintento por TTL (5 min) o siguiente ciclo.
 * - Errores permanentes (violación constraints, datos incompatibles, conflicto UNIQUE con datos 
 *   diferentes): rollback de la operación, log, incrementar intento_actual en transacción separada,
 *   pasar a REQUIERE_REVISION si se alcanza max_intentos o si es inconsistencia permanente.
 * - Errores desconocidos: tratar conservadoramente como transitorios, log, no perder pendiente.
 * 
 * Deduplicación: ON CONFLICT (evento_id, tipo) DO NOTHING + validación de consistencia.
 * Si datos son iguales -> deduplicación válida, marcar procesado.
 * Si datos difieren -> inconsistencia, NO marcar procesado, incrementar intento en transacción separada, REQUIERE_REVISION.
 */
@Component
public class PendientesReconciliador {

    private static final Logger log = LoggerFactory.getLogger(PendientesReconciliador.class);

    private final PlatformTransactionManager txManager;
    private final JdbcTemplate jdbc;
    private final NotificacionRepository repo;
    private final String instanciaId = UUID.randomUUID().toString();

    // Plantillas reutilizables (thread-safe)
    private final TransactionTemplate txReclamacion;
    private final TransactionTemplate txProcesamiento;
    private final TransactionTemplate txRegistroError;

    public PendientesReconciliador(PlatformTransactionManager txManager,
                                   JdbcTemplate jdbc,
                                   NotificacionRepository repo) {
        this.txManager = txManager;
        this.jdbc = jdbc;
        this.repo = repo;

        this.txReclamacion = newTransactionTemplate();
        this.txProcesamiento = newTransactionTemplate();
        this.txRegistroError = newTransactionTemplate();
    }

    private TransactionTemplate newTransactionTemplate() {
        TransactionTemplate t = new TransactionTemplate(txManager);
        t.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        t.setTimeout(30);
        return t;
    }

    @Scheduled(fixedDelayString = "${app.reconciliacion.intervalo-ms:300000}")
    public void reconciliarLote() {
        List<NotificacionRepository.Pendiente> lote = txReclamacion.execute(status -> reclamarPendientes(status, 50));

        for (NotificacionRepository.Pendiente p : lote) {
            try {
                ResultadoProcesamiento resultado = txProcesamiento.execute(status -> procesarPendiente(status, p));
                
                if (resultado.esInconsistenciaDeduplicacion()) {
                    // Error permanente detectado: registrar en transacción independiente
                    registrarErrorPermanente(p, resultado);
                } else if (resultado.esErrorTransitorio()) {
                    // Error transitorio: no incrementar contador, TTL recuperará la reclamación
                    log.debug("Error transitorio procesando pendiente {}, se reintentará por TTL", p.id());
                }
                // Si es EXITO o DEDUPLICACION_VALIDA, no hay nada que hacer (ya se marcó procesado en la tx)
            } catch (Exception e) {
                // Errores no controlados (bugs, infraestructura): log y dejar que TTL recupere
                log.error("Excepción no controlada procesando pendiente {}: {}", p.id(), e.getMessage(), e);
            }
        }
    }

    private List<NotificacionRepository.Pendiente> reclamarPendientes(TransactionStatus status, int batchSize) {
        return jdbc.query(
            """
            UPDATE vacaciones_finalizadas_pendientes
            SET reclamado_por = ?, reclamado_en = now()
            WHERE id IN (
                SELECT id FROM vacaciones_finalizadas_pendientes
                WHERE estado = 'PENDIENTE'
                  AND (reclamado_por IS NULL OR reclamado_en < now() - interval '5 minutes')
                ORDER BY creado_en
                LIMIT ?
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, empleado_id, email, fecha_fin, vacaciones_id,
                      estado, intento_actual, max_intentos, creado_en, reclamado_por, reclamado_en
            """,
            (rs, i) -> mapRowPendiente(rs, i),
            instanciaId, batchSize
        );
    }

    private ResultadoProcesamiento procesarPendiente(TransactionStatus status, NotificacionRepository.Pendiente p) {
        NotificacionRepository.Pendiente fresco;
        try {
            fresco = jdbc.queryForObject(
                "SELECT * FROM vacaciones_finalizadas_pendientes WHERE id = ? FOR UPDATE",
                (rs, i) -> mapRowPendiente(rs, i), p.id()
            );
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            log.debug("Pendiente {} ya no existe al procesar (posible carrera)", p.id());
            return ResultadoProcesamiento.yaProcesado();
        }

        if (fresco == null || !"PENDIENTE".equals(fresco.estado())
                || !instanciaId.equals(fresco.reclamadoPor())) {
            log.debug("Pendiente {} ya procesado/reclamado por otro (estado={}, reclamado_por={})",
                    p.id(), fresco != null ? fresco.estado() : "null",
                    fresco != null ? fresco.reclamadoPor() : "null");
            return ResultadoProcesamiento.yaProcesado();
        }

        var empOpt = repo.obtenerEmpleado(fresco.empleadoId());

        if (empOpt.isEmpty()) {
            return ResultadoProcesamiento.empleadoDesconocido(fresco);
        }

        String estadoEmp = empOpt.get().estado();
        if ("RETIRADO".equals(estadoEmp)) {
            repo.marcarProcesadoRetirado(fresco.id());
            log.info("Pendiente {} procesado: empleado RETIRADO, sin bienvenida", fresco.id());
            return ResultadoProcesamiento.exito();
        }

        if (!"ACTIVO".equals(estadoEmp)) {
            return ResultadoProcesamiento.estadoInesperado(fresco, estadoEmp);
        }

        // Intentar insertar notificación
        int inserted = jdbc.update(
            """
            INSERT INTO notificaciones (id, tipo, destinatario, mensaje, fecha_envio, empleado_id, evento_id)
            VALUES (?, 'CUENTA', ?,
                'Sus vacaciones han finalizado: su cuenta ha sido reactivada. ¡Bienvenido de vuelta!',
                ?, ?, ?)
            ON CONFLICT (evento_id, tipo) DO NOTHING
            """,
            UUID.randomUUID().toString(),
            fresco.email(),
            java.sql.Timestamp.from(Instant.now().truncatedTo(ChronoUnit.SECONDS)),
            fresco.empleadoId(),
            fresco.id()
        );

        if (inserted == 0) {
            // Conflicto UNIQUE: verificar si es deduplicación válida o inconsistencia
            var existente = repo.obtenerNotificacionExistente(fresco.id(), "CUENTA");
            if (existente.isEmpty()) {
                // Conflicto fantasma: no hay fila CUENTA pero UNIQUE impide insertar
                log.error("Conflicto UNIQUE fantasma para evento_id={}: no hay fila CUENTA existente", fresco.id());
                return ResultadoProcesamiento.inconsistenciaDeduplicacion(
                    "Conflicto UNIQUE fantasma: no hay fila CUENTA existente",
                    fresco
                );
            }

            if (!fresco.empleadoId().equals(existente.get().empleadoId())
                    || !fresco.email().equals(existente.get().destinatario())) {
                // INCONSISTENCIA PERMANENTE: mismo evento_id pero datos distintos
                log.error("Inconsistencia deduplicación evento_id={}: existente(empleado_id={}, destinatario={}) vs pendiente(empleado_id={}, email={})",
                        fresco.id(), existente.get().empleadoId(), existente.get().destinatario(),
                        fresco.empleadoId(), fresco.email());
                return ResultadoProcesamiento.inconsistenciaDeduplicacion(
                    "Inconsistencia deduplicación: datos diferentes en notificación existente",
                    fresco
                );
            }

            // Datos idénticos: deduplicación válida
            log.info("Deduplicación válida para evento_id={}: notificación CUENTA ya existe con mismos datos", fresco.id());
            repo.marcarProcesadoActivo(fresco.id());
            return ResultadoProcesamiento.deduplicacionValida();
        }

        repo.marcarProcesadoActivo(fresco.id());
        log.info("Pendiente {} procesado: notificación generada para empleado ACTIVO", fresco.id());
        return ResultadoProcesamiento.exito();
    }

    private void registrarErrorPermanente(NotificacionRepository.Pendiente p, ResultadoProcesamiento resultado) {
        try {
            txRegistroError.executeWithoutResult(status -> {
                // Releer el pendiente con bloqueo para obtener estado fresco
                Optional<NotificacionRepository.Pendiente> frescoOpt = jdbc.query(
                    "SELECT * FROM vacaciones_finalizadas_pendientes WHERE id = ? FOR UPDATE",
                    (rs, i) -> mapRowPendiente(rs, i), p.id()
                ).stream().findFirst();

                if (frescoOpt.isEmpty() || !"PENDIENTE".equals(frescoOpt.get().estado())
                        || !instanciaId.equals(frescoOpt.get().reclamadoPor())) {
                    log.debug("Pendiente {} ya no disponible para registrar error", p.id());
                    return;
                }

                NotificacionRepository.Pendiente fresco = frescoOpt.get();
                int nuevoIntento = fresco.intentoActual() + 1;
                
                if (nuevoIntento >= fresco.maxIntentos()) {
                    repo.marcarRequiereRevision(fresco.id(), nuevoIntento);
                    log.warn("Pendiente {} superó max intentos ({}), marcado REQUIERE_REVISION ({})", 
                            fresco.id(), fresco.maxIntentos(), resultado.mensaje());
                } else {
                    repo.incrementarIntentoYLiberar(fresco.id(), nuevoIntento);
                    log.warn("Pendiente {}: error permanente ({}), intento {}/{}", 
                            fresco.id(), resultado.mensaje(), nuevoIntento, fresco.maxIntentos());
                }
            });
        } catch (Exception e) {
            log.error("Fallo registrando error permanente para pendiente {}: {}", p.id(), e.getMessage(), e);
            // Si falla el registro, el TTL de 5 min permitirá que otra instancia lo reclame
        }
    }

    private NotificacionRepository.Pendiente mapRowPendiente(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        return new NotificacionRepository.Pendiente(
            rs.getString("id"),
            rs.getString("empleado_id"),
            rs.getString("email"),
            rs.getDate("fecha_fin").toLocalDate(),
            rs.getString("vacaciones_id"),
            rs.getString("estado"),
            rs.getInt("intento_actual"),
            rs.getInt("max_intentos"),
            rs.getString("reclamado_por"),
            rs.getTimestamp("reclamado_en") != null ? rs.getTimestamp("reclamado_en").toInstant() : null,
            rs.getTimestamp("creado_en").toInstant(),
            rs.getTimestamp("actualizado_en").toInstant(),
            rs.getTimestamp("procesado_en") != null ? rs.getTimestamp("procesado_en").toInstant() : null
        );
    }

    /**
     * Resultado del procesamiento de un pendiente.
     * Diseñado para evitar excepciones en la transacción de procesamiento y delegar
     * el manejo de errores permanentes a una transacción separada.
     */
    static class ResultadoProcesamiento {
        private final Tipo tipo;
        private final String mensaje;
        private final NotificacionRepository.Pendiente pendiente;

        private ResultadoProcesamiento(Tipo tipo, String mensaje, NotificacionRepository.Pendiente pendiente) {
            this.tipo = tipo;
            this.mensaje = mensaje;
            this.pendiente = pendiente;
        }

        static ResultadoProcesamiento exito() {
            return new ResultadoProcesamiento(Tipo.EXITO, null, null);
        }

        static ResultadoProcesamiento deduplicacionValida() {
            return new ResultadoProcesamiento(Tipo.DEDUPLICACION_VALIDA, null, null);
        }

        static ResultadoProcesamiento yaProcesado() {
            return new ResultadoProcesamiento(Tipo.YA_PROCESADO, null, null);
        }

        static ResultadoProcesamiento empleadoDesconocido(NotificacionRepository.Pendiente p) {
            return new ResultadoProcesamiento(Tipo.EMPLEADO_DESCONOCIDO, "empleado desconocido", p);
        }

        static ResultadoProcesamiento estadoInesperado(NotificacionRepository.Pendiente p, String estado) {
            return new ResultadoProcesamiento(Tipo.ESTADO_INESPERADO, "estado inesperado: " + estado, p);
        }

        static ResultadoProcesamiento inconsistenciaDeduplicacion(String mensaje, NotificacionRepository.Pendiente p) {
            return new ResultadoProcesamiento(Tipo.INCONSISTENCIA_DEDUPLICACION, mensaje, p);
        }

        static ResultadoProcesamiento errorTransitorio(String mensaje) {
            return new ResultadoProcesamiento(Tipo.ERROR_TRANSIENTE, mensaje, null);
        }

        boolean esInconsistenciaDeduplicacion() {
            return tipo == Tipo.INCONSISTENCIA_DEDUPLICACION;
        }

        boolean esErrorTransitorio() {
            return tipo == Tipo.ERROR_TRANSIENTE 
                || tipo == Tipo.EMPLEADO_DESCONOCIDO 
                || tipo == Tipo.ESTADO_INESPERADO;
        }

        boolean esExito() {
            return tipo == Tipo.EXITO || tipo == Tipo.DEDUPLICACION_VALIDA || tipo == Tipo.YA_PROCESADO;
        }

        String mensaje() {
            return mensaje;
        }

        NotificacionRepository.Pendiente pendiente() {
            return pendiente;
        }

        enum Tipo {
            EXITO,
            DEDUPLICACION_VALIDA,
            YA_PROCESADO,
            EMPLEADO_DESCONOCIDO,
            ESTADO_INESPERADO,
            INCONSISTENCIA_DEDUPLICACION,
            ERROR_TRANSIENTE
        }
    }
}
