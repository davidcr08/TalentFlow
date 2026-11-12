package com.talentflow.notificaciones.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.amqp.rabbit.core.RabbitAdmin;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import jakarta.annotation.PostConstruct;

/**
 * Topología (compartida por todo el ecosistema, ver docs/eventos.md):
 * exchange topic durable + una cola durable propia enlazada a los eventos de interés.
 * Spring AMQP (RabbitAdmin) la declara automáticamente al conectar.
 */
@Configuration
public class BrokerConfig implements ApplicationListener<ApplicationReadyEvent> {

    private static final Logger log = LoggerFactory.getLogger(BrokerConfig.class);

    static {
        System.err.println("=== BrokerConfig CLASS LOADED (static initializer) ===");
        log.error("=== BrokerConfig CLASS LOADED (static initializer) ===");
    }

    private final AmqpAdmin amqpAdmin;

    public BrokerConfig(AmqpAdmin amqpAdmin) {
        this.amqpAdmin = amqpAdmin;
        System.err.println("=== BrokerConfig CONSTRUCTOR (System.err) ===");
        log.error("=== BrokerConfig CONSTRUCTOR (ERROR level) ===");
    }

    @PostConstruct
    public void init() {
        System.err.println("=== BrokerConfig @PostConstruct (System.err) ===");
        log.error("=== BrokerConfig @PostConstruct ===");
    }

    @Override
    public void onApplicationEvent(ApplicationReadyEvent event) {
        log.error("=== BrokerConfig: ApplicationReadyEvent recibido ===");
        System.err.println("=== BrokerConfig: ApplicationReadyEvent recibido (System.err) ===");
        try {
            if (amqpAdmin instanceof RabbitAdmin rabbitAdmin) {
                log.error("Invocando RabbitAdmin.afterPropertiesSet()...");
                rabbitAdmin.afterPropertiesSet();
                log.error("Declaración de topología RabbitMQ completada");
            } else {
                log.error("AmqpAdmin no es RabbitAdmin: {}", amqpAdmin.getClass().getName());
            }
        } catch (Exception e) {
            log.error("Error declarando topología RabbitMQ: {}", e.getMessage(), e);
        }
    }

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
