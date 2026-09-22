# Database Debug Queries

Sample SQL for poking at both databases directly — useful when a GraphQL response looks wrong
and you want to check what's actually in Postgres, bypassing the API entirely. One section per
database, since Postgres doesn't support cross-database queries (see below) — `messagedb` belongs
to message-service, `issuedb` to issue-service, both on the same shared `postgres` StatefulSet
(see [README.md](README.md#architecture)).

## Connecting

Port-forward the cluster's Postgres to your machine first:

```bash
kubectl port-forward svc/postgres 5433:5432
```

Then, credentials for the shared bootstrap user (owns both databases — see
`k8s/postgres-init-configmap.yaml`):

```bash
DB_USER=$(kubectl get secret postgres-credentials -o jsonpath='{.data.DB_USER}' | base64 -d)
DB_PASSWORD=$(kubectl get secret postgres-credentials -o jsonpath='{.data.DB_PASSWORD}' | base64 -d)
```

**psql** — connect straight to the database you want (Postgres has no cross-database queries;
`db.schema.table` only resolves against whatever database the connection is already on):

```bash
PGPASSWORD="$DB_PASSWORD" psql -h localhost -p 5433 -U "$DB_USER" -d messagedb
PGPASSWORD="$DB_PASSWORD" psql -h localhost -p 5433 -U "$DB_USER" -d issuedb
```

**DataGrip / other JDBC clients** — either point the connection URL at the database you want:

```
jdbc:postgresql://localhost:5433/messagedb
jdbc:postgresql://localhost:5433/issuedb
```

or use one data source with "Show all databases" enabled (data source **Properties → Schemas**
tab) and switch the query console's database context between `messagedb` and `issuedb` instead of
juggling two connections.

---

## message-service (`messagedb`)

Tables: `authors`, `messages` (see `prisma/schema.prisma`).

### 1. List all authors

```sql
SELECT id, name, email, created_at FROM authors ORDER BY created_at;
```

### 2. List all messages

```sql
SELECT id, title, author_id, version, created_at FROM messages ORDER BY created_at DESC;
```

### 3. Row counts

```sql
SELECT (SELECT count(*) FROM authors) AS authors, (SELECT count(*) FROM messages) AS messages;
```

### 4. A message with its author, joined

```sql
SELECT m.id, m.title, m.version, a.name AS author_name, a.email AS author_email
FROM messages m
JOIN authors a ON a.id = m.author_id
ORDER BY m.created_at DESC
LIMIT 20;
```

### 5. Messages per author (matches the `Author.messages` GraphQL field)

```sql
SELECT a.name, count(m.id) AS message_count
FROM authors a
LEFT JOIN messages m ON m.author_id = a.id
GROUP BY a.id, a.name
ORDER BY message_count DESC;
```

### 6. Check a message's current `version` (debugging a `CONFLICT` from `updateMessage`)

The GraphQL error means the client's `version` argument no longer matches this row — this is the
authoritative value (see the Hazelcast cache note under [README.md's Architecture
section](README.md#architecture) for why the API's own `message` query can briefly lag this after
a burst of writes):

```sql
SELECT id, version, created_at FROM messages WHERE id = '<MESSAGE_ID>';
```

### 7. Find an author with no messages (safe to `deleteAuthor`)

`deleteAuthor` fails with `CONFLICT` while messages still reference it — this finds candidates:

```sql
SELECT a.id, a.name
FROM authors a
LEFT JOIN messages m ON m.author_id = a.id
WHERE m.id IS NULL;
```

### 8. Reproduce the `messages(limit, offset)` pagination order

Same `ORDER BY` the resolver uses (`created_at, id`) — useful for confirming a page boundary by
hand:

```sql
SELECT id, title, created_at
FROM messages
ORDER BY created_at, id
LIMIT 10 OFFSET 20;
```

### 9. Duplicate/near-duplicate emails (shouldn't exist — `email` is unique)

```sql
SELECT email, count(*) FROM authors GROUP BY email HAVING count(*) > 1;
```

### 10. Messages created in the last hour, with author

Useful right after running a k6 script or a batch of manual creates:

```sql
SELECT m.id, m.title, a.name, m.created_at
FROM messages m
JOIN authors a ON a.id = m.author_id
WHERE m.created_at > now() - interval '1 hour'
ORDER BY m.created_at DESC;
```

---

## issue-service (`issuedb`)

Tables: `workspaces`, `projects`, `issues`, `labels`, `comments`, `incidents`, `problems`,
`changes`, `service_requests`, `sla_policies` (see `issue-service/prisma/schema.prisma`).

### 1. List workspaces and projects

```sql
SELECT w.name AS workspace, p.key AS project_key, p.id AS project_id
FROM workspaces w
JOIN projects p ON p.workspace_id = w.id
ORDER BY w.name, p.key;
```

### 2. Issue counts by kind and status (a quick board summary)

```sql
SELECT kind, status, count(*)
FROM issues
GROUP BY kind, status
ORDER BY kind, status;
```

### 3. An issue with its project and workspace, joined

```sql
SELECT i.id, i.title, i.kind, i.status, p.key AS project_key, w.name AS workspace
FROM issues i
JOIN projects p ON p.id = i.project_id
JOIN workspaces w ON w.id = p.workspace_id
WHERE i.id = '<ISSUE_ID>';
```

### 4. All incidents, with severity/status and their parent issue's title

```sql
SELECT inc.id, i.title, inc.severity, inc.status, inc.detected_at, inc.resolved_at
FROM incidents inc
JOIN issues i ON i.id = inc.issue_id
ORDER BY inc.detected_at DESC;
```

### 5. Currently SLA-breached incidents (matches the `incidents(slaBreached: true)` GraphQL filter)

```sql
SELECT inc.id, i.title, inc.severity, inc.status, inc.sla_breach_at
FROM incidents inc
JOIN issues i ON i.id = inc.issue_id
WHERE inc.sla_breach_at < now()
  AND inc.status IN ('INVESTIGATING', 'MITIGATED')
ORDER BY inc.sla_breach_at;
```

### 6. Problems with their linked incidents and changes (root-cause traceability)

```sql
SELECT
  prob.id AS problem_id,
  i.title AS problem_title,
  prob.status,
  prob.root_cause,
  (SELECT count(*) FROM incidents WHERE problem_id = prob.id) AS linked_incidents,
  (SELECT count(*) FROM changes WHERE problem_id = prob.id) AS linked_changes
FROM problems prob
JOIN issues i ON i.id = prob.issue_id
ORDER BY prob.status;
```

### 7. Service requests approaching or past their SLA, with requester

```sql
SELECT sr.id, i.title, sr.requester_email, sr.category, sr.status, sr.due_at, sr.sla_breach_at
FROM service_requests sr
JOIN issues i ON i.id = sr.issue_id
WHERE sr.status NOT IN ('RESOLVED', 'CLOSED')
ORDER BY sr.sla_breach_at NULLS LAST;
```

### 8. SLA policies configured per project (the seed-only config table — see `seed.ts`)

```sql
SELECT p.key AS project_key, sp.kind, sp.severity, sp.category,
       sp.response_target_minutes, sp.resolution_target_minutes
FROM sla_policies sp
JOIN projects p ON p.id = sp.project_id
ORDER BY p.key, sp.kind, sp.severity, sp.category;
```

### 9. Threaded comments on an issue, recursively (matches `Issue.comments { replies }`)

```sql
WITH RECURSIVE thread AS (
  SELECT id, parent_id, author, body, created_at, 0 AS depth
  FROM comments
  WHERE issue_id = '<ISSUE_ID>' AND parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.author, c.body, c.created_at, t.depth + 1
  FROM comments c
  JOIN thread t ON c.parent_id = t.id
)
SELECT repeat('  ', depth) || author || ': ' || body AS comment, created_at
FROM thread
ORDER BY created_at;
```

### 10. Full board-style rollup: every open ticket, of any kind, per project

Reproduces the shape a project board pulls together from several GraphQL fields in one query, for
spotting data inconsistencies (e.g. an `INCIDENT`-kind issue with no matching `incidents` row,
which would show up as a `NULL` here and indicates the create mutation's transaction didn't
complete):

```sql
SELECT
  p.key AS project_key,
  i.kind,
  i.title,
  i.status AS issue_status,
  COALESCE(inc.status::text, prob.status::text, chg.status::text, sr.status::text) AS extension_status
FROM issues i
JOIN projects p ON p.id = i.project_id
LEFT JOIN incidents inc ON inc.issue_id = i.id
LEFT JOIN problems prob ON prob.issue_id = i.id
LEFT JOIN changes chg ON chg.issue_id = i.id
LEFT JOIN service_requests sr ON sr.issue_id = i.id
WHERE i.status NOT IN ('DONE')
ORDER BY p.key, i.created_at;
```
