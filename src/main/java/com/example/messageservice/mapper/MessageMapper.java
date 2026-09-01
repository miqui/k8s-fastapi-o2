package com.example.messageservice.mapper;

import com.example.messageservice.model.Message;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Mapper
public interface MessageMapper {

    List<Message> findAll();

    Optional<Message> findById(@Param("id") String id);

    int insert(
            @Param("id") String id,
            @Param("title") String title,
            @Param("content") String content,
            @Param("sender") String sender,
            @Param("createdAt") Instant createdAt
    );

    int update(
            @Param("id") String id,
            @Param("title") String title,
            @Param("content") String content
    );

    int deleteById(@Param("id") String id);

    long count();
}
