PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS classes (
  code         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  teacher_key  TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  max_learners INTEGER NOT NULL DEFAULT 60,
  archived     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS learners (
  id           TEXT PRIMARY KEY,
  class_code   TEXT NOT NULL REFERENCES classes(code) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  joined_at    INTEGER NOT NULL,
  last_sync_at INTEGER NOT NULL,
  removed      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS learners_alias_per_class
  ON learners(class_code, alias) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS learners_by_class ON learners(class_code, removed);

CREATE TABLE IF NOT EXISTS progress (
  learner_id   TEXT PRIMARY KEY REFERENCES learners(id) ON DELETE CASCADE,
  pct          INTEGER NOT NULL DEFAULT 0,
  done_total   INTEGER NOT NULL DEFAULT 0,
  total_items  INTEGER NOT NULL DEFAULT 0,
  stations     INTEGER NOT NULL DEFAULT 0,
  grammar      INTEGER NOT NULL DEFAULT 0,
  reading      INTEGER NOT NULL DEFAULT 0,
  podcast      INTEGER NOT NULL DEFAULT 0,
  conv         INTEGER NOT NULL DEFAULT 0,
  streak_days  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_learner ON events(learner_id, at DESC);
CREATE INDEX IF NOT EXISTS events_by_age ON events(at);
