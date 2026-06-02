import { rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * E2E global setup. The first-boot wizard requires an EMPTY household, so we
 * wipe the dedicated e2e SQLite DB before the run (and recreate the cache +
 * media-base dirs). The e2e backend is started by playwright.config's webServer
 * with these exact paths, so deleting the file here guarantees a clean slate
 * regardless of how a previous run ended.
 *
 * Paths are shared with the config via the helpers below so they can't drift.
 */
export const E2E_DIR = path.join(os.tmpdir(), 'horizon-e2e')
export const E2E_DB = path.join(E2E_DIR, 'horizon.db')
export const E2E_CACHE = path.join(E2E_DIR, 'cache')
export const E2E_MEDIA = path.join(E2E_DIR, 'media')

export default function globalSetup(): void {
  // Nuke the whole e2e dir so DB + WAL/SHM + cache all reset together.
  rmSync(E2E_DIR, { recursive: true, force: true })
  mkdirSync(E2E_CACHE, { recursive: true })
  // A media base with two taggable subfolders so the folder-browser step has
  // something real to pick.
  mkdirSync(path.join(E2E_MEDIA, 'Movies'), { recursive: true })
  mkdirSync(path.join(E2E_MEDIA, 'Shows'), { recursive: true })
}
