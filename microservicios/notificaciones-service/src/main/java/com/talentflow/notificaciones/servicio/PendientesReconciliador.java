package com.talentflow.notificaciones.servicio;

import com.talentflow.notificaciones.dominio.NotificacionNueva;
import com.talentflow.notificaciones.dominio.TipoNotificacion;
import com.talentflow.notificaciones.repositorio.NotificacionRepository;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;

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

    public PendientesReconciliador(PlatformTransactionManager txManager,
                                   JdbcTemplate jdbc,
                                   NotificacionRepository repo) {
        this.txManager = txManager;
        this.jdbc = jdbc;
        this.repo = repo;

        this.txReclamacion = newTransactionTemplate();
        this.txProcesamiento = newTransactionTemplate();
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
                txProcesamiento.executeWithoutResult(status -> procesarPendiente(status, p));
            } catch (Exception e) {
                log.error("Fallo procesando pendiente {}: {}", p.id(), e.getMessage(), e);
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

    private void procesarPendiente(TransactionStatus status, NotificacionRepository.Pendiente p) {
        NotificacionRepository.Pendiente fresco;
        try {
            fresco = jdbc.queryForObject(
                "SELECT * FROM vacaciones_finalizadas_pendientes WHERE id = ? FOR UPDATE",
                (rs, i) -> mapRowPendiente(rs, i), p.id()
            );
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            log.debug("Pendiente {} ya no existe al procesar (posible carrera)", p.id());
            return;
        }

        if (fresco == null || !"PENDIENTE".equals(fresco.estado())
                || !instanciaId.equals(fresco.reclamadoPor())) {
            log.debug("Pendiente {} ya procesado/reclamado por otro (estado={}, reclamado_por={})",
                    p.id(), fresco != null ? fresco.estado() : "null",
                    fresco != null ? fresco.reclamadoPor() : "null");
            return;
        }

        var empOpt = repo.obtenerEmpleado(fresco.empleadoId());

        if (empOpt.isEmpty()) {
            int nuevoIntento = fresco.intentoActual() + 1;
            if (nuevoIntento >= fresco.maxIntentos()) {
                repo.marcarRequiereRevision(fresco.id(), nuevoIntento);
                log.warn("Pendiente {} superó max intentos ({}), marcado REQUIERE_REVISION", fresco.id(), fresco.maxIntentos());
            } else {
                repo.incrementarIntentoYLiberar(fresco.id(), nuevoIntento);
            }
            return;
        }

        String estadoEmp = empOpt.get().estado();
        if ("RETIRADO".equals(estadoEmp)) {
            repo.marcarProcesadoRetirado(fresco.id());
            log.info("Pendiente {} procesado: empleado RETIRADO, sin bienvenida", fresco.id());
            return;
        }

        if (!"ACTIVO".equals(estadoEmp)) {
            int nuevoIntento = fresco.intentoActual() + 1;
            if (nuevoIntento >= fresco.maxIntentos()) {
                repo.marcarRequiereRevision(fresco.id(), nuevoIntento);
            } else {
                repo.incrementarIntentoYLiberar(fresco.id(), nuevoIntento);
            }
            return;
        }

        insertarNotificacionYMarcarProcesado(fresco);
    }

    private void insertarNotificacionYMarcarProcesado(NotificacionRepository.Pendiente p) {
        int inserted = jdbc.update(
            """
            INSERT INTO notificaciones (id, tipo, destinatario, mensaje, fecha_envio, empleado_id, evento_id)
            VALUES (?, 'CUENTA', ?,
                'Sus vacaciones han finalizado: su cuenta ha sido reactivada. ¡Bienvenido de vuelta!',
                ?, ?, ?)
            ON CONFLICT (evento_id, tipo) DO NOTHING
            """,
            UUID.randomUUID().toString(),
            p.email(),
            java.sql.Timestamp.from(Instant.now().truncatedTo(ChronoUnit.SECONDS)),
            p.empleadoId(),
            p.id()
        );

        if (inserted == 0) {
            var existente = repo.obtenerNotificacionExistente(p.id(), "CUENTA");
            if (existente.isEmpty()) {
                throw new IllegalStateException(
                    "Conflicto UNIQUE inesperado para evento_id=" + p.id() + ": no hay fila CUENTA");
            }

            if (!p.empleadoId().equals(existente.get().empleadoId())
                    || !p.email().equals(existente.get().destinatario())) {
                throw new IllegalStateException(
                    "Inconsistencia deduplicación evento_id=" + p.id()
                    + ": existente(empleado_id=" + existente.get().empleadoId() + ", destinatario=" + existente.get().destinatario()
                    + ") vs pendiente(empleado_id=" + p.empleadoId() + ", email=" + p.email() + ")");
            }
        }

        repo.marcarProcesadoActivo(p.id());
        log.info("Pendiente {} procesado: notificación generada para empleado ACTIVO", p.id());
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
}
