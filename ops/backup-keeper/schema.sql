-- D1 schema for the backup keeper. One row of state, an append-only dispatch log, a notification log used for de-duplication.
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lock_until INTEGER NOT NULL DEFAULT 0,      -- epoch ms; the lock is free when lock_until < now
  lock_owner TEXT,
  last_dispatch_at INTEGER,                    -- epoch ms of the last dispatch (real or dry-run)
  cooldown_until INTEGER NOT NULL DEFAULT 0,   -- epoch ms; no dispatch before this
  consecutive_dispatch_failures INTEGER NOT NULL DEFAULT 0,
  pending_correlation TEXT,                    -- correlation id of a dispatch not yet matched to a run
  pending_since INTEGER
);
INSERT OR IGNORE INTO state (id) VALUES (1);
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, correlation TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
  dry_run INTEGER NOT NULL, outcome TEXT NOT NULL, run_id TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_kind_key ON notifications (kind, dedupe_key, at);
