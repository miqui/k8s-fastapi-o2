package com.example.messageservice.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record UpdateMessageRequest(
    @Size(max = 100, message = "Title cannot exceed 100 characters")
    String title,

    @NotBlank(message = "Content is required and cannot be blank")
    @Size(max = 1000, message = "Content cannot exceed 1000 characters")
    String content,

    // The version the caller last read (see Message.version()). Optimistic locking only works
    // if this came from the client's own prior read - a server-side re-read here would just
    // check the row against itself and never catch a client acting on stale data. Callers that
    // omit it default to 0, which only succeeds against a never-yet-updated row.
    int version
) {}
