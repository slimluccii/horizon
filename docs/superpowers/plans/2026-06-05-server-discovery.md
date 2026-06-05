# Server Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Android TV client discover Horizon servers on the LAN (mDNS + subnet sweep + manual entry) during first-run setup, auto-reconnect on relaunch, and switch servers later — replacing the build-time `BuildConfig.SERVER_URL`.

**Architecture:** Server gains a stable `instanceId` + configurable `serverName`, exposes both on `/health`, and advertises `_horizon._tcp.local` via mDNS. Client gains a discovery layer (NsdManager + sweep + manual) feeding a Compose `ServerPickerScreen`, persists the chosen server in DataStore, late-binds `HorizonApi`, and resolves the start destination at boot.

**Tech Stack:** Server — Fastify, better-sqlite3 (`DatabaseSync`), `bonjour-service`, vitest. Client — Kotlin, Jetpack Compose + tv-material, `NsdManager`, Jetpack DataStore, JUnit4 (JVM unit tests).

**Spec:** `docs/superpowers/specs/2026-06-05-server-discovery-design.md`

**Out of scope (do not touch):** authentication (the client/server auth cutover is a separate concern), HTTPS, cross-subnet sweep, custom-port sweep.

---

## File structure

**Server (`apps/server/`)**
- `src/db/migrations.ts` — add migration v2: `server_meta(key, value)` KV table.
- `src/identity.ts` (new) — `loadIdentity(db, cfg)` → `{ instanceId, serverName, version }`; instanceId persisted in `server_meta`.
- `src/version.ts` (new) — `SERVER_VERSION` read from `package.json` once.
- `src/config.ts` — add `serverName?: string` (`HORIZON_SERVER_NAME`) and `mdnsEnabled: boolean` (`HORIZON_MDNS`, default true).
- `src/mdns.ts` (new) — `startMdns(identity, port)` → `{ stop() }` using `bonjour-service`.
- `src/routes/health.ts` — add `serverName` + `instanceId` to payload (signature gains `identity`).
- `src/server.ts` — thread `identity` into `registerHealth`.
- `src/index.ts` — build identity, start mDNS after `listen`, stop on shutdown signals.
- `test/identity.test.ts`, `test/mdns.test.ts`, `test/health.test.ts` (extend if exists) — new/updated tests.

**Client (`apps/android-tv/app/`)**
- `gradle/libs.versions.toml` + `app/build.gradle.kts` — add DataStore dependency.
- `src/main/java/network/luuk/horizontv/discovery/` (new package):
  - `DiscoveredServer.kt` — data model + `Source` enum + merge function.
  - `HealthProbe.kt` — `suspend fun probe(url): DiscoveredServer?` via OkHttp `/health`.
  - `SubnetSweep.kt` — IP enumeration (`hostsForPrefix`) + sweep runner.
  - `MdnsDiscovery.kt` — NsdManager wrapper → `Flow<DiscoveredServer>`.
  - `UrlNormalizer.kt` — `normalize(input): String?`.
  - `ServerStore.kt` — DataStore persistence of `{ instanceId, lastUrl, name }`.
  - `BootResolver.kt` — pure decision function over an injected probe + mDNS lambda.
- `src/main/java/network/luuk/horizontv/ui/ServerPickerScreen.kt` (new).
- `src/main/java/network/luuk/horizontv/app/AppState.kt` — late-bound `api`.
- `src/main/java/network/luuk/horizontv/HorizonApp.kt` — build store + caps, not api.
- `src/main/java/network/luuk/horizontv/MainActivity.kt` — BOOT start dest + picker route.
- `src/main/java/network/luuk/horizontv/ui/Routes.kt` — `BOOT`, `SERVER_PICKER`.
- `src/main/java/network/luuk/horizontv/ui/ProfileListScreen.kt` — "Switch server" item.
- `src/test/java/network/luuk/horizontv/discovery/` — JVM unit tests for the pure pieces.

---

# Phase 1 — Server

### Task 1: `server_meta` KV table (migration v2)

**Files:**
- Modify: `apps/server/src/db/migrations.ts`
- Test: `apps/server/test/db.migrate.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/db.migrate.test.ts`:

```typescript
it('migrates to v2 and creates server_meta', () => {
  const db = openDatabase(':memory:')
  migrate(db)
  const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  expect(ver).toBe(2)
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all() as { name: string }[]).map(r => r.name)
  expect(names).toContain('server_meta')
})
```

Also update the existing `'is idempotent'` test's expectation `toEqual([1])` → `toEqual([1, 2])`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run test/db.migrate.test.ts`
Expected: FAIL — `user_version` is 1, no `server_meta`.

- [ ] **Step 3: Implement migration v2**

In `apps/server/src/db/migrations.ts`, add after the `V1_SQL` constant:

```typescript
const V2_SQL = `
CREATE TABLE server_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
```

And extend the `MIGRATIONS` array:

```typescript
const MIGRATIONS: Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 2, sql: V2_SQL },
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run test/db.migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/migrations.ts apps/server/test/db.migrate.test.ts
git commit -m "feat(server): add server_meta kv table (migration v2)"
```

---

### Task 2: Version constant

**Files:**
- Create: `apps/server/src/version.ts`

- [ ] **Step 1: Implement (no separate unit test — trivial constant; covered transitively by identity tests)**

`apps/server/src/version.ts`:

```typescript
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Server version, read once from package.json at import time. */
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }

export const SERVER_VERSION: string = pkg.version
```

- [ ] **Step 2: Verify it loads**

Run: `cd apps/server && node --import tsx -e "import('./src/version.ts').then(m => console.log(m.SERVER_VERSION))"`
Expected: prints `0.1.0`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/version.ts
git commit -m "feat(server): expose SERVER_VERSION from package.json"
```

---

### Task 3: Config — server name + mDNS toggle

**Files:**
- Modify: `apps/server/src/config.ts`
- Test: `apps/server/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/config.test.ts` (follow the file's existing env-set/restore pattern):

```typescript
it('reads HORIZON_SERVER_NAME (undefined when unset)', () => {
  delete process.env.HORIZON_SERVER_NAME
  expect(loadConfig().serverName).toBeUndefined()
  process.env.HORIZON_SERVER_NAME = 'Living Room'
  expect(loadConfig().serverName).toBe('Living Room')
  delete process.env.HORIZON_SERVER_NAME
})

it('defaults mdnsEnabled to true, HORIZON_MDNS=0 disables', () => {
  delete process.env.HORIZON_MDNS
  expect(loadConfig().mdnsEnabled).toBe(true)
  process.env.HORIZON_MDNS = '0'
  expect(loadConfig().mdnsEnabled).toBe(false)
  delete process.env.HORIZON_MDNS
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run test/config.test.ts`
Expected: FAIL — `serverName`/`mdnsEnabled` do not exist.

- [ ] **Step 3: Implement**

In `apps/server/src/config.ts`, add to the `Config` interface:

```typescript
  /** Human-friendly server name advertised to clients. Undefined → hostname. */
  serverName: string | undefined
  /** Advertise the server over mDNS. Off in host setups without multicast. */
  mdnsEnabled: boolean
```

And in the returned object inside `loadConfig()`:

```typescript
    serverName: process.env.HORIZON_SERVER_NAME || undefined,
    mdnsEnabled: envBool('HORIZON_MDNS', true),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/config.ts apps/server/test/config.test.ts
git commit -m "feat(server): HORIZON_SERVER_NAME + HORIZON_MDNS config"
```

---

### Task 4: Identity module

**Files:**
- Create: `apps/server/src/identity.ts`
- Test: `apps/server/test/identity.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/test/identity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import os from 'node:os'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { loadIdentity } from '../src/identity.ts'

function db() {
  const d = openDatabase(':memory:')
  migrate(d)
  return d
}

describe('loadIdentity', () => {
  it('generates a stable instanceId persisted across calls', () => {
    const d = db()
    const a = loadIdentity(d, { serverName: undefined })
    const b = loadIdentity(d, { serverName: undefined })
    expect(a.instanceId).toMatch(/[0-9a-f-]{36}/)
    expect(b.instanceId).toBe(a.instanceId)
  })

  it('uses serverName when set, hostname otherwise', () => {
    expect(loadIdentity(db(), { serverName: 'Den' }).serverName).toBe('Den')
    expect(loadIdentity(db(), { serverName: undefined }).serverName).toBe(os.hostname())
  })

  it('exposes the server version', () => {
    expect(loadIdentity(db(), { serverName: undefined }).version).toMatch(/\d+\.\d+\.\d+/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run test/identity.test.ts`
Expected: FAIL — `src/identity.ts` does not exist.

- [ ] **Step 3: Implement**

`apps/server/src/identity.ts`:

```typescript
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from './db/index.ts'
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run test/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/identity.ts apps/server/test/identity.test.ts
git commit -m "feat(server): stable instanceId + serverName identity module"
```

---

### Task 5: `/health` exposes identity

**Files:**
- Modify: `apps/server/src/routes/health.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/test/health.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

`apps/server/test/health.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerHealth } from '../src/routes/health.ts'
import type { Identity } from '../src/identity.ts'

const fakeHw = { ffmpegVersion: '6.0', encoder: 'vaapi' } as any
const identity: Identity = { instanceId: 'id-123', serverName: 'Den', version: '0.1.0' }

describe('GET /health', () => {
  it('returns status + identity fields', async () => {
    const app = Fastify()
    registerHealth(app, fakeHw, identity)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      status: 'ok',
      serverName: 'Den',
      instanceId: 'id-123',
    })
    await app.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run test/health.test.ts`
Expected: FAIL — `registerHealth` takes 2 args; no `serverName`/`instanceId`.

- [ ] **Step 3: Implement**

Replace `apps/server/src/routes/health.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { Identity } from '../identity.ts'

export function registerHealth(app: FastifyInstance, hwAccel: HwAccel, identity: Identity) {
  app.get('/health', async () => ({
    status: 'ok',
    ffmpeg: hwAccel.ffmpegVersion,
    hwAccel: hwAccel.encoder,
    serverName: identity.serverName,
    instanceId: identity.instanceId,
    version: identity.version,
  }))
}
```

In `apps/server/src/server.ts`: import `Identity`, add `identity: Identity` as a parameter to `buildServer`, and change the call site `registerHealth(api, hwAccel)` → `registerHealth(api, hwAccel, identity)`.

```typescript
import type { Identity } from './identity.ts'
// ... in the buildServer signature, add: identity: Identity
// ... at the registration site:
    registerHealth(api, hwAccel, identity)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run test/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (catches buildServer call-site break in index.ts)**

Run: `cd apps/server && npx tsc --noEmit`
Expected: an error at `src/index.ts` where `buildServer(...)` is called without `identity` — fixed in Task 7. If you implement Task 7 first you may reorder; otherwise this error is expected here.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/health.ts apps/server/src/server.ts apps/server/test/health.test.ts
git commit -m "feat(server): expose serverName + instanceId on /health"
```

---

### Task 6: mDNS advertiser

**Files:**
- Modify: `apps/server/package.json` (add `bonjour-service`)
- Create: `apps/server/src/mdns.ts`
- Test: `apps/server/test/mdns.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `cd apps/server && npm install bonjour-service@^1.3.0`
Expected: `bonjour-service` added to `dependencies`.

- [ ] **Step 2: Write the failing test**

`apps/server/test/mdns.test.ts` — inject a fake bonjour to keep the test offline:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { startMdns } from '../src/mdns.ts'
import type { Identity } from '../src/identity.ts'

const identity: Identity = { instanceId: 'id-9', serverName: 'Den', version: '0.1.0' }

describe('startMdns', () => {
  it('publishes a _horizon._tcp service with identity txt and stops cleanly', () => {
    const unpublishAll = vi.fn((cb: () => void) => cb())
    const destroy = vi.fn()
    const publish = vi.fn(() => ({}))
    const fakeBonjour = { publish, unpublishAll, destroy }

    const handle = startMdns(identity, 7777, () => fakeBonjour as any)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Den',
      type: 'horizon',
      port: 7777,
      txt: { id: 'id-9', name: 'Den', v: '0.1.0' },
    }))

    handle.stop()
    expect(unpublishAll).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/server && npx vitest run test/mdns.test.ts`
Expected: FAIL — `src/mdns.ts` does not exist.

- [ ] **Step 4: Implement**

`apps/server/src/mdns.ts`:

```typescript
import { Bonjour } from 'bonjour-service'
import type { Identity } from './identity.ts'

export interface MdnsHandle {
  stop(): void
}

/** Factory injected for tests; defaults to a real Bonjour instance. */
type BonjourLike = {
  publish: (opts: unknown) => unknown
  unpublishAll: (cb: () => void) => void
  destroy: () => void
}

/**
 * Advertise this server as `_horizon._tcp.local` with identity in TXT records.
 * Best-effort: multicast may be unavailable (bridged Docker) — callers treat
 * failure as non-fatal.
 */
export function startMdns(
  identity: Identity,
  port: number,
  makeBonjour: () => BonjourLike = () => new Bonjour() as unknown as BonjourLike,
): MdnsHandle {
  const bonjour = makeBonjour()
  bonjour.publish({
    name: identity.serverName,
    type: 'horizon',
    port,
    txt: { id: identity.instanceId, name: identity.serverName, v: identity.version },
  })
  return {
    stop() {
      bonjour.unpublishAll(() => bonjour.destroy())
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/server && npx vitest run test/mdns.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json apps/server/package-lock.json apps/server/src/mdns.ts apps/server/test/mdns.test.ts
git commit -m "feat(server): advertise _horizon._tcp via mDNS"
```

---

### Task 7: Wire identity + mDNS into boot

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Implement**

In `apps/server/src/index.ts`:

Add imports near the top:

```typescript
import { loadIdentity } from './identity.ts'
import { startMdns } from './mdns.ts'
```

After `db` is opened/migrated and before/around where `buildServer` is called, build identity (the `db` variable is already in scope — it is passed to `buildServer`):

```typescript
  const identity = loadIdentity(db, { serverName: cfg.serverName })
```

Pass `identity` into `buildServer(...)` as the new argument (match the position you added in Task 5's `server.ts` signature — add it right after `cfg`).

After `await app.listen(...)` and the `console.log`, start mDNS:

```typescript
  const mdns = cfg.mdnsEnabled
    ? (() => {
        try {
          const h = startMdns(identity, cfg.port)
          console.log(`mDNS: advertising "${identity.serverName}" as _horizon._tcp`)
          return h
        } catch (err) {
          console.warn('mDNS: advertise failed (multicast unavailable?):', err)
          return null
        }
      })()
    : null

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      mdns?.stop()
      void app.close().then(() => process.exit(0))
    })
  }
```

> Note: if a graceful-shutdown handler already exists in `index.ts`, fold `mdns?.stop()` into it instead of adding a second handler.

- [ ] **Step 2: Typecheck**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Boot smoke test**

Run: `cd apps/server && timeout 6 npm start 2>&1 | head -20 || true`
Expected: logs `Horizon listening on :7777` and `mDNS: advertising "<hostname>" as _horizon._tcp` (or the multicast-unavailable warning — both acceptable).

- [ ] **Step 4: Full server test suite**

Run: `cd apps/server && npx vitest run`
Expected: PASS (the `buildServer` arity change is now satisfied everywhere).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): build identity + start mDNS on boot, stop on shutdown"
```

---

# Phase 2 — Client

> Pure-logic pieces (model/merge, sweep enumeration, url normalize, boot resolver) are TDD'd with JVM unit tests. Platform-bound pieces (NsdManager, DataStore, Compose UI) have no Robolectric in this project, so they are implementation-only tasks verified by build + on-device — called out explicitly.

All client gradle/test commands use the JDK17 toolchain. Prefix every `./gradlew` invocation with:

```bash
cd apps/android-tv
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
GRADLE_OPTS_JDK17='-Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home'
```

…and append `$GRADLE_OPTS_JDK17` to each gradle command.

---

### Task 8: `DiscoveredServer` model + merge

**Files:**
- Create: `app/src/main/java/network/luuk/horizontv/discovery/DiscoveredServer.kt`
- Test: `app/src/test/java/network/luuk/horizontv/discovery/MergeTest.kt`

- [ ] **Step 1: Write the failing test**

`app/src/test/java/network/luuk/horizontv/discovery/MergeTest.kt`:

```kotlin
package network.luuk.horizontv.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

class MergeTest {
    private fun mdns(id: String, name: String, url: String) =
        DiscoveredServer(id, name, url, Source.Mdns, "0.1.0")
    private fun sweep(id: String?, url: String) =
        DiscoveredServer(id, url, url, Source.Sweep, null)

    @Test fun `mdns entry wins over sweep with same instanceId`() {
        val merged = mergeDiscovered(
            listOf(mdns("a", "Den", "http://1.1.1.1:7777")),
            listOf(sweep("a", "http://1.1.1.1:7777")),
        )
        assertEquals(1, merged.size)
        assertEquals("Den", merged[0].name)
        assertEquals(Source.Mdns, merged[0].source)
    }

    @Test fun `sweep-only id is kept`() {
        val merged = mergeDiscovered(
            listOf(mdns("a", "Den", "http://1.1.1.1:7777")),
            listOf(sweep("b", "http://2.2.2.2:7777")),
        )
        assertEquals(2, merged.size)
    }

    @Test fun `null-id sweep hits are kept and not collapsed together`() {
        val merged = mergeDiscovered(
            emptyList(),
            listOf(sweep(null, "http://3.3.3.3:7777"), sweep(null, "http://4.4.4.4:7777")),
        )
        assertEquals(2, merged.size)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*MergeTest' $GRADLE_OPTS_JDK17`
Expected: FAIL — `DiscoveredServer` / `mergeDiscovered` unresolved.

- [ ] **Step 3: Implement**

`app/src/main/java/network/luuk/horizontv/discovery/DiscoveredServer.kt`:

```kotlin
package network.luuk.horizontv.discovery

enum class Source { Mdns, Sweep, Manual }

data class DiscoveredServer(
    val instanceId: String?,
    val name: String,
    val url: String,
    val source: Source,
    val version: String?,
)

/**
 * Merge mDNS + sweep results. Dedupe by instanceId — the mDNS entry wins (it
 * carries the friendly name). Entries with a null instanceId are never
 * collapsed together (we can't prove they're the same server).
 */
fun mergeDiscovered(
    mdns: List<DiscoveredServer>,
    sweep: List<DiscoveredServer>,
): List<DiscoveredServer> {
    val byId = LinkedHashMap<String, DiscoveredServer>()
    val noId = mutableListOf<DiscoveredServer>()
    for (s in mdns + sweep) {
        val id = s.instanceId
        if (id == null) { noId += s; continue }
        val existing = byId[id]
        if (existing == null || (existing.source != Source.Mdns && s.source == Source.Mdns)) {
            byId[id] = s
        }
    }
    return byId.values.toList() + noId
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*MergeTest' $GRADLE_OPTS_JDK17`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/discovery/DiscoveredServer.kt app/src/test/java/network/luuk/horizontv/discovery/MergeTest.kt
git commit -m "feat(androidtv): DiscoveredServer model + merge/dedupe"
```

---

### Task 9: URL normalizer

**Files:**
- Create: `app/src/main/java/network/luuk/horizontv/discovery/UrlNormalizer.kt`
- Test: `app/src/test/java/network/luuk/horizontv/discovery/UrlNormalizerTest.kt`

- [ ] **Step 1: Write the failing test**

`app/src/test/java/network/luuk/horizontv/discovery/UrlNormalizerTest.kt`:

```kotlin
package network.luuk.horizontv.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UrlNormalizerTest {
    @Test fun `bare host gets scheme and default port`() {
        assertEquals("http://192.168.1.5:7777", normalizeServerUrl("192.168.1.5"))
    }
    @Test fun `host with port keeps port`() {
        assertEquals("http://192.168.1.5:8000", normalizeServerUrl("192.168.1.5:8000"))
    }
    @Test fun `scheme preserved, trailing slash trimmed`() {
        assertEquals("http://den.local:7777", normalizeServerUrl("http://den.local:7777/"))
    }
    @Test fun `blank is rejected`() {
        assertNull(normalizeServerUrl("   "))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*UrlNormalizerTest' $GRADLE_OPTS_JDK17`
Expected: FAIL — `normalizeServerUrl` unresolved.

- [ ] **Step 3: Implement**

`app/src/main/java/network/luuk/horizontv/discovery/UrlNormalizer.kt`:

```kotlin
package network.luuk.horizontv.discovery

private const val DEFAULT_PORT = 7777

/**
 * Normalize user/manual input into `http://host:port`. Adds the http scheme if
 * missing, appends the default port if none given, trims a trailing slash.
 * Returns null for blank input.
 */
fun normalizeServerUrl(input: String): String? {
    val trimmed = input.trim().trimEnd('/')
    if (trimmed.isEmpty()) return null
    val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        trimmed
    } else {
        "http://$trimmed"
    }
    val schemeEnd = withScheme.indexOf("://") + 3
    val authority = withScheme.substring(schemeEnd)
    return if (authority.contains(':')) withScheme else "$withScheme:$DEFAULT_PORT"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*UrlNormalizerTest' $GRADLE_OPTS_JDK17`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/discovery/UrlNormalizer.kt app/src/test/java/network/luuk/horizontv/discovery/UrlNormalizerTest.kt
git commit -m "feat(androidtv): manual URL normalizer"
```

---

### Task 10: Subnet host enumeration + /24 gate

**Files:**
- Create: `app/src/main/java/network/luuk/horizontv/discovery/SubnetSweep.kt` (enumeration only this task)
- Test: `app/src/test/java/network/luuk/horizontv/discovery/SubnetSweepTest.kt`

- [ ] **Step 1: Write the failing test**

`app/src/test/java/network/luuk/horizontv/discovery/SubnetSweepTest.kt`:

```kotlin
package network.luuk.horizontv.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubnetSweepTest {
    @Test fun `enumerates 254 hosts for a 24 prefix, excluding self, network, broadcast`() {
        val hosts = hostsForSweep("192.168.1.42", 24)!!
        assertEquals(253, hosts.size) // 254 usable minus self
        assertEquals(true, hosts.contains("192.168.1.1"))
        assertEquals(true, hosts.contains("192.168.1.254"))
        assertEquals(false, hosts.contains("192.168.1.42"))   // self excluded
        assertEquals(false, hosts.contains("192.168.1.0"))    // network
        assertEquals(false, hosts.contains("192.168.1.255"))  // broadcast
    }

    @Test fun `prefix below 24 is rejected as too large`() {
        assertNull(hostsForSweep("10.0.0.5", 16))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*SubnetSweepTest' $GRADLE_OPTS_JDK17`
Expected: FAIL — `hostsForSweep` unresolved.

- [ ] **Step 3: Implement**

`app/src/main/java/network/luuk/horizontv/discovery/SubnetSweep.kt`:

```kotlin
package network.luuk.horizontv.discovery

/**
 * Enumerate sweepable host IPs for [selfIp] on a /[prefix] network. Returns null
 * when the prefix is wider than /24 (too many hosts to brute-force). Excludes
 * the network address, broadcast address, and self.
 */
fun hostsForSweep(selfIp: String, prefix: Int): List<String>? {
    if (prefix < 24) return null
    val octets = selfIp.split('.')
    if (octets.size != 4) return null
    val base = "${octets[0]}.${octets[1]}.${octets[2]}"
    val selfLast = octets[3].toIntOrNull() ?: return null
    return (1..254).filter { it != selfLast }.map { "$base.$it" }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*SubnetSweepTest' $GRADLE_OPTS_JDK17`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/discovery/SubnetSweep.kt app/src/test/java/network/luuk/horizontv/discovery/SubnetSweepTest.kt
git commit -m "feat(androidtv): /24 host enumeration for subnet sweep"
```

---

### Task 11: Health probe (OkHttp `/health`)

**Files:**
- Create: `app/src/main/java/network/luuk/horizontv/discovery/HealthProbe.kt`
- Test: `app/src/test/java/network/luuk/horizontv/discovery/HealthProbeTest.kt` (uses OkHttp `MockWebServer`)

- [ ] **Step 1: Add MockWebServer test dependency**

In `gradle/libs.versions.toml` under `[libraries]`:

```toml
okhttp-mockwebserver = { module = "com.squareup.okhttp3:mockwebserver", version.ref = "okhttp" }
```

In `app/build.gradle.kts` dependencies:

```kotlin
    testImplementation(libs.okhttp.mockwebserver)
```

- [ ] **Step 2: Write the failing test**

`app/src/test/java/network/luuk/horizontv/discovery/HealthProbeTest.kt`:

```kotlin
package network.luuk.horizontv.discovery

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HealthProbeTest {
    @Test fun `parses identity from a healthy server`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(
            """{"status":"ok","serverName":"Den","instanceId":"id-1","version":"0.1.0"}"""
        ))
        server.start()
        val url = server.url("/").toString().trimEnd('/')
        val result = probeHealth(OkHttpClient(), url, Source.Sweep)
        assertEquals("Den", result?.name)
        assertEquals("id-1", result?.instanceId)
        server.shutdown()
    }

    @Test fun `returns null on non-200`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(404))
        server.start()
        val url = server.url("/").toString().trimEnd('/')
        assertNull(probeHealth(OkHttpClient(), url, Source.Sweep))
        server.shutdown()
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*HealthProbeTest' $GRADLE_OPTS_JDK17`
Expected: FAIL — `probeHealth` unresolved.

- [ ] **Step 4: Implement**

`app/src/main/java/network/luuk/horizontv/discovery/HealthProbe.kt`:

```kotlin
package network.luuk.horizontv.discovery

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request

@Serializable
private data class HealthBody(
    val status: String = "",
    val serverName: String? = null,
    val instanceId: String? = null,
    val version: String? = null,
)

private val healthJson = Json { ignoreUnknownKeys = true }

/**
 * GET [baseUrl]/health. Returns a [DiscoveredServer] when the server reports
 * `status:ok`, else null. Never throws — connection failures map to null so the
 * sweep can fire hundreds of these concurrently.
 */
suspend fun probeHealth(client: OkHttpClient, baseUrl: String, source: Source): DiscoveredServer? =
    withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url("$baseUrl/health").get().build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext null
                val body = resp.body?.string().orEmpty()
                val parsed = healthJson.decodeFromString(HealthBody.serializer(), body)
                if (parsed.status != "ok") return@withContext null
                DiscoveredServer(
                    instanceId = parsed.instanceId,
                    name = parsed.serverName ?: baseUrl,
                    url = baseUrl,
                    source = source,
                    version = parsed.version,
                )
            }
        } catch (_: Throwable) {
            null
        }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*HealthProbeTest' $GRADLE_OPTS_JDK17`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gradle/libs.versions.toml app/build.gradle.kts app/src/main/java/network/luuk/horizontv/discovery/HealthProbe.kt app/src/test/java/network/luuk/horizontv/discovery/HealthProbeTest.kt
git commit -m "feat(androidtv): /health probe with identity parsing"
```

---

### Task 12: Sweep runner (probe enumerated hosts with a short per-probe timeout)

**Files:**
- Modify: `app/src/main/java/network/luuk/horizontv/discovery/SubnetSweep.kt`
- Test: `app/src/test/java/network/luuk/horizontv/discovery/SubnetSweepRunnerTest.kt`

- [ ] **Step 1: Write the failing test**

`app/src/test/java/network/luuk/horizontv/discovery/SubnetSweepRunnerTest.kt`:

```kotlin
package network.luuk.horizontv.discovery

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class SubnetSweepRunnerTest {
    @Test fun `sweep collects only hosts that probe positive`() = runBlocking {
        val good = "192.168.1.10"
        val results = sweepHosts(listOf(good, "192.168.1.11", "192.168.1.12")) { ip ->
            if (ip == good) DiscoveredServer("id", "Den", "http://$ip:7777", Source.Sweep, "0.1.0")
            else null
        }
        assertEquals(1, results.size)
        assertEquals(good, results[0].url.removePrefix("http://").removeSuffix(":7777"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*SubnetSweepRunnerTest' $GRADLE_OPTS_JDK17`
Expected: FAIL — `sweepHosts` unresolved.

- [ ] **Step 3: Implement (append to `SubnetSweep.kt`)**

```kotlin
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

/**
 * Probe every host concurrently via [probe] and return the positive hits. The
 * caller supplies [probe] (normally a `/health` call with a short timeout
 * client); injection keeps this unit-testable without real sockets.
 */
suspend fun sweepHosts(
    hosts: List<String>,
    probe: suspend (ip: String) -> DiscoveredServer?,
): List<DiscoveredServer> = coroutineScope {
    hosts.map { ip -> async { probe(ip) } }.awaitAll().filterNotNull()
}
```

> On-device wiring (built in Task 16's screen): construct a short-timeout OkHttp client (connect+read ~800ms) and call `sweepHosts(hostsForSweep(selfIp, prefix) ?: emptyList()) { ip -> probeHealth(client, "http://$ip:7777", Source.Sweep) }`. Bounding to ~32 concurrent is handled by the OkHttp dispatcher's `maxRequests`.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*SubnetSweepRunnerTest' $GRADLE_OPTS_JDK17`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/discovery/SubnetSweep.kt app/src/test/java/network/luuk/horizontv/discovery/SubnetSweepRunnerTest.kt
git commit -m "feat(androidtv): concurrent subnet sweep runner"
```

---

### Task 13: Boot resolver (pure decision logic)

**Files:**
- Create: `app/src/main/java/network/luuk/horizontv/discovery/BootResolver.kt`
- Test: `app/src/test/java/network/luuk/horizontv/discovery/BootResolverTest.kt`

- [ ] **Step 1: Write the failing test**

`app/src/test/java/network/luuk/horizontv/discovery/BootResolverTest.kt`:

```kotlin
package network.luuk.horizontv.discovery

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class BootResolverTest {
    private val saved = SavedServer(instanceId = "id-1", lastUrl = "http://1.1.1.1:7777", name = "Den")

    @Test fun `no saved server -> ShowPicker`() = runBlocking {
        val d = resolveBoot(null, probe = { null }, mdnsFind = { null })
        assertEquals(BootDecision.ShowPicker, d)
    }

    @Test fun `saved reachable with matching id -> Connect lastUrl`() = runBlocking {
        val d = resolveBoot(saved,
            probe = { url -> if (url == saved.lastUrl) "id-1" else null },
            mdnsFind = { null })
        assertEquals(BootDecision.Connect(saved.lastUrl, saved.instanceId, saved.name), d)
    }

    @Test fun `saved moved but mDNS refinds id -> Connect new url`() = runBlocking {
        val d = resolveBoot(saved,
            probe = { null },
            mdnsFind = { id -> if (id == "id-1") "http://2.2.2.2:7777" else null })
        assertEquals(BootDecision.Connect("http://2.2.2.2:7777", "id-1", "Den"), d)
    }

    @Test fun `saved gone and mDNS cannot find -> ShowPicker`() = runBlocking {
        val d = resolveBoot(saved, probe = { null }, mdnsFind = { null })
        assertEquals(BootDecision.ShowPicker, d)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*BootResolverTest' $GRADLE_OPTS_JDK17`
Expected: FAIL — symbols unresolved.

- [ ] **Step 3: Implement**

`app/src/main/java/network/luuk/horizontv/discovery/BootResolver.kt`:

```kotlin
package network.luuk.horizontv.discovery

data class SavedServer(val instanceId: String, val lastUrl: String, val name: String)

sealed interface BootDecision {
    data class Connect(val url: String, val instanceId: String, val name: String) : BootDecision
    data object ShowPicker : BootDecision
}

/**
 * Decide the start destination at boot. Pure over injected effects:
 *  - [probe]: GET url/health, return the reported instanceId or null.
 *  - [mdnsFind]: run mDNS, return the URL advertising the wanted instanceId, or null.
 */
suspend fun resolveBoot(
    saved: SavedServer?,
    probe: suspend (url: String) -> String?,
    mdnsFind: suspend (instanceId: String) -> String?,
): BootDecision {
    if (saved == null) return BootDecision.ShowPicker
    if (probe(saved.lastUrl) == saved.instanceId) {
        return BootDecision.Connect(saved.lastUrl, saved.instanceId, saved.name)
    }
    val refound = mdnsFind(saved.instanceId)
    if (refound != null) return BootDecision.Connect(refound, saved.instanceId, saved.name)
    return BootDecision.ShowPicker
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*BootResolverTest' $GRADLE_OPTS_JDK17`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/discovery/BootResolver.kt app/src/test/java/network/luuk/horizontv/discovery/BootResolverTest.kt
git commit -m "feat(androidtv): pure boot-resolver decision logic"
```

---

### Task 14: ServerStore (DataStore) — implementation-only

**Files:**
- Modify: `gradle/libs.versions.toml`, `app/build.gradle.kts` (DataStore dep)
- Create: `app/src/main/java/network/luuk/horizontv/discovery/ServerStore.kt`

- [ ] **Step 1: Add DataStore dependency**

In `gradle/libs.versions.toml`:

```toml
# [versions]
datastore = "1.1.1"
# [libraries]
androidx-datastore-preferences = { module = "androidx.datastore:datastore-preferences", version.ref = "datastore" }
```

In `app/build.gradle.kts` dependencies:

```kotlin
    implementation(libs.androidx.datastore.preferences)
```

- [ ] **Step 2: Implement**

`app/src/main/java/network/luuk/horizontv/discovery/ServerStore.kt`:

```kotlin
package network.luuk.horizontv.discovery

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.serverDataStore: DataStore<Preferences> by preferencesDataStore("horizon_server")

/** Persists the chosen server so relaunches skip the picker. */
class ServerStore(private val context: Context) {
    private val idKey = stringPreferencesKey("instance_id")
    private val urlKey = stringPreferencesKey("last_url")
    private val nameKey = stringPreferencesKey("name")

    suspend fun read(): SavedServer? {
        val prefs = context.serverDataStore.data.first()
        val id = prefs[idKey] ?: return null
        val url = prefs[urlKey] ?: return null
        val name = prefs[nameKey] ?: url
        return SavedServer(id, url, name)
    }

    suspend fun save(server: SavedServer) {
        context.serverDataStore.edit { prefs ->
            prefs[idKey] = server.instanceId
            prefs[urlKey] = server.lastUrl
            prefs[nameKey] = server.name
        }
    }

    /** Update just the URL after a re-resolve, keeping id + name. */
    suspend fun updateUrl(url: String) {
        context.serverDataStore.edit { prefs -> prefs[urlKey] = url }
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `./gradlew :app:assembleDebug $GRADLE_OPTS_JDK17`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add gradle/libs.versions.toml app/build.gradle.kts app/src/main/java/network/luuk/horizontv/discovery/ServerStore.kt
git commit -m "feat(androidtv): persist chosen server in DataStore"
```

---

### Task 15: MdnsDiscovery (NsdManager) — implementation-only

**Files:**
- Create: `app/src/main/java/network/luuk/horizontv/discovery/MdnsDiscovery.kt`
- Modify: `app/src/main/AndroidManifest.xml` (add `CHANGE_WIFI_MULTICAST_STATE` permission)

- [ ] **Step 1: Add the multicast permission**

In `app/src/main/AndroidManifest.xml`, alongside the existing `uses-permission` lines:

```xml
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
```

- [ ] **Step 2: Implement**

`app/src/main/java/network/luuk/horizontv/discovery/MdnsDiscovery.kt`:

```kotlin
package network.luuk.horizontv.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.ConcurrentLinkedQueue

private const val SERVICE_TYPE = "_horizon._tcp."
private const val TAG = "MdnsDiscovery"

/**
 * Discover `_horizon._tcp` services via NsdManager. Emits a [DiscoveredServer]
 * per resolved service. Resolves are serialized through a queue because
 * NsdManager cannot resolve concurrently before API 31. Holds a multicast lock
 * for the lifetime of the flow collection.
 */
class MdnsDiscovery(context: Context) {
    private val appContext = context.applicationContext
    private val nsd = appContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifi = appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    fun discover(): Flow<DiscoveredServer> = callbackFlow {
        val lock = wifi.createMulticastLock("horizon-mdns").apply {
            setReferenceCounted(false)
            runCatching { acquire() }
        }

        // Serialize resolves: NsdManager rejects concurrent resolveService calls.
        val pending = ConcurrentLinkedQueue<NsdServiceInfo>()
        var resolving = false

        fun resolveNext() {
            if (resolving) return
            val info = pending.poll() ?: return
            resolving = true
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(s: NsdServiceInfo, code: Int) {
                    resolving = false
                    resolveNext()
                }
                override fun onServiceResolved(s: NsdServiceInfo) {
                    val host = s.host?.hostAddress
                    if (host != null) {
                        val attrs = s.attributes
                        fun txt(key: String) = attrs[key]?.toString(Charsets.UTF_8)
                        trySend(
                            DiscoveredServer(
                                instanceId = txt("id"),
                                name = txt("name") ?: s.serviceName,
                                url = "http://$host:${s.port}",
                                source = Source.Mdns,
                                version = txt("v"),
                            )
                        )
                    }
                    resolving = false
                    resolveNext()
                }
            })
        }

        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, code: Int) { close() }
            override fun onStopDiscoveryFailed(t: String, code: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                pending.add(info)
                resolveNext()
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
        }

        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Throwable) {
            Log.w(TAG, "discover failed", e); close()
        }

        awaitClose {
            runCatching { nsd.stopServiceDiscovery(discoveryListener) }
            runCatching { if (lock.isHeld) lock.release() }
        }
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `./gradlew :app:assembleDebug $GRADLE_OPTS_JDK17`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/AndroidManifest.xml app/src/main/java/network/luuk/horizontv/discovery/MdnsDiscovery.kt
git commit -m "feat(androidtv): NsdManager mDNS discovery with multicast lock"
```

---

### Task 16: Late-bound AppState + HorizonApp

**Files:**
- Modify: `app/src/main/java/network/luuk/horizontv/app/AppState.kt`
- Modify: `app/src/main/java/network/luuk/horizontv/HorizonApp.kt`

- [ ] **Step 1: Implement AppState late-binding**

Replace the `AppState` class body in `app/src/main/java/network/luuk/horizontv/app/AppState.kt` (keep imports, add `HorizonApi` builder needs):

```kotlin
class AppState(
    val capabilities: Capabilities,
    val store: ServerStore,
    val mdns: MdnsDiscovery,
) {
    var api: HorizonApi? by mutableStateOf(null)
        private set

    /** Base URL of the connected server — needed for stream + WebSocket URLs
     *  (PlayerScreen) that previously read BuildConfig.SERVER_URL. */
    var serverUrl: String? by mutableStateOf(null)
        private set

    var activeUser: User? by mutableStateOf(null)
        private set

    /** Build the API client once a server is chosen. */
    fun connect(url: String) {
        serverUrl = url
        api = HorizonApi(baseUrl = url)
    }

    @JvmName("updateActiveUser")
    fun setActiveUser(user: User?) {
        activeUser = user
        api?.setActiveUser(user?.id)
    }
}
```

Add the required imports to the file:

```kotlin
import network.luuk.horizontv.discovery.ServerStore
import network.luuk.horizontv.discovery.MdnsDiscovery
```

> Screens currently read `state.api.foo()`. They will switch to `state.api!!.foo()` — safe because every screen except the picker/boot runs only after `connect()`. For screens not otherwise edited (LibraryScreen, ShowDetailScreen, PlayerScreen), do a mechanical `state.api.` → `state.api!!.` replacement in this task.
>
> **PlayerScreen also hardcodes `BuildConfig.SERVER_URL`** in two places (the `ProgressSocket(...)` construction and the `BuildConfig.SERVER_URL + sess.streamUrl` stream-URL prefix). Both must use the connected server instead. Replace `BuildConfig.SERVER_URL` with `state.serverUrl!!` in `PlayerScreen.kt` (the `state` is already `LocalAppState.current` in that composable). Drop the now-unused `import network.luuk.horizontv.BuildConfig` if nothing else references it.

- [ ] **Step 2: Update HorizonApp**

Replace `apps/.../HorizonApp.kt` `onCreate`:

```kotlin
    override fun onCreate() {
        super.onCreate()
        val caps = CapabilitiesProbe.detect(this)
        state = AppState(
            capabilities = caps,
            store = ServerStore(this),
            mdns = MdnsDiscovery(this),
        )
    }
```

Update imports (drop `HorizonApi`, add `ServerStore`, `MdnsDiscovery`).

- [ ] **Step 3: Mechanical api-nullability fixups + build**

Replace `state.api.` with `state.api!!.` in `LibraryScreen.kt`, `ShowDetailScreen.kt`, `PlayerScreen.kt` (and any other `LocalAppState.current.api.` usages). Build:

Run: `./gradlew :app:assembleDebug $GRADLE_OPTS_JDK17`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/app/AppState.kt app/src/main/java/network/luuk/horizontv/HorizonApp.kt app/src/main/java/network/luuk/horizontv/ui/
git commit -m "feat(androidtv): late-bind HorizonApi after server is chosen"
```

---

### Task 17: ServerPickerScreen

**Files:**
- Create: `app/src/main/java/network/luuk/horizontv/ui/ServerPickerScreen.kt`

- [ ] **Step 1: Implement**

`app/src/main/java/network/luuk/horizontv/ui/ServerPickerScreen.kt`:

```kotlin
package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import network.luuk.horizontv.app.LocalAppState
import network.luuk.horizontv.discovery.DiscoveredServer
import network.luuk.horizontv.discovery.SavedServer
import network.luuk.horizontv.discovery.Source
import network.luuk.horizontv.discovery.hostsForSweep
import network.luuk.horizontv.discovery.mergeDiscovered
import network.luuk.horizontv.discovery.normalizeServerUrl
import network.luuk.horizontv.discovery.probeHealth
import network.luuk.horizontv.discovery.sweepHosts
import network.luuk.horizontv.net.localIpv4AndPrefix
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

@Composable
fun ServerPickerScreen(onPicked: () -> Unit) {
    val state = LocalAppState.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var servers by remember { mutableStateOf<List<DiscoveredServer>>(emptyList()) }
    var scanning by remember { mutableStateOf(true) }
    var showManual by remember { mutableStateOf(false) }
    var scanNonce by remember { mutableStateOf(0) }

    fun choose(server: DiscoveredServer) {
        scope.launch {
            state.connect(server.url)
            state.store.save(
                SavedServer(
                    instanceId = server.instanceId ?: server.url,
                    lastUrl = server.url,
                    name = server.name,
                )
            )
            onPicked()
        }
    }

    LaunchedEffect(scanNonce) {
        scanning = true
        servers = emptyList()
        val sweepClient = OkHttpClient.Builder()
            .connectTimeout(800, TimeUnit.MILLISECONDS)
            .readTimeout(800, TimeUnit.MILLISECONDS)
            .build()

        // mDNS — collect up to ~4s into a snapshot list.
        val mdnsHits = withTimeoutOrNull(4_000) {
            state.mdns.discover().toList()
        } ?: emptyList()

        // Sweep — own /24 only.
        val (ip, prefix) = localIpv4AndPrefix(context) ?: (null to 0)
        val sweepHits = if (ip != null) {
            sweepHosts(hostsForSweep(ip, prefix) ?: emptyList()) { host ->
                probeHealth(sweepClient, "http://$host:7777", Source.Sweep)
            }
        } else emptyList()

        servers = mergeDiscovered(mdnsHits, sweepHits)
        scanning = false
    }

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Find your Horizon server")
        if (scanning) Text("Scanning your network…")
        else if (servers.isEmpty()) Text("No servers found. Enter an address manually.")

        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(servers, key = { it.url }) { server ->
                ListItem(
                    selected = false,
                    onClick = { choose(server) },
                    headlineContent = { Text(server.name) },
                    supportingContent = { Text("${server.url}  ·  ${server.source}") },
                )
            }
            item(key = "manual") {
                ListItem(
                    selected = false,
                    onClick = { showManual = true },
                    headlineContent = { Text("Enter address manually") },
                )
            }
            item(key = "rescan") {
                ListItem(
                    selected = false,
                    onClick = { scanNonce++ },
                    headlineContent = { Text("Rescan") },
                )
            }
        }
    }

    if (showManual) {
        ManualEntryDialog(
            onDismiss = { showManual = false },
            onSubmit = { raw ->
                val url = normalizeServerUrl(raw)
                showManual = false
                if (url != null) {
                    scope.launch {
                        val probeClient = OkHttpClient()
                        val hit = probeHealth(probeClient, url, Source.Manual)
                            ?: DiscoveredServer(null, url, url, Source.Manual, null)
                        choose(hit)
                    }
                }
            },
        )
    }
}

@Composable
private fun ManualEntryDialog(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = { if (text.isNotBlank()) onSubmit(text) }) { Text("Connect") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("Server address") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("e.g. 192.168.1.10") },
            )
        },
    )
}
```

> This screen references `localIpv4AndPrefix` — implemented next, in Task 18.

- [ ] **Step 2: (compiles after Task 18 — defer build to there)**

- [ ] **Step 3: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/ui/ServerPickerScreen.kt
git commit -m "feat(androidtv): ServerPicker screen (mDNS + sweep + manual)"
```

---

### Task 18: Local IP/prefix helper

**Files:**
- Create: `app/src/main/java/network/luuk/horizontv/net/LocalNetwork.kt`

- [ ] **Step 1: Implement**

`app/src/main/java/network/luuk/horizontv/net/LocalNetwork.kt`:

```kotlin
package network.luuk.horizontv.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import java.net.Inet4Address

/**
 * Best-effort current IPv4 address + prefix length from the active network.
 * Returns null when no IPv4 link is found (e.g. no connectivity).
 */
fun localIpv4AndPrefix(context: Context): Pair<String, Int>? {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return null
    val network = cm.activeNetwork ?: return null
    val props = cm.getLinkProperties(network) ?: return null
    val v4: LinkAddress = props.linkAddresses.firstOrNull {
        it.address is Inet4Address && !it.address.isLoopbackAddress
    } ?: return null
    val host = v4.address.hostAddress ?: return null
    return host to v4.prefixLength
}
```

- [ ] **Step 2: Build the whole app (picker now resolves)**

Run: `./gradlew :app:assembleDebug $GRADLE_OPTS_JDK17`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/net/LocalNetwork.kt
git commit -m "feat(androidtv): active-network IPv4 + prefix helper"
```

---

### Task 19: BOOT route + nav wiring + switch-server

**Files:**
- Modify: `app/src/main/java/network/luuk/horizontv/ui/Routes.kt`
- Modify: `app/src/main/java/network/luuk/horizontv/MainActivity.kt`
- Modify: `app/src/main/java/network/luuk/horizontv/ui/ProfileListScreen.kt`

- [ ] **Step 1: Add routes**

In `Routes.kt`, add:

```kotlin
    const val BOOT          = "boot"
    const val SERVER_PICKER = "server_picker"
```

- [ ] **Step 2: Boot screen + nav in MainActivity**

In `MainActivity.kt`, set `startDestination = Routes.BOOT` and add the BOOT + SERVER_PICKER composables. Add the boot resolver composable:

```kotlin
                    composable(Routes.BOOT) {
                        BootScreen(
                            onConnected = {
                                nav.navigate(Routes.PROFILE_LIST) {
                                    popUpTo(Routes.BOOT) { inclusive = true }
                                }
                            },
                            onNeedPicker = {
                                nav.navigate(Routes.SERVER_PICKER) {
                                    popUpTo(Routes.BOOT) { inclusive = true }
                                }
                            },
                        )
                    }
                    composable(Routes.SERVER_PICKER) {
                        ServerPickerScreen(onPicked = {
                            nav.navigate(Routes.PROFILE_LIST) {
                                popUpTo(Routes.SERVER_PICKER) { inclusive = true }
                            }
                        })
                    }
```

Create the `BootScreen` composable in a new file `app/src/main/java/network/luuk/horizontv/ui/BootScreen.kt`:

```kotlin
package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.withTimeoutOrNull
import network.luuk.horizontv.app.LocalAppState
import network.luuk.horizontv.discovery.BootDecision
import network.luuk.horizontv.discovery.resolveBoot
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

@Composable
fun BootScreen(onConnected: () -> Unit, onNeedPicker: () -> Unit) {
    val state = LocalAppState.current

    LaunchedEffect(Unit) {
        val saved = state.store.read()
        val client = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build()

        val decision = resolveBoot(
            saved = saved,
            probe = { url ->
                network.luuk.horizontv.discovery.probeHealth(
                    client, url, network.luuk.horizontv.discovery.Source.Manual,
                )?.instanceId
            },
            mdnsFind = { wantedId ->
                withTimeoutOrNull(4_000) {
                    state.mdns.discover()
                        .mapNotNull { if (it.instanceId == wantedId) it.url else null }
                        .first()
                }
            },
        )

        when (decision) {
            is BootDecision.Connect -> {
                state.connect(decision.url)
                if (saved == null || saved.lastUrl != decision.url) {
                    state.store.save(
                        network.luuk.horizontv.discovery.SavedServer(
                            decision.instanceId, decision.url, decision.name,
                        )
                    )
                }
                onConnected()
            }
            BootDecision.ShowPicker -> onNeedPicker()
        }
    }

    Box(Modifier.fillMaxSize()) { Text("Horizon", Modifier.align(Alignment.Center)) }
}
```

- [ ] **Step 3: Switch-server entry on ProfileList**

`ProfileListScreen` takes a new `onSwitchServer: () -> Unit` param; add an item to the list:

In `ProfileListScreen.kt` signature:

```kotlin
fun ProfileListScreen(onUserPicked: () -> Unit, onSwitchServer: () -> Unit) {
```

Add after the `"add"` item in the `LazyColumn`:

```kotlin
                item(key = "switch_server") {
                    ListItem(
                        selected = false,
                        onClick = onSwitchServer,
                        headlineContent = { Text("Switch server") },
                    )
                }
```

And in `MainActivity.kt` where `ProfileListScreen` is invoked, pass:

```kotlin
                        ProfileListScreen(
                            onUserPicked = {
                                nav.navigate(Routes.LIBRARY) {
                                    popUpTo(Routes.PROFILE_LIST) { inclusive = true }
                                }
                            },
                            onSwitchServer = { nav.navigate(Routes.SERVER_PICKER) },
                        )
```

- [ ] **Step 4: Build**

Run: `./gradlew :app:assembleDebug $GRADLE_OPTS_JDK17`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Run all client unit tests**

Run: `./gradlew :app:testDebugUnitTest $GRADLE_OPTS_JDK17`
Expected: PASS (MergeTest, UrlNormalizerTest, SubnetSweepTest, SubnetSweepRunnerTest, HealthProbeTest, BootResolverTest, plus the pre-existing api tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/main/java/network/luuk/horizontv/ui/Routes.kt app/src/main/java/network/luuk/horizontv/MainActivity.kt app/src/main/java/network/luuk/horizontv/ui/ProfileListScreen.kt app/src/main/java/network/luuk/horizontv/ui/BootScreen.kt
git commit -m "feat(androidtv): boot resolver screen, picker route, switch-server"
```

---

### Task 20: Docs

**Files:**
- Modify: `apps/android-tv/README.md`
- Modify: `.env.example` (document `HORIZON_SERVER_NAME`, `HORIZON_MDNS`)

- [ ] **Step 1: Update server env docs**

Add to `.env.example`:

```
# Friendly name advertised to TV clients (defaults to OS hostname)
HORIZON_SERVER_NAME=
# Advertise the server over mDNS (_horizon._tcp). Default on. Note: bridged
# Docker networks block multicast — TV clients then find the server via subnet
# scan or manual entry. Use network_mode: host for in-container mDNS.
HORIZON_MDNS=1
```

- [ ] **Step 2: Update client README**

In `apps/android-tv/README.md`, replace the "set HORIZON_SERVER_URL" first-time-setup step with a note that the app now discovers servers on first launch (mDNS + network scan), and `HORIZON_SERVER_URL` in `local.properties` is only a dev pre-fill for the manual-entry field.

- [ ] **Step 3: Commit**

```bash
git add apps/android-tv/README.md .env.example
git commit -m "docs: server discovery — env vars + first-run flow"
```

---

## Final verification

- [ ] Server: `cd apps/server && npx vitest run && npx tsc --noEmit` → all pass.
- [ ] Client: `cd apps/android-tv && export JAVA_HOME=... && ./gradlew :app:testDebugUnitTest assembleDebug $GRADLE_OPTS_JDK17` → BUILD SUCCESSFUL.
- [ ] On-device (manual, documented — not automated): start the server on the LAN, launch the app on the Shield, confirm the server appears in the picker (mDNS or sweep), pick it, reach the profile list. Kill+relaunch → auto-connects. "Switch server" reopens the picker.
