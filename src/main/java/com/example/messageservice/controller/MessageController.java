package com.example.messageservice.controller;

import com.example.messageservice.dto.CreateMessageRequest;
import com.example.messageservice.dto.PagedResult;
import com.example.messageservice.dto.UpdateMessageRequest;
import com.example.messageservice.model.Message;
import com.example.messageservice.service.MessageService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.net.URI;
import java.util.List;

@Validated
@RestController
@RequestMapping("/api/messages")
public class MessageController {

    private final MessageService messageService;

    public MessageController(MessageService messageService) {
        this.messageService = messageService;
    }

    @GetMapping
    public ResponseEntity<List<Message>> getAllMessages(
            @RequestParam(defaultValue = "50")
            @Min(value = 1, message = "limit must be at least 1")
            @Max(value = 200, message = "limit must not exceed 200")
            int limit,
            @RequestParam(defaultValue = "0")
            @Min(value = 0, message = "offset must not be negative")
            int offset) {
        PagedResult<Message> page = messageService.getAllMessages(limit, offset);
        return ResponseEntity.ok()
                .header("X-Total-Count", String.valueOf(page.totalCount()))
                .body(page.items());
    }

    @GetMapping("/{id}")
    public ResponseEntity<Message> getMessageById(
            @PathVariable @NotBlank(message = "Message ID cannot be blank") String id) {
        return ResponseEntity.ok(messageService.getMessageById(id));
    }

    @PostMapping
    public ResponseEntity<Message> createMessage(@Valid @RequestBody CreateMessageRequest request) {
        Message created = messageService.createMessage(request);
        URI location = ServletUriComponentsBuilder
                .fromCurrentRequest()
                .path("/{id}")
                .buildAndExpand(created.id())
                .toUri();
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{id}")
    public ResponseEntity<Message> updateMessage(
            @PathVariable @NotBlank(message = "Message ID cannot be blank") String id,
            @Valid @RequestBody UpdateMessageRequest request) {
        return ResponseEntity.ok(messageService.updateMessage(id, request));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteMessage(
            @PathVariable @NotBlank(message = "Message ID cannot be blank") String id) {
        messageService.deleteMessage(id);
        return ResponseEntity.noContent().build();
    }
}
