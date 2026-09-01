package com.example.messageservice.config;

import org.apache.ibatis.session.SqlSessionFactory;
import org.mybatis.spring.SqlSessionFactoryBean;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import javax.sql.DataSource;

/**
 * Explicit MyBatis wiring.
 *
 * mybatis-spring-boot-starter's own auto-configuration relies on
 * {@code @AutoConfigureAfter(DataSourceAutoConfiguration.class)} to run after the
 * DataSource is registered, but that class moved packages in Spring Boot 4
 * (now {@code org.springframework.boot.jdbc.autoconfigure}), so mybatis-spring-boot-starter
 * 3.0.4's ordering no longer takes effect and its {@code SqlSessionFactory} bean never gets
 * created. Defining it here resolves {@link DataSource} through normal bean wiring instead,
 * which isn't order-sensitive.
 */
@Configuration
public class MyBatisConfig {

    @Bean
    public SqlSessionFactory sqlSessionFactory(DataSource dataSource) throws Exception {
        SqlSessionFactoryBean factoryBean = new SqlSessionFactoryBean();
        factoryBean.setDataSource(dataSource);
        factoryBean.setMapperLocations(new PathMatchingResourcePatternResolver().getResources("classpath:mapper/*.xml"));

        org.apache.ibatis.session.Configuration mybatisConfiguration = new org.apache.ibatis.session.Configuration();
        mybatisConfiguration.setMapUnderscoreToCamelCase(true);
        factoryBean.setConfiguration(mybatisConfiguration);

        return factoryBean.getObject();
    }

    @Bean
    public SqlSessionTemplate sqlSessionTemplate(SqlSessionFactory sqlSessionFactory) {
        return new SqlSessionTemplate(sqlSessionFactory);
    }
}
