package com.talentflow.notificaciones.repositorio;

import com.talentflow.notificaciones.dominio.Notificacion;
import com.talentflow.notificaciones.dominio.NotificacionNueva;
import com.talentflow.notificaciones.dominio.TipoNotificacion;
import com.talentflow.notificaciones.eventos.Envelope;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class NotificacionRepository {

    private static final String COLUMNAS = "id, tipo, destinatario, mensaje, fecha_envio, empleado_id";

    private static final RowMapper<Notificacion> MAPPER = (rs, fila) -> new Notificacion(
            rs.getString("id"),
            TipoNotificacion.valueOf(rs.getString("tipo")),
            rs.getString("destinatario"),
            rs.getString("mensaje"),
            rs.getTimestamp("fecha_envio").toInstant(),
            rs.getString("empleado_id"));

    private final JdbcTemplate jdbc;

    public NotificacionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Registra el id del mensaje. Devuelve true si es nuevo; false si ya se había procesado
     * (mensaje duplicado). Debe llamarse dentro de la misma transacción que guarda la notificación.
     */
    public boolean registrarEvento(String eventoId) {
        int filas = jdbc.update(
                "INSERT INTO eventos_procesados (id) VALUES (?) ON CONFLICT (id) DO NOTHING", eventoId);
        return filas == 1;
    }

    public Notificacion guardar(NotificacionNueva nueva, String eventoId) {
        String id = UUID.randomUUID().toString();
        Instant ahora = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        jdbc.update(
                "INSERT INTO notificaciones (id, tipo, destinatario, mensaje, fecha_envio, empleado_id, evento_id) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?)",
                id, nueva.tipo().name(), nueva.destinatario(), nueva.mensaje(),
                Timestamp.from(ahora), nueva.empleadoId(), eventoId);
        return new Notificacion(id, nueva.tipo(), nueva.destinatario(), nueva.mensaje(), ahora, nueva.empleadoId());
    }

    public List<Notificacion> listar() {
        return jdbc.query("SELECT " + COLUMNAS + " FROM notificaciones ORDER BY fecha_envio, id", MAPPER);
    }

    public List<Notificacion> listarPorEmpleado(String empleadoId) {
        return jdbc.query(
                "SELECT " + COLUMNAS + " FROM notificaciones WHERE empleado_id = ? ORDER BY fecha_envio, id",
                MAPPER, empleadoId);
    }

    // ============ RF-42: Réplica local de empleados ============

    private static final RowMapper<EmpleadoReplica> EMPLEADO_REPLICA_MAPPER = (rs, fila) -> new EmpleadoReplica(
            rs.getString("empleado_id"),
            rs.getString("email"),
            rs.getString("estado"),
            rs.getTimestamp("ultimo_evento_ts").toInstant(),
            rs.getTimestamp("actualizado_en").toInstant()
    );

    public record EmpleadoReplica(
            String empleadoId,
            String email,
            String estado,
            Instant ultimoEventoTs,
            Instant actualizadoEn
    ) {}

    /**
     * Obtiene un empleado de la réplica local.
     * @return Optional vacío si no existe.
     */
    public Optional<EmpleadoReplica> obtenerEmpleado(String empleadoId) {
        return jdbc.query(
                "SELECT empleado_id, email, estado, ultimo_evento_ts, actualizado_en FROM empleados_replica WHERE empleado_id = ?",
                EMPLEADO_REPLICA_MAPPER, empleadoId)
                .stream().findFirst();
    }

    /**
     * Actualiza la réplica local de empleados según el evento recibido.
     * Utiliza occurredAt del envelope para resolver carreras (last-write-wins).
     * RETIRADO es absorbente: si ya está RETIRADO, no vuelve a ACTIVO.
     */
    public void actualizarReplica(Envelope evento) {
        String tipo = evento.type();
        String empleadoId = evento.data().path("empleadoId").asText();
        String email = evento.data().path("email").asText();
        String occurredAtStr = evento.occurredAt();

        Instant occurredAt = Instant.parse(occurredAtStr);

        if ("empleado.creado".equals(tipo)) {
            jdbc.update(
                    """
                    INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en)
                    VALUES (?, ?, 'ACTIVO', ?, now())
                    ON CONFLICT (empleado_id) DO UPDATE SET
                        email = EXCLUDED.email,
                        estado = CASE
                            WHEN empleados_replica.estado = 'RETIRADO' THEN 'RETIRADO'
                            ELSE 'ACTIVO'
                        END,
                        ultimo_evento_ts = CASE
                            WHEN EXCLUDED.ultimo_evento_ts >= empleados_replica.ultimo_evento_ts
                            THEN EXCLUDED.ultimo_evento_ts
                            ELSE empleados_replica.ultimo_evento_ts
                        END,
                        actualizado_en = now()
                    WHERE EXCLUDED.ultimo_evento_ts >= empleados_replica.ultimo_evento_ts
                       OR empleados_replica.estado != 'RETIRADO'
                    """,
                    empleadoId, email, Timestamp.from(occurredAt));
        } else if ("empleado.retirado".equals(tipo)) {
            jdbc.update(
                    """
                    INSERT INTO empleados_replica (empleado_id, email, estado, ultimo_evento_ts, actualizado_en)
                    VALUES (?, ?, 'RETIRADO', ?, now())
                    ON CONFLICT (empleado_id) DO UPDATE SET
                        email = EXCLUDED.email,
                        estado = 'RETIRADO',
                        ultimo_evento_ts = CASE
                            WHEN EXCLUDED.ultimo_evento_ts >= empleados_replica.ultimo_evento_ts
                            THEN EXCLUDED.ultimo_evento_ts
                            ELSE empleados_replica.ultimo_evento_ts
                        END,
                        actualizado_en = now()
                    WHERE EXCLUDED.ultimo_evento_ts >= empleados_replica.ultimo_evento_ts
                       OR empleados_replica.estado != 'RETIRADO'
                    """,
                    empleadoId, email, Timestamp.from(occurredAt));
        }
    }

    // ============ RF-42: Pendientes de vacaciones.finalizadas ============

    public record Pendiente(
            String id,
            String empleadoId,
            String email,
            java.time.LocalDate fechaFin,
            String vacacionesId,
            String estado,
            int intentoActual,
            int maxIntentos,
            String reclamadoPor,
            Instant reclamadoEn,
            Instant creadoEn,
            Instant actualizadoEn,
            Instant procesadoEn
    ) {}

    private static final RowMapper<Pendiente> PENDIENTE_MAPPER = (rs, fila) -> new Pendiente(
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

    /**
     * Crea un pendiente para un evento vacaciones.finalizadas cuyo empleado no está en réplica.
     */
    public void crearPendiente(String eventoId, String empleadoId, String email,
                               java.time.LocalDate fechaFin, String vacacionesId) {
        jdbc.update(
                """
                INSERT INTO vacaciones_finalizadas_pendientes
                    (id, empleado_id, email, fecha_fin, vacaciones_id, estado, intento_actual, max_intentos, creado_en, actualizado_en)
                VALUES (?, ?, ?, ?, ?, 'PENDIENTE', 0, 10, now(), now())
                """,
                eventoId, empleadoId, email, fechaFin, vacacionesId);
    }

    /**
     * Obtiene un pendiente por ID con bloqueo exclusivo (FOR UPDATE).
     */
    public Optional<Pendiente> obtenerPendienteConBloqueo(String id) {
        return jdbc.query(
                "SELECT * FROM vacaciones_finalizadas_pendientes WHERE id = ? FOR UPDATE",
                PENDIENTE_MAPPER, id)
                .stream().findFirst();
    }

    /**
     * Reclama un lote de pendientes usando FOR UPDATE SKIP LOCKED.
     */
    public List<Pendiente> reclamarPendientes(String instanciaId, int batchSize) {
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
                PENDIENTE_MAPPER, instanciaId, batchSize);
    }

    public void incrementarIntentoYLiberar(String id, int nuevoIntento) {
        jdbc.update(
                "UPDATE vacaciones_finalizadas_pendientes SET intento_actual = ?, reclamado_por = NULL, reclamado_en = NULL, actualizado_en = now() WHERE id = ?",
                nuevoIntento, id);
    }

    public void marcarRequiereRevision(String id, int nuevoIntento) {
        jdbc.update(
                "UPDATE vacaciones_finalizadas_pendientes SET estado = 'REQUIERE_REVISION', reclamado_por = NULL, reclamado_en = NULL, intento_actual = ?, actualizado_en = now() WHERE id = ?",
                nuevoIntento, id);
    }

    public void marcarProcesadoRetirado(String id) {
        jdbc.update(
                "UPDATE vacaciones_finalizadas_pendientes SET estado = 'PROCESADO_RETIRADO', reclamado_por = NULL, reclamado_en = NULL, procesado_en = now() WHERE id = ?",
                id);
    }

    public void marcarProcesadoActivo(String id) {
        jdbc.update(
                "UPDATE vacaciones_finalizadas_pendientes SET estado = 'PROCESADO_ACTIVO', reclamado_por = NULL, reclamado_en = NULL, procesado_en = now() WHERE id = ?",
                id);
    }

    /**
     * Verifica si existe una notificación para el evento_id y tipo dados.
     * Devuelve los campos clave para validación de deduplicación.
     */
    public Optional<NotificacionExistente> obtenerNotificacionExistente(String eventoId, String tipo) {
        return jdbc.query(
                "SELECT id, evento_id, tipo, empleado_id, destinatario FROM notificaciones WHERE evento_id = ? AND tipo = ?",
                (rs, fila) -> new NotificacionExistente(
                        rs.getString("id"),
                        rs.getString("evento_id"),
                        rs.getString("tipo"),
                        rs.getString("empleado_id"),
                        rs.getString("destinatario")),
                eventoId, tipo)
                .stream().findFirst();
    }

    public record NotificacionExistente(
            String id,
            String eventoId,
            String tipo,
            String empleadoId,
            String destinatario
    ) {}

    /**
     * Inserta una notificación usando ON CONFLICT DO NOTHING.
     * @return true si se insertó, false si ya existía (conflicto).
     */
    public boolean insertarNotificacionSiNoExiste(NotificacionNueva nueva, String eventoId) {
        String id = UUID.randomUUID().toString();
        Instant ahora = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        int filas = jdbc.update(
                """
                INSERT INTO notificaciones (id, tipo, destinatario, mensaje, fecha_envio, empleado_id, evento_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (evento_id, tipo) DO NOTHING
                """,
                id, nueva.tipo().name(), nueva.destinatario(), nueva.mensaje(),
                Timestamp.from(ahora), nueva.empleadoId(), eventoId);
        return filas == 1;
    }
}
