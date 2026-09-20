import crypto from 'node:crypto'
import type { DatabaseSync } from '../../../../platform/db/connection.ts'

export interface WebhookKeyRepo {
  /** Generate a new key, replacing the previous one. The plain key is only available here. */
  rotate(): string
  matches(key: string): boolean
}

function hash(key: string): Buffer {
  return crypto.createHash('sha256').update(key).digest()
}

export function createWebhookKeyRepo(db: DatabaseSync): WebhookKeyRepo {
  return {
    rotate() {
      const key = crypto.randomBytes(32).toString('base64url')
      db.prepare(
        `INSERT INTO webhook_keys (id, key_hash, created_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at`,
      ).run(hash(key).toString('hex'), Date.now())
      return key
    },

    matches(key) {
      const row = db.prepare('SELECT key_hash FROM webhook_keys WHERE id = 1').get() as { key_hash: string } | undefined
      if (!row || !key) return false
      return crypto.timingSafeEqual(hash(key), Buffer.from(row.key_hash, 'hex'))
    },
  }
}
