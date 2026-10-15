-- Daily funnel counts for /stats (docs/OPERATIONS.md). Aggregate only: no user ids.
CREATE TABLE daily_events (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, event)
);
