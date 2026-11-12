package com.talentflow.notificaciones;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

/**
 * Servicio de Notificaciones (Java + Spring Boot).
 * Puramente reactivo: solo consume eventos del broker; REST es únicamente de consulta.
 */
@SpringBootApplication
@ComponentScan(basePackages = "com.talentflow.notificaciones")
public class NotificacionesApplication {

    public static void main(String[] args) {
        SpringApplication.run(NotificacionesApplication.class, args);
    }
}
