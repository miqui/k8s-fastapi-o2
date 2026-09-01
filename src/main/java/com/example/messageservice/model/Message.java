package com.example.messageservice.model;

import java.time.Instant;

public record Message(
    String id,
    String title,
    String content,
    String sender,
    Instant createdAt
) {}
