package com.talentflow.notificaciones.config;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Topología (compartida por todo el ecosistema, ver docs/eventos.md):
 * exchange topic durable + una cola durable propia enlazada a los eventos de interés.
 * Spring AMQP (RabbitAdmin) la declara automáticamente al conectar.
 */
@Configuration
public class BrokerConfig {

    @Bean
    public TopicExchange eventosExchange(@Value("${app.broker.exchange}") String nombre) {
        return new TopicExchange(nombre, true, false);
    }

    @Bean
    public Queue notificacionesQueue(@Value("${app.broker.queue}") String nombre) {
        return QueueBuilder.durable(nombre).build();
    }

    // RF-18: empleado.creado y empleado.retirado solo dejan una traza (no envían nada).
    @Bean
    public Binding bindingEmpleadoCreado(Queue notificacionesQueue, TopicExchange eventosExchange) {
        return BindingBuilder.bind(notificacionesQueue).to(eventosExchange).with("empleado.creado");
    }

    @Bean
    public Binding bindingEmpleadoRetirado(Queue notificacionesQueue, TopicExchange eventosExchange) {
        return BindingBuilder.bind(notificacionesQueue).to(eventosExchange).with("empleado.retirado");
    }

    // RF-16: enlace y token de activación / recuperación.
    @Bean
    public Binding bindingUsuarioCreado(Queue notificacionesQueue, TopicExchange eventosExchange) {
        return BindingBuilder.bind(notificacionesQueue).to(eventosExchange).with("usuario.creado");
    }

    @Bean
    public Binding bindingUsuarioRecuperacion(Queue notificacionesQueue, TopicExchange eventosExchange) {
        return BindingBuilder.bind(notificacionesQueue).to(eventosExchange).with("usuario.recuperacion");
    }

    // RF-17: cambios de estado de la cuenta.
    @Bean
    public Binding bindingCuentaActivada(Queue notificacionesQueue, TopicExchange eventosExchange) {
        return BindingBuilder.bind(notificacionesQueue).to(eventosExchange).with("cuenta.activada");
    }

    @Bean
    public Binding bindingCuentaDesactivada(Queue notificacionesQueue, TopicExchange eventosExchange) {
        return BindingBuilder.bind(notificacionesQueue).to(eventosExchange).with("cuenta.desactivada");
    }

    @Bean
    public Binding bindingVacacionesProgramadas(Queue notificacionesQueue, TopicExchange eventosExchange) {
        return BindingBuilder.bind(notificacionesQueue).to(eventosExchange).with("vacaciones.programadas");
    }
}
