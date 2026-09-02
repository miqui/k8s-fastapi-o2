CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(36) PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    content VARCHAR(1000) NOT NULL,
    sender VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

-- Added for optimistic locking (see MessageService.updateMessage); this runs on every startup
-- via spring.sql.init.mode=always, so it must stay idempotent for tables that predate this column.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
