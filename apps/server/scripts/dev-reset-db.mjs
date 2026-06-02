// Dev-only: wipe the SQLite DB so each `npm run dev` starts from an empty
// household (fresh first-boot setup). Runs ONCE via the `predev` npm hook —
// `node --watch` restarts on file changes re-exec the entry in-process, NOT the
// npm script, so your owner/profile survives edits within a single dev session.
//
// Resolves the DB path exactly like config.ts: HORIZON_DB_PATH, else
// ${HORIZON_CACHE_DIR ?? <tmpdir>/horizon-cache}/horizon.db. Refuses to run when
// NODE_ENV=production so it can never wipe a real deployment.
import os from 'node:os'
import { rmSync } from 'node:fs'

if (process.env.NODE_ENV === 'production') {
  console.error('dev-reset-db: refusing to run with NODE_ENV=production')
  process.exit(0)
}

const cacheDir = process.env.HORIZON_CACHE_DIR ?? `${os.tmpdir()}/horizon-cache`
const dbPath = process.env.HORIZON_DB_PATH ?? `${cacheDir}/horizon.db`

if (dbPath === ':memory:') {
  console.log('dev-reset-db: in-memory DB, nothing to wipe')
  process.exit(0)
}

// Remove the DB plus its WAL/SHM sidecars (they hold uncommitted state).
let removed = 0
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(dbPath + suffix, { force: true })
    removed++
  } catch (err) {
    console.warn(`dev-reset-db: could not remove ${dbPath}${suffix}: ${err.message}`)
  }
}
console.log(`dev-reset-db: wiped ${dbPath} (+ wal/shm) for a fresh dev session`)
