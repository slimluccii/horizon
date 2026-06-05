import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from '../db/connection.ts'
import { SERVER_VERSION } from './version.ts'

export interface Identity {
  instanceId: string
  serverName: string
  version: string
}

const INSTANCE_ID_KEY = 'instance_id'

/** Read the persisted instanceId, generating + storing one on first call. */
function loadInstanceId(db: DatabaseSync): string {
  const row = db.prepare('SELECT value FROM server_meta WHERE key = ?').get(INSTANCE_ID_KEY) as
    | { value: string }
    | undefined
  if (row) return row.value
  const id = randomUUID()
  db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?)').run(INSTANCE_ID_KEY, id)
  return id
}

/** Build the server's identity from the DB + config. instanceId is stable. */
export function loadIdentity(db: DatabaseSync, cfg: { serverName: string | undefined }): Identity {
  return {
    instanceId: loadInstanceId(db),
    serverName: cfg.serverName ?? os.hostname(),
    version: SERVER_VERSION,
  }
}
