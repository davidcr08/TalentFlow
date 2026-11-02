package com.talentflow.notificaciones.servicio;

import com.talentflow.notificaciones.dominio.Notificacion;
import com.talentflow.notificaciones.dominio.NotificacionNueva;
import com.talentflow.notificaciones.eventos.Envelope;
import com.talentflow.notificaciones.eventos.EventoParser;
import com.talentflow.notificaciones.repositorio.NotificacionRepository;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Procesa un mensaje del broker: valida, deduplica por id de mensaje, registra
 * las notificaciones
 * y "envía" (simula) el correo con un log estructurado.
 *
 * La deduplicación y el registro ocurren en UNA transacción: si el guardado
 * falla, el id del
 * mensaje no queda marcado y la reentrega del broker reintenta; si el mensaje
 * llega duplicado,
 * el INSERT en eventos_procesados no inserta nada y se descarta sin repetir el
 * efecto.
 */
@Service
public class ProcesadorEventos {

    public enum Resultado {
        PROCESADO, DUPLICADO, IGNORADO,
        /** RF-18: empleado.creado / empleado.retirado solo dejan una traza, sin notificación. */
        TRAZA
    }

    private static final Logger log = LoggerFactory.getLogger(ProcesadorEventos.class);

    private final EventoParser parser;
    private final ConstructorNotificaciones constructor;
    private final NotificacionRepository repositorio;
    private final TransactionTemplate transaccion;

    public ProcesadorEventos(EventoParser parser, ConstructorNotificaciones constructor,
            NotificacionRepository repositorio, TransactionTemplate transaccion) {
        this.parser = parser;
        this.constructor = constructor;
        this.repositorio = repositorio;
        this.transaccion = transaccion;
    }

    public Resultado procesar(byte[] cuerpo) {
        Envelope evento = parser.parsear(cuerpo);

        // RF-18: con empleado.creado y empleado.retirado el servicio solo registra una traza
        // (catálogo 3.1 y 3.3). La bienvenida sale con usuario.creado y la despedida con
        // cuenta.desactivada (motivo RETIRO).
        if (constructor.esSoloTraza(evento)) {
            log.info("[TRAZA] {} recibido (id={}, empleadoId={}): no genera notificación",
                    evento.type(), evento.id(), evento.data().path("empleadoId").asText(""));
            return Resultado.TRAZA;
        }

        List<NotificacionNueva> nuevas = constructor.construir(evento);
        if (nuevas.isEmpty()) {
            return Resultado.IGNORADO;
        }

        // Un evento puede generar varias notificaciones (usuario.creado: BIENVENIDA + SEGURIDAD);
        // el id del evento se registra una sola vez y todas se guardan en la misma transacción.
        List<Notificacion> guardadas = transaccion.execute(estado -> {
            if (!repositorio.registrarEvento(evento.id())) {
                return null;
            }
            return nuevas.stream().map(n -> repositorio.guardar(n, evento.id())).toList();
        });

        if (guardadas == null) {
            log.info("Evento duplicado descartado: type={} id={}", evento.type(), evento.id());
            return Resultado.DUPLICADO;
        }

        // Simulación del envío (se emite DESPUÉS de confirmar la transacción). Para SEGURIDAD el
        // texto enviado lleva el enlace y el token; lo guardado en BD no.
        for (int i = 0; i < guardadas.size(); i++) {
            Notificacion guardada = guardadas.get(i);
            log.info("[NOTIFICACIÓN] Tipo: {} | Para: {} | Mensaje: \"{}\"",
                    guardada.tipo().etiquetaLog(), guardada.destinatario(), nuevas.get(i).textoAEnviar());
        }
        return Resultado.PROCESADO;
    }
}
