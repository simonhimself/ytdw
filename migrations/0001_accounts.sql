-- Accounts and personal library (docs/ACCOUNTS.md). Timestamps are epoch milliseconds.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE saved_briefs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  uploader TEXT,
  duration INTEGER NOT NULL,
  summary TEXT NOT NULL,
  transcript_truncated INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  read_at INTEGER,
  UNIQUE (user_id, video_id)
);
CREATE INDEX saved_briefs_user_saved ON saved_briefs(user_id, saved_at DESC);
