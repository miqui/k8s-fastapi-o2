package com.example.messageservice;

import com.example.messageservice.dto.CreateMessageRequest;
import com.example.messageservice.dto.UpdateMessageRequest;
import com.example.messageservice.model.Message;
import com.example.messageservice.service.MessageService;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.hamcrest.Matchers.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class MessageControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private MessageService messageService;

    @Test
    void shouldGetAllMessages() throws Exception {
        mockMvc.perform(get("/api/messages"))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(header().exists("X-Total-Count"))
                .andExpect(jsonPath("$", not(empty())));
    }

    @Test
    void shouldRespectLimitAndOffsetParameters() throws Exception {
        messageService.createMessage(new CreateMessageRequest("Page 1", "First page item", "erin"));
        messageService.createMessage(new CreateMessageRequest("Page 2", "Second page item", "erin"));

        mockMvc.perform(get("/api/messages").param("limit", "1").param("offset", "0"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(1)))
                .andExpect(header().exists("X-Total-Count"));
    }

    @Test
    void shouldReturn400WhenLimitIsOutOfRange() throws Exception {
        mockMvc.perform(get("/api/messages").param("limit", "0"))
                .andExpect(status().isBadRequest())
                .andExpect(header().string("Content-Type", containsString("application/problem+json")))
                .andExpect(jsonPath("$.status", is(400)));

        mockMvc.perform(get("/api/messages").param("limit", "201"))
                .andExpect(status().isBadRequest())
                .andExpect(header().string("Content-Type", containsString("application/problem+json")))
                .andExpect(jsonPath("$.status", is(400)));
    }

    @Test
    void shouldReturn400WhenOffsetIsNegative() throws Exception {
        mockMvc.perform(get("/api/messages").param("offset", "-1"))
                .andExpect(status().isBadRequest())
                .andExpect(header().string("Content-Type", containsString("application/problem+json")))
                .andExpect(jsonPath("$.status", is(400)));
    }

    @Test
    void shouldCreateMessageSuccessfully() throws Exception {
        CreateMessageRequest request = new CreateMessageRequest("Hello K8s", "Testing message in kind cluster", "alice");

        mockMvc.perform(post("/api/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(header().exists("Location"))
                .andExpect(jsonPath("$.id", notNullValue()))
                .andExpect(jsonPath("$.title", is("Hello K8s")))
                .andExpect(jsonPath("$.content", is("Testing message in kind cluster")))
                .andExpect(jsonPath("$.sender", is("alice")))
                .andExpect(jsonPath("$.createdAt", notNullValue()));
    }

    @Test
    void shouldReturn400ProblemDetailsWhenCreatingInvalidMessage() throws Exception {
        // Missing title, blank content, blank sender
        CreateMessageRequest invalidRequest = new CreateMessageRequest("", " ", "");

        mockMvc.perform(post("/api/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(invalidRequest)))
                .andExpect(status().isBadRequest())
                .andExpect(header().string("Content-Type", containsString("application/problem+json")))
                .andExpect(jsonPath("$.type", is("https://example.com/problems/validation-error")))
                .andExpect(jsonPath("$.title", is("Validation Failed")))
                .andExpect(jsonPath("$.status", is(400)))
                .andExpect(jsonPath("$.detail", notNullValue()))
                .andExpect(jsonPath("$.instance", is("/api/messages")))
                .andExpect(jsonPath("$.invalidParams", hasSize(greaterThanOrEqualTo(1))))
                .andExpect(jsonPath("$.timestamp", notNullValue()));
    }

    @Test
    void shouldGetMessageById() throws Exception {
        Message created = messageService.createMessage(new CreateMessageRequest("Greeting", "Hello World", "bob"));

        mockMvc.perform(get("/api/messages/{id}", created.id()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id", is(created.id())))
                .andExpect(jsonPath("$.title", is("Greeting")))
                .andExpect(jsonPath("$.content", is("Hello World")))
                .andExpect(jsonPath("$.sender", is("bob")));
    }

    @Test
    void shouldReturn404ProblemDetailsWhenMessageNotFound() throws Exception {
        mockMvc.perform(get("/api/messages/{id}", "non-existent-id-12345"))
                .andExpect(status().isNotFound())
                .andExpect(header().string("Content-Type", containsString("application/problem+json")))
                .andExpect(jsonPath("$.type", is("https://example.com/problems/not-found")))
                .andExpect(jsonPath("$.title", is("Resource Not Found")))
                .andExpect(jsonPath("$.status", is(404)))
                .andExpect(jsonPath("$.detail", containsString("non-existent-id-12345")));
    }

    @Test
    void shouldUpdateMessage() throws Exception {
        Message created = messageService.createMessage(new CreateMessageRequest("Original", "Original Content", "charlie"));
        UpdateMessageRequest updateRequest = new UpdateMessageRequest("Updated Title", "Updated Content", created.version());

        mockMvc.perform(put("/api/messages/{id}", created.id())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(updateRequest)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id", is(created.id())))
                .andExpect(jsonPath("$.title", is("Updated Title")))
                .andExpect(jsonPath("$.content", is("Updated Content")))
                .andExpect(jsonPath("$.version", is(created.version() + 1)));
    }

    @Test
    void shouldReturn409ProblemDetailsWhenUpdatingWithStaleVersion() throws Exception {
        Message created = messageService.createMessage(new CreateMessageRequest("Original", "Original Content", "charlie"));
        int staleVersion = created.version() + 1;
        UpdateMessageRequest updateRequest = new UpdateMessageRequest("Updated Title", "Updated Content", staleVersion);

        mockMvc.perform(put("/api/messages/{id}", created.id())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(updateRequest)))
                .andExpect(status().isConflict())
                .andExpect(header().string("Content-Type", containsString("application/problem+json")))
                .andExpect(jsonPath("$.type", is("https://example.com/problems/conflict")))
                .andExpect(jsonPath("$.title", is("Conflict")))
                .andExpect(jsonPath("$.status", is(409)));
    }

    @Test
    void shouldDeleteMessage() throws Exception {
        Message created = messageService.createMessage(new CreateMessageRequest("To Delete", "Delete me", "dave"));

        mockMvc.perform(delete("/api/messages/{id}", created.id()))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/messages/{id}", created.id()))
                .andExpect(status().isNotFound());
    }

    @Test
    void shouldReturn400WhenIdIsBlank() throws Exception {
        mockMvc.perform(get("/api/messages/{id}", "   "))
                .andExpect(status().isBadRequest())
                .andExpect(header().string("Content-Type", containsString("application/problem+json")))
                .andExpect(jsonPath("$.type", is("https://example.com/problems/validation-error")))
                .andExpect(jsonPath("$.title", is("Validation Failed")))
                .andExpect(jsonPath("$.status", is(400)))
                .andExpect(jsonPath("$.invalidParams", hasSize(greaterThanOrEqualTo(1))));
    }

    @Test
    void shouldExposeKubernetesHealthProbes() throws Exception {
        mockMvc.perform(get("/actuator/health/liveness"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status", is("UP")));

        mockMvc.perform(get("/actuator/health/readiness"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status", is("UP")));
    }
}
