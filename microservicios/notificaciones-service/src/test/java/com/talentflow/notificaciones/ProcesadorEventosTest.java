package com.talentflow.notificaciones;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.talentflow.notificaciones.dominio.Notificacion;
import com.talentflow.notificaciones.dominio.NotificacionNueva;
import com.talentflow.notificaciones.dominio.TipoNotificacion;
import com.talentflow.notificaciones.eventos.EventoParser;
import com.talentflow.notificaciones.repositorio.NotificacionRepository;
import com.talentflow.notificaciones.servicio.ConstructorNotificaciones;
import com.talentflow.notificaciones.servicio.ProcesadorEventos;
import com.talentflow.notificaciones.servicio.ProcesadorEventos.Resultado;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

class ProcesadorEventosTest {

    private NotificacionRepository repositorio;
    private ProcesadorEventos procesador;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void preparar() {
        repositorio = mock(NotificacionRepository.class);
        TransactionTemplate transaccion = mock(TransactionTemplate.class);
        when(transaccion.execute(any())).thenAnswer(
                inv -> ((TransactionCallback<Object>) inv.getArgument(0)).doInTransaction(null));
        when(repositorio.guardar(any(), anyString())).thenAnswer(inv -> {
            NotificacionNueva n = inv.getArgument(0);
            return new Notificacion("id-" + n.tipo(), n.tipo(), n.destinatario(), n.mensaje(), Instant.now(),
                    n.empleadoId());
        });
        procesador = new ProcesadorEventos(new EventoParser(new ObjectMapper()), new ConstructorNotificaciones(),
                repositorio, transaccion);
    }

    private static byte[] evento(String id, String tipo, String data) {
        return ("{\"id\":\"" + id + "\",\"type\":\"" + tipo + "\",\"version\":1,"
                + "\"occurredAt\":\"2026-10-10T12:00:00Z\",\"producer\":\"p\",\"data\":" + data + "}")
                .getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void usuarioCreadoGuardaBienvenidaYSeguridadRegistrandoElEventoUnaSolaVez() {
        when(repositorio.registrarEvento("e-1")).thenReturn(true);

        Resultado r = procesador.procesar(evento("e-1", "usuario.creado",
                "{\"empleadoId\":\"E001\",\"email\":\"a@a.com\",\"tokenActivacion\":\"t.t.t\"}"));

        assertThat(r).isEqualTo(Resultado.PROCESADO);
        verify(repositorio, times(1)).registrarEvento("e-1");
        ArgumentCaptor<NotificacionNueva> guardadas = ArgumentCaptor.forClass(NotificacionNueva.class);
        verify(repositorio, times(2)).guardar(guardadas.capture(), anyString());
        assertThat(guardadas.getAllValues()).extracting(NotificacionNueva::tipo)
                .containsExactly(TipoNotificacion.BIENVENIDA, TipoNotificacion.SEGURIDAD);
    }

    @Test
    void unEventoDuplicadoNoGuardaNada() {
        when(repositorio.registrarEvento("e-2")).thenReturn(false);

        Resultado r = procesador.procesar(evento("e-2", "usuario.creado",
                "{\"empleadoId\":\"E001\",\"email\":\"a@a.com\",\"tokenActivacion\":\"t.t.t\"}"));

        assertThat(r).isEqualTo(Resultado.DUPLICADO);
        verify(repositorio, never()).guardar(any(), anyString());
    }

    @Test
    void empleadoCreadoYEmpleadoRetiradoSoloDejanTrazaSinTocarLaBaseDeDatos() {
        assertThat(procesador.procesar(evento("e-3", "empleado.creado",
                "{\"empleadoId\":\"E001\",\"email\":\"a@a.com\"}"))).isEqualTo(Resultado.TRAZA);
        assertThat(procesador.procesar(evento("e-4", "empleado.retirado",
                "{\"empleadoId\":\"E001\",\"email\":\"a@a.com\"}"))).isEqualTo(Resultado.TRAZA);

        verify(repositorio, never()).registrarEvento(anyString());
        verify(repositorio, never()).guardar(any(), anyString());
    }

    @Test
    void cuentaDesactivadaPorRetiroGuardaUnaNotificacionDeCuenta() {
        when(repositorio.registrarEvento("e-5")).thenReturn(true);

        Resultado r = procesador.procesar(evento("e-5", "cuenta.desactivada",
                "{\"empleadoId\":\"E001\",\"email\":\"a@a.com\",\"motivo\":\"RETIRO\",\"permanente\":true}"));

        assertThat(r).isEqualTo(Resultado.PROCESADO);
        ArgumentCaptor<NotificacionNueva> guardada = ArgumentCaptor.forClass(NotificacionNueva.class);
        verify(repositorio, times(1)).guardar(guardada.capture(), anyString());
        assertThat(guardada.getValue().tipo()).isEqualTo(TipoNotificacion.CUENTA);
    }

    @Test
    void unEventoAjenoSeIgnora() {
        assertThat(procesador.procesar(evento("e-6", "empleado.actualizado", "{\"empleadoId\":\"E001\"}")))
                .isEqualTo(Resultado.IGNORADO);
        verify(repositorio, never()).registrarEvento(anyString());
    }
}
