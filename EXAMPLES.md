# Query Examples

Example calls against the two GraphQL APIs in this repo, ordered simple to complex: ten for
message-service, ten for issue-service's Jira-lite core, plus six more covering issue-service's
ITSM/ITIL extension (Incident/Problem/Change/ServiceRequest). Every example gives the raw GraphQL
document and an equivalent `curl` one-liner against the local ingress. See [README.md](README.md)
for schema details, error codes, and how each API's pagination style works
([message-service](README.md#pagination),
[issue-service](README.md#issue-service-second-graphql-api)).

Endpoints:

| API | URL |
| :--- | :--- |
| message-service | `http://localhost/graphql` |
| issue-service | `http://localhost/issues/graphql` |

Replace placeholder IDs (`<AUTHOR_ID>`, `<ISSUE_ID>`, etc.) with real ones from your own data —
run example 1 of each section first to find some.

---

## message-service (`http://localhost/graphql`)

Offset/limit pagination via `MessagePage { items, totalCount }` (see
[Pagination](README.md#pagination)).

### 1. List authors

```graphql
query {
  authors {
    id
    name
    email
  }
}
```

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ authors { id name email } }"}'
```

### 2. Get a single author by ID

```graphql
query {
  author(id: "<AUTHOR_ID>") {
    id
    name
    email
    createdAt
  }
}
```

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!) { author(id: $id) { id name email createdAt } }","variables":{"id":"<AUTHOR_ID>"}}'
```

### 3. Get a single message by ID

```graphql
query {
  message(id: "<MESSAGE_ID>") {
    id
    title
    content
    version
  }
}
```

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!) { message(id: $id) { id title content version } }","variables":{"id":"<MESSAGE_ID>"}}'
```

### 4. Create an author

```graphql
mutation {
  createAuthor(input: { name: "Ada Lovelace", email: "ada@example.com" }) {
    id
    name
    email
  }
}
```

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($input: CreateAuthorInput!) { createAuthor(input: $input) { id name email } }","variables":{"input":{"name":"Ada Lovelace","email":"ada@example.com"}}}'
```

### 5. Create a message

```graphql
mutation {
  createMessage(
    input: { title: "Hello", content: "First message", authorId: "<AUTHOR_ID>" }
  ) {
    id
    title
    version
  }
}
```

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($input: CreateMessageInput!) { createMessage(input: $input) { id title version } }","variables":{"input":{"title":"Hello","content":"First message","authorId":"<AUTHOR_ID>"}}}'
```

### 6. Paginate messages — first page

`limit` defaults to 50 (1-200), `offset` to 0. `totalCount` is independent of the page you asked
for, so `ceil(totalCount / limit)` gives the page count.

```graphql
query {
  messages(limit: 10, offset: 0) {
    totalCount
    items {
      id
      title
      author { name }
    }
  }
}
```

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($limit: Int, $offset: Int) { messages(limit: $limit, offset: $offset) { totalCount items { id title author { name } } } }","variables":{"limit":10,"offset":0}}'
```

### 7. Paginate messages — next page

Same query, `offset` advanced by `limit` to walk forward (ordered by `createdAt, id`, so paging
stays stable across ties).

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($limit: Int, $offset: Int) { messages(limit: $limit, offset: $offset) { totalCount items { id title author { name } } } }","variables":{"limit":10,"offset":10}}'
```

### 8. Update a message with optimistic locking

`version` must match the stored row or the mutation fails with a `CONFLICT` error — no `authorId`
field here, authorship is fixed at creation.

```graphql
mutation {
  updateMessage(
    id: "<MESSAGE_ID>"
    input: { title: "Hello (edited)", content: "Updated content", version: 0 }
  ) {
    id
    version
  }
}
```

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($id: ID!, $input: UpdateMessageInput!) { updateMessage(id: $id, input: $input) { id version } }","variables":{"id":"<MESSAGE_ID>","input":{"title":"Hello (edited)","content":"Updated content","version":0}}}'
```

### 9. Nested query: author with their messages

```graphql
query {
  author(id: "<AUTHOR_ID>") {
    name
    messages {
      id
      title
      content
      version
    }
  }
}
```

```bash
curl -s -X POST http://localhost/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!) { author(id: $id) { name messages { id title content version } } }","variables":{"id":"<AUTHOR_ID>"}}'
```

### 10. Full page walk + cleanup in one script

Combines pagination with mutations: fetches every page of messages, then deletes a message and its
now-orphaned author (deleting an author with messages still attached fails with `CONFLICT`).

```bash
#!/usr/bin/env bash
set -eo pipefail
URL="http://localhost/graphql"
LIMIT=25
OFFSET=0

while :; do
  RESP=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
    -d "{\"query\":\"query(\$limit: Int, \$offset: Int) { messages(limit: \$limit, offset: \$offset) { totalCount items { id title } } }\",\"variables\":{\"limit\":$LIMIT,\"offset\":$OFFSET}}")
  echo "$RESP" | jq '.data.messages.items[].title'
  TOTAL=$(echo "$RESP" | jq '.data.messages.totalCount')
  OFFSET=$((OFFSET + LIMIT))
  [ "$OFFSET" -ge "$TOTAL" ] && break
done

# Delete a message, then its author (fails with CONFLICT if other messages remain).
curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"query":"mutation($id: ID!) { deleteMessage(id: $id) }","variables":{"id":"<MESSAGE_ID>"}}'
curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"query":"mutation($id: ID!) { deleteAuthor(id: $id) }","variables":{"id":"<AUTHOR_ID>"}}'
```

---

## issue-service (`http://localhost/issues/graphql`)

Relay-style cursor pagination on `Project.issues` (`IssueConnection` / `IssueEdge` / `PageInfo`) —
`first` bounds the page (default 20, max 100), `after` takes the previous page's `endCursor`. The
cursor is opaque; treat it as a token, not something to construct yourself.

### 1. Get a workspace and its projects

```graphql
query {
  workspace(id: "<WORKSPACE_ID>") {
    id
    name
    projects {
      id
      key
    }
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!) { workspace(id: $id) { id name projects { id key } } }","variables":{"id":"<WORKSPACE_ID>"}}'
```

### 2. Get a single issue by ID

```graphql
query {
  issue(id: "<ISSUE_ID>") {
    id
    title
    status
    priority
    assignee
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!) { issue(id: $id) { id title status priority assignee } }","variables":{"id":"<ISSUE_ID>"}}'
```

### 3. List issues by label

```graphql
query {
  issuesByLabel(labelId: "<LABEL_ID>") {
    id
    title
    status
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($labelId: ID!) { issuesByLabel(labelId: $labelId) { id title status } }","variables":{"labelId":"<LABEL_ID>"}}'
```

### 4. Create an issue

```graphql
mutation {
  createIssue(projectId: "<PROJECT_ID>", title: "Fix login redirect", priority: HIGH) {
    id
    title
    status
    priority
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($projectId: ID!, $title: String!, $priority: Priority!) { createIssue(projectId: $projectId, title: $title, priority: $priority) { id title status priority } }","variables":{"projectId":"<PROJECT_ID>","title":"Fix login redirect","priority":"HIGH"}}'
```

### 5. Move an issue's status

Fails with `NOT_FOUND` if the issue doesn't exist.

```graphql
mutation {
  moveIssue(id: "<ISSUE_ID>", status: IN_PROGRESS) {
    id
    status
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($id: ID!, $status: IssueStatus!) { moveIssue(id: $id, status: $status) { id status } }","variables":{"id":"<ISSUE_ID>","status":"IN_PROGRESS"}}'
```

### 6. Add a comment to an issue

```graphql
mutation {
  addComment(issueId: "<ISSUE_ID>", body: "Reproduced on staging.", author: "grace") {
    id
    body
    author
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($issueId: ID!, $body: String!, $author: String!) { addComment(issueId: $issueId, body: $body, author: $author) { id body author } }","variables":{"issueId":"<ISSUE_ID>","body":"Reproduced on staging.","author":"grace"}}'
```

### 7. Paginate a project's issues — first page

```graphql
query {
  workspace(id: "<WORKSPACE_ID>") {
    projects {
      id
      issues(first: 5) {
        edges {
          cursor
          node { id title status }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

Note: `Project` has no direct `Query` root field — reach it via `workspace(id) { projects { ... } }`.

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!, $first: Int) { workspace(id: $id) { projects { id issues(first: $first) { edges { cursor node { id title status } } pageInfo { hasNextPage endCursor } } } } }","variables":{"id":"<WORKSPACE_ID>","first":5}}'
```

### 8. Paginate a project's issues — next page

Pass the previous page's `endCursor` as `after`; stop once `hasNextPage` is `false`.

```graphql
query {
  workspace(id: "<WORKSPACE_ID>") {
    projects {
      issues(first: 5, after: "<END_CURSOR>") {
        edges {
          cursor
          node { id title status }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!, $first: Int, $after: String) { workspace(id: $id) { projects { issues(first: $first, after: $after) { edges { cursor node { id title status } } pageInfo { hasNextPage endCursor } } } } }","variables":{"id":"<WORKSPACE_ID>","first":5,"after":"<END_CURSOR>"}}'
```

### 9. Filtered pagination + nested labels

Combines the `status` filter with cursor pagination and pulls each issue's labels in the same
round trip.

```graphql
query {
  workspace(id: "<WORKSPACE_ID>") {
    projects {
      key
      issues(status: IN_REVIEW, first: 10, after: "<END_CURSOR>") {
        edges {
          cursor
          node {
            id
            title
            priority
            labels { name color }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!, $status: IssueStatus, $first: Int, $after: String) { workspace(id: $id) { projects { key issues(status: $status, first: $first, after: $after) { edges { cursor node { id title priority labels { name color } } } pageInfo { hasNextPage endCursor } } } } }","variables":{"id":"<WORKSPACE_ID>","status":"IN_REVIEW","first":10,"after":"<END_CURSOR>"}}'
```

### 10. Full page walk over an issue's threaded comments and labels

Walks every page of a project's `IN_PROGRESS` issues, then for the first issue found, fetches its
full comment thread (top-level comments plus replies) and attaches a label — `attachLabel` fails
with `CONFLICT` if the label belongs to a different project than the issue.

```bash
#!/usr/bin/env bash
set -eo pipefail
URL="http://localhost/issues/graphql"
WORKSPACE_ID="<WORKSPACE_ID>"
CURSOR="null"

while :; do
  RESP=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
    -d "{\"query\":\"query(\$id: ID!, \$after: String) { workspace(id: \$id) { projects { issues(status: IN_PROGRESS, first: 20, after: \$after) { edges { cursor node { id title } } pageInfo { hasNextPage endCursor } } } } }\",\"variables\":{\"id\":\"$WORKSPACE_ID\",\"after\":$CURSOR}}")
  echo "$RESP" | jq '.data.workspace.projects[].issues.edges[].node.title'
  HAS_NEXT=$(echo "$RESP" | jq '[.data.workspace.projects[].issues.pageInfo.hasNextPage] | any')
  CURSOR=$(echo "$RESP" | jq '[.data.workspace.projects[].issues.pageInfo.endCursor] | last')
  [ "$HAS_NEXT" != "true" ] && break
done

ISSUE_ID="<ISSUE_ID>"

# Threaded comments: top-level comments, each with its replies.
curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d "{\"query\":\"query(\$id: ID!) { issue(id: \$id) { title comments { id body author replies { id body author } } } }\",\"variables\":{\"id\":\"$ISSUE_ID\"}}"

# Attach a label (CONFLICT if it belongs to a different project).
curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"query":"mutation($issueId: ID!, $labelId: ID!) { attachLabel(issueId: $issueId, labelId: $labelId) { id labels { name } } }","variables":{"issueId":"'"$ISSUE_ID"'","labelId":"<LABEL_ID>"}}'
```

---

## issue-service — ITSM extension (Incident / Problem / Change / ServiceRequest)

`Issue.kind` discriminates a plain `TASK` from one of these; each extension type is reachable
either through its own `Issue` (`issue { incident { ... } }`) or through the dedicated root fields
below. There's no mutation for `SlaPolicy` — it's a seed-only config table (see
[GRAFANA.md](GRAFANA.md#planned-impact-of-the-issue-service-itsm-extension-not-yet-implemented) for
what's still open around it) — but a policy match at creation time is what populates
`slaBreachAt` on an `Incident`/`ServiceRequest` below.

### 11. Create an incident

```graphql
mutation {
  createIncident(projectId: "<PROJECT_ID>", title: "Checkout API 500s", severity: SEV1) {
    id
    status
    severity
    slaBreachAt
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($projectId: ID!, $title: String!, $severity: IncidentSeverity!) { createIncident(projectId: $projectId, title: $title, severity: $severity) { id status severity slaBreachAt } }","variables":{"projectId":"<PROJECT_ID>","title":"Checkout API 500s","severity":"SEV1"}}'
```

### 12. Create a problem, then link the incident to it

```graphql
mutation {
  createProblem(projectId: "<PROJECT_ID>", title: "Checkout DB connection pool exhaustion") {
    id
    status
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($projectId: ID!, $title: String!) { createProblem(projectId: $projectId, title: $title) { id status } }","variables":{"projectId":"<PROJECT_ID>","title":"Checkout DB connection pool exhaustion"}}'
```

```graphql
mutation {
  linkIncidentToProblem(incidentId: "<INCIDENT_ID>", problemId: "<PROBLEM_ID>") {
    id
    problem { id status }
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($incidentId: ID!, $problemId: ID!) { linkIncidentToProblem(incidentId: $incidentId, problemId: $problemId) { id problem { id status } } }","variables":{"incidentId":"<INCIDENT_ID>","problemId":"<PROBLEM_ID>"}}'
```

### 13. Mark the problem a known error, then raise a change to fix it

`moveProblem`'s `rootCause` argument is optional — pass it once the cause is understood, which is
exactly when `status` moves to `KNOWN_ERROR`.

```graphql
mutation {
  moveProblem(
    id: "<PROBLEM_ID>"
    status: KNOWN_ERROR
    rootCause: "Pool max size too low for Black Friday traffic."
  ) {
    id
    status
    rootCause
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($id: ID!, $status: ProblemStatus!, $rootCause: String) { moveProblem(id: $id, status: $status, rootCause: $rootCause) { id status rootCause } }","variables":{"id":"<PROBLEM_ID>","status":"KNOWN_ERROR","rootCause":"Pool max size too low for Black Friday traffic."}}'
```

```graphql
mutation {
  createChange(
    projectId: "<PROJECT_ID>"
    title: "Raise checkout DB pool size"
    type: EMERGENCY
    plannedAt: "2026-09-23T02:00:00Z"
  ) {
    id
    status
    type
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($projectId: ID!, $title: String!, $type: ChangeType!, $plannedAt: String) { createChange(projectId: $projectId, title: $title, type: $type, plannedAt: $plannedAt) { id status type } }","variables":{"projectId":"<PROJECT_ID>","title":"Raise checkout DB pool size","type":"EMERGENCY","plannedAt":"2026-09-23T02:00:00Z"}}'
```

### 14. Create a service request

```graphql
mutation {
  createServiceRequest(
    projectId: "<PROJECT_ID>"
    title: "New laptop for onboarding"
    requesterEmail: "new.hire@example.com"
    category: "hardware"
  ) {
    id
    status
    slaBreachAt
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($projectId: ID!, $title: String!, $requesterEmail: String!, $category: String!) { createServiceRequest(projectId: $projectId, title: $title, requesterEmail: $requesterEmail, category: $category) { id status slaBreachAt } }","variables":{"projectId":"<PROJECT_ID>","title":"New laptop for onboarding","requesterEmail":"new.hire@example.com","category":"hardware"}}'
```

### 15. Board view: a project's incidents, paginated by kind

Reuses `Project.issues`' existing cursor pagination — `kind` is just another filter alongside
`status`, so the page-walk pattern from example 8 applies unchanged.

```graphql
query {
  workspace(id: "<WORKSPACE_ID>") {
    projects {
      issues(kind: INCIDENT, first: 10, after: "<END_CURSOR>") {
        edges {
          cursor
          node {
            id
            title
            incident { severity status }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id: ID!, $kind: IssueKind, $first: Int, $after: String) { workspace(id: $id) { projects { issues(kind: $kind, first: $first, after: $after) { edges { cursor node { id title incident { severity status } } } pageInfo { hasNextPage endCursor } } } } }","variables":{"id":"<WORKSPACE_ID>","kind":"INCIDENT","first":10,"after":"<END_CURSOR>"}}'
```

### 16. Dashboard: cross-project SEV1 triage and SLA-breach queue, paginated

Unlike example 15, these two root fields aren't scoped to one project — `incidents`/
`serviceRequests` are the org-wide views, and both connections carry a `totalCount` for a
dashboard badge alongside the usual cursor `pageInfo`.

```graphql
query {
  incidents(severity: SEV1, slaBreached: true, first: 20) {
    totalCount
    edges {
      cursor
      node {
        id
        status
        slaBreachAt
        issue { title project { key } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

```bash
curl -s -X POST http://localhost/issues/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query($severity: IncidentSeverity, $slaBreached: Boolean, $first: Int) { incidents(severity: $severity, slaBreached: $slaBreached, first: $first) { totalCount edges { cursor node { id status slaBreachAt issue { title project { key } } } } pageInfo { hasNextPage endCursor } } }","variables":{"severity":"SEV1","slaBreached":true,"first":20}}'
```

Walking every page of the SLA-breach queue for service requests instead:

```bash
#!/usr/bin/env bash
set -eo pipefail
URL="http://localhost/issues/graphql"
CURSOR="null"

while :; do
  RESP=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
    -d "{\"query\":\"query(\$after: String) { serviceRequests(slaBreached: true, first: 20, after: \$after) { totalCount edges { cursor node { id category dueAt requesterEmail } } pageInfo { hasNextPage endCursor } } }\",\"variables\":{\"after\":$CURSOR}}")
  echo "$RESP" | jq '.data.serviceRequests.edges[].node'
  HAS_NEXT=$(echo "$RESP" | jq '.data.serviceRequests.pageInfo.hasNextPage')
  CURSOR=$(echo "$RESP" | jq '.data.serviceRequests.pageInfo.endCursor')
  [ "$HAS_NEXT" != "true" ] && break
done
```
