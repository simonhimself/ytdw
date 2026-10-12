-- Background summary queue (docs/ACCOUNTS.md, Phase 2). Timestamps are epoch milliseconds.
-- Users never delete rows: Remove sets status 'removed', so the rolling 24-hour
-- quota can count every row. The runner prunes finished rows after 24 hours.
CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'done', 'failed', 'removed')),
  attempts INTEGER NOT NULL,
  error TEXT,
  retryable INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  started_at INTEGER
);
CREATE INDEX queue_items_user ON queue_items(user_id, created_at);
CREATE INDEX queue_items_due ON queue_items(status, next_attempt_at);
-- A video is in a user's queue at most once while it is active or failed.
CREATE UNIQUE INDEX queue_items_active_video ON queue_items(user_id, video_id) WHERE status IN ('queued', 'processing', 'failed');
