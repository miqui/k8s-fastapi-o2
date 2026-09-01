package com.example.messageservice.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateMessageRequest(
    @NotBlank(message = "Title is required and cannot be blank")
    @Size(max = 100, message = "Title cannot exceed 100 characters")
    String title,

    @NotBlank(message = "Content is required and cannot be blank")
    @Size(max = 1000, message = "Content cannot exceed 1000 characters")
    String content,

    @NotBlank(message = "Sender is required and cannot be blank")
    @Size(max = 50, message = "Sender cannot exceed 50 characters")
    String sender
) {}
