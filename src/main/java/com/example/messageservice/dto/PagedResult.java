package com.example.messageservice.dto;

import java.util.List;

public record PagedResult<T>(List<T> items, long totalCount) {}
