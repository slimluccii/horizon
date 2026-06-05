import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Server version, read once from package.json at import time. */
const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }

export const SERVER_VERSION: string = pkg.version
