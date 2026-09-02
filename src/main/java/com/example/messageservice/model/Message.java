package com.example.messageservice.model;

import java.io.Serializable;
import java.time.Instant;

// Serializable so Hazelcast can store instances in its distributed cache map (see HazelcastConfig)
public record Message(
    String id,
    String title,
    String content,
    String sender,
    Instant createdAt,
    int version
) implements Serializable {}
