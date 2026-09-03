package com.example.messageservice.service;

import com.example.messageservice.dto.CreateMessageRequest;
import com.example.messageservice.dto.PagedResult;
import com.example.messageservice.dto.UpdateMessageRequest;
import com.example.messageservice.exception.ResourceNotFoundException;
import com.example.messageservice.mapper.MessageMapper;
import com.example.messageservice.model.Message;
import jakarta.annotation.PostConstruct;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Service
public class MessageService {

    private final MessageMapper messageMapper;

    public MessageService(MessageMapper messageMapper) {
        this.messageMapper = messageMapper;
    }

    @PostConstruct
    void seedInitialMessage() {
        // Pre-populate with initial sample message, mirroring a fresh deployment's first boot
        if (messageMapper.count() == 0) {
            messageMapper.insert(
                    UUID.randomUUID().toString(),
                    "Welcome to Kubernetes Spring Boot 4",
                    "This is a sample message backed by MyBatis and PostgreSQL on a kind cluster.",
                    "system",
                    Instant.now()
            );
        }
    }

    public PagedResult<Message> getAllMessages(int limit, int offset) {
        List<Message> items = messageMapper.findAll(limit, offset);
        return new PagedResult<>(items, messageMapper.count());
    }

    @Cacheable(value = "messages", key = "#id")
    public Message getMessageById(String id) {
        return messageMapper.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Message with ID '" + id + "' was not found."));
    }

    public Message createMessage(CreateMessageRequest request) {
        String id = UUID.randomUUID().toString();
        Instant createdAt = Instant.now();
        String title = request.title().trim();
        String content = request.content().trim();
        String sender = request.sender().trim();

        messageMapper.insert(id, title, content, sender, createdAt);
        return new Message(id, title, content, sender, createdAt, 0);
    }

    @CacheEvict(value = "messages", key = "#id")
    public Message updateMessage(String id, UpdateMessageRequest request) {
        Message existing = getMessageById(id);
        String updatedTitle = request.title() != null && !request.title().isBlank()
                ? request.title().trim()
                : existing.title();
        String updatedContent = request.content().trim();

        // Guard against request.version() - what the caller actually read - not existing.version(),
        // which was just re-read a line above and would always match (checking the row against
        // itself proves nothing about whether the caller's own read was stale).
        int rowsUpdated = messageMapper.update(id, updatedTitle, updatedContent, request.version());
        if (rowsUpdated == 0) {
            throw new OptimisticLockingFailureException(
                    "Message with ID '" + id + "' has changed since version " + request.version()
                            + " was read; refetch and retry.");
        }
        return new Message(existing.id(), updatedTitle, updatedContent, existing.sender(), existing.createdAt(),
                request.version() + 1);
    }

    @CacheEvict(value = "messages", key = "#id")
    public void deleteMessage(String id) {
        if (messageMapper.deleteById(id) == 0) {
            throw new ResourceNotFoundException("Message with ID '" + id + "' was not found.");
        }
    }
}
