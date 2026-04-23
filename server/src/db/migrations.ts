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

  file_path       TEXT,
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

const MIGRATIONS: Migration[] = [
  { version: 1, sql: V1_SQL },
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
