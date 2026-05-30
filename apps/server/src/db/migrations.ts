import type { DatabaseSync } from './index.ts'

interface Migration { version: number; sql: string }

const V1_SQL = `
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE media_items (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK(kind IN ('movie','show','episode')),
  parent_id       TEXT REFERENCES media_items(id) ON DELETE CASCADE,

  title           TEXT NOT NULL,
  sort_year       INTEGER,
  season          INTEGER,
  episode         INTEGER,

  file_path       TEXT UNIQUE,
  duration_sec    REAL,
  resolution      TEXT,
  video_codec     TEXT,
  container       TEXT,
  hdr             TEXT,
  audio_tracks    TEXT,
  subtitle_tracks TEXT,
  mtime_ms        INTEGER,
  size_bytes      INTEGER,

  external_ids    TEXT NOT NULL DEFAULT '{}',
  metadata        TEXT,

  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE INDEX idx_media_kind   ON media_items(kind)                       WHERE deleted_at IS NULL;
CREATE INDEX idx_media_parent ON media_items(parent_id, season, episode) WHERE deleted_at IS NULL;
CREATE INDEX idx_media_title  ON media_items(title)                      WHERE deleted_at IS NULL;

CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id)  ON DELETE CASCADE,
  media_id      TEXT NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, media_id)
);

CREATE TABLE watch_progress (
  user_id     TEXT NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  media_id    TEXT NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  watched     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_id)
);
CREATE INDEX idx_progress_user_updated ON watch_progress(user_id, updated_at DESC);
`

const V2_SQL = `
-- Metadata freshness tracking on media_items.
ALTER TABLE media_items ADD COLUMN tmdb_id              INTEGER;
ALTER TABLE media_items ADD COLUMN metadata_fetched_at  INTEGER;
ALTER TABLE media_items ADD COLUMN metadata_failed_at   INTEGER;
ALTER TABLE media_items ADD COLUMN metadata_failed_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_media_tmdb_id   ON media_items(tmdb_id)             WHERE tmdb_id IS NOT NULL;
CREATE INDEX idx_media_meta_age  ON media_items(metadata_fetched_at) WHERE deleted_at IS NULL;

-- Per-root scan bookkeeping. Lets the dir-mtime gate skip unchanged subtrees
-- across runs.
CREATE TABLE scan_roots (
  root_path        TEXT PRIMARY KEY,
  last_scanned_at  INTEGER NOT NULL DEFAULT 0,
  last_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_count  INTEGER NOT NULL DEFAULT 0
);

-- TMDB /changes feed cursor. One row per kind ('movie' | 'tv') keeping the
-- last successful end_date so the next run resumes the next day.
CREATE TABLE tmdb_changes_cursor (
  kind              TEXT PRIMARY KEY CHECK(kind IN ('movie','tv')),
  last_window_end   INTEGER NOT NULL,
  last_fetched_at   INTEGER NOT NULL
);

-- Scan history (rolling, capped by the worker). Surfaced via /library/scan-status.
CREATE TABLE scan_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger         TEXT NOT NULL CHECK(trigger IN ('boot','cron','manual','watcher','metadata')),
  scope           TEXT NOT NULL,                 -- 'full' or a subtree path
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  items_seen      INTEGER NOT NULL DEFAULT 0,
  items_added     INTEGER NOT NULL DEFAULT 0,
  items_removed   INTEGER NOT NULL DEFAULT 0,
  metadata_refreshed INTEGER NOT NULL DEFAULT 0,
  errors          TEXT                            -- JSON array of strings
);
CREATE INDEX idx_scan_history_started ON scan_history(started_at DESC);
`

const V3_SQL = `
-- Add role column; tie-break by id when created_at matches.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member'));
UPDATE users SET role='owner' WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM users WHERE role='owner');
CREATE UNIQUE INDEX idx_users_one_owner ON users(role) WHERE role='owner';
`

// Singleton row for operator-tunable runtime settings. Chosen over a k/v table
// so each knob gets a native SQL type and a hardcoded default, and the row can
// be updated atomically. The seeded_from_env flag ensures HORIZON_* env vars
// are overlaid exactly once at first boot after upgrade (see bootstrapFromEnv in
// serverSettings.ts). Planned ADR: docs/adr/0002-server-settings-singleton-with-env-overlay.md
const V4_SQL = `
CREATE TABLE server_settings (
  id                           INTEGER PRIMARY KEY CHECK (id = 1),
  scan_concurrency             INTEGER NOT NULL DEFAULT 4,
  scan_cron_hour               INTEGER NOT NULL DEFAULT 3,
  watch_fs                     INTEGER NOT NULL DEFAULT 0,
  watch_debounce_ms            INTEGER NOT NULL DEFAULT 5000,
  metadata_batch_size          INTEGER NOT NULL DEFAULT 50,
  metadata_max_age_movie_days  INTEGER NOT NULL DEFAULT 30,
  metadata_max_age_show_days   INTEGER NOT NULL DEFAULT 7,
  metadata_max_age_episode_days INTEGER NOT NULL DEFAULT 60,
  watched_threshold_pct        INTEGER NOT NULL DEFAULT 90,
  max_sessions                 INTEGER NOT NULL DEFAULT 4,
  ws_grace_ms                  INTEGER NOT NULL DEFAULT 10000,
  ws_attach_ms                 INTEGER NOT NULL DEFAULT 10000,
  max_renditions               INTEGER NOT NULL DEFAULT 3,
  seeded_from_env              INTEGER NOT NULL DEFAULT 0,
  updated_at                   INTEGER NOT NULL
);

INSERT INTO server_settings (
  id, scan_concurrency, scan_cron_hour, watch_fs, watch_debounce_ms,
  metadata_batch_size, metadata_max_age_movie_days, metadata_max_age_show_days,
  metadata_max_age_episode_days, watched_threshold_pct, max_sessions,
  ws_grace_ms, ws_attach_ms, max_renditions, seeded_from_env, updated_at
) VALUES (
  1, 4, 3, 0, 5000, 50, 30, 7, 60, 90, 4, 10000, 10000, 3, 0,
  CAST(strftime('%s', 'now') * 1000 AS INTEGER)
);
`

const MIGRATIONS: Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 2, sql: V2_SQL },
  { version: 3, sql: V3_SQL },
  { version: 4, sql: V4_SQL },
]

/** Apply any migrations whose version is greater than PRAGMA user_version.
 *  Each migration runs in its own transaction; failure rolls back and
 *  leaves user_version at the previous version. */
export function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const pending = MIGRATIONS
    .filter(m => m.version > current)
    .sort((a, b) => a.version - b.version)
  for (const m of pending) {
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, Date.now())
      db.exec('COMMIT')
      console.log(`DB: migrated to v${m.version}`)
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
