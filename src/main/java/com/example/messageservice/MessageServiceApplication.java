package com.example.messageservice;

import io.swagger.v3.oas.annotations.OpenAPIDefinition;
import io.swagger.v3.oas.annotations.info.Info;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;

@SpringBootApplication
@MapperScan("com.example.messageservice.mapper")
@EnableCaching
@OpenAPIDefinition(info = @Info(
		title = "Message Service API",
		version = "0.0.1-SNAPSHOT",
		description = "Spring Boot + MyBatis + PostgreSQL message service."
))
public class MessageServiceApplication {

	public static void main(String[] args) {
		SpringApplication.run(MessageServiceApplication.class, args);
	}

}
