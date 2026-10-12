-- Email verification, password reset, and send throttling (docs/ACCOUNTS.md, Phase 1b).
-- Timestamps are epoch milliseconds. Existing accounts stay unverified (NULL).
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id, purpose);
CREATE INDEX auth_tokens_expiry ON auth_tokens(expires_at);

-- One row per email sent; counts per address drive the hourly throttle.
CREATE TABLE email_log (
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX email_log_email ON email_log(email, sent_at);
CREATE INDEX email_log_sent ON email_log(sent_at);
