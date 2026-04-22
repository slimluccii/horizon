# Horizon Streaming Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Horizon — a personal media streaming server with HLS transcoding, multi-rendition adaptive bitrate, hardware acceleration, WebSocket session control, TypeScript SDK, and React test app.

**Architecture:** Fastify server manages FFmpeg processes per session, serving HLS segments from temp dirs. Clients negotiate capabilities via POST /sessions; multi-rendition HLS master playlist enables client-side ABR (hls.js) without FFmpeg restarts on quality switch. WebSocket per session handles bandwidth reports, seeks, track switches, and disconnect lifecycle with 10s grace window.

**Tech Stack:** Node.js 20+, TypeScript 5, Fastify 4, @fastify/websocket 8, FFmpeg (system), hls.js 1.5, React 18, Vite 5, Vitest 1, Supertest 6

---

## File Map

```
horizon/
├── package.json                          # npm workspaces root
├── tsconfig.base.json                    # shared TS config
│
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                      # entrypoint: build + start
│       ├── server.ts                     # Fastify factory + plugin registration
│       ├── config.ts                     # env var parsing + defaults
│       ├── scanner/
│       │   ├── probe.ts                  # ffprobe wrapper + disk cache
│       │   ├── scanner.ts                # dir walker, in-memory index
│       │   └── collections.ts            # collection grouping logic
│       ├── transcode/
│       │   ├── hwaccel.ts                # detect encoder/decoder at startup
│       │   ├── profiles.ts               # bitrate ladder definitions
│       │   ├── decision.ts               # playback method decision tree
│       │   └── ffmpeg.ts                 # spawn/kill FFmpeg, segment pipeline
│       ├── session/
│       │   ├── manager.ts                # session map, TTL, grace window
│       │   └── types.ts                  # Session, SessionState interfaces
│       ├── ws/
│       │   └── handler.ts                # WebSocket message dispatch + ABR logic
│       └── routes/
│           ├── health.ts
│           ├── library.ts
│           └── sessions.ts               # REST + segment serving + WS upgrade
│   └── test/
│       ├── probe.test.ts
│       ├── collections.test.ts
│       ├── decision.test.ts
│       ├── profiles.test.ts
│       └── abr.test.ts
│
├── sdk/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                      # public exports
│       ├── types.ts                      # shared interfaces
│       ├── client.ts                     # HorizonClient: library + play()
│       ├── session.ts                    # PlaybackSession: WS lifecycle
│       ├── capabilities.ts               # MediaSource.isTypeSupported detection
│       └── bandwidth.ts                  # per-segment measurement + reporting
│   └── test/
│       ├── capabilities.test.ts
│       └── abr.test.ts
│
└── app/
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx                       # router setup
        ├── horizon.ts                    # SDK client singleton
        ├── pages/
        │   ├── Library.tsx
        │   └── Player.tsx
        └── components/
            ├── MediaCard.tsx
            ├── VideoPlayer.tsx           # hls.js + direct play
            └── QualityOverlay.tsx        # method badge, buffer bar, log
```

---

## Task 1: Monorepo Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `sdk/package.json`
- Create: `sdk/tsconfig.json`
- Create: `app/package.json`
- Create: `app/tsconfig.json`

- [ ] **Step 1: Create root workspace**

```json
// package.json
{
  "name": "horizon",
  "private": true,
  "workspaces": ["server", "sdk", "app"],
  "scripts": {
    "dev:server": "npm -w server run dev",
    "dev:app": "npm -w app run dev",
    "test": "npm -w server run test && npm -w sdk run test"
  }
}
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 2: Create server package**

```json
// server/package.json
{
  "name": "@horizon/server",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "node --watch --loader ts-node/esm src/index.ts",
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^4.28.1",
    "@fastify/websocket": "^8.3.1",
    "@fastify/cors": "^9.0.1"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "ts-node": "^10.9.2",
    "vitest": "^1.6.0",
    "supertest": "^6.3.4",
    "@types/node": "^20.12.7",
    "@types/supertest": "^6.0.2"
  }
}
```

```json
// server/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Create SDK package**

```json
// sdk/package.json
{
  "name": "@horizon/sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "peerDependencies": {
    "hls.js": "^1.5.0"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "vitest": "^1.6.0",
    "jsdom": "^24.0.0",
    "@vitest/browser": "^1.6.0",
    "hls.js": "^1.5.13"
  }
}
```

```json
// sdk/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 4: Create app package**

```json
// app/package.json
{
  "name": "@horizon/app",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@horizon/sdk": "*",
    "hls.js": "^1.5.13",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.23.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.2.1",
    "typescript": "^5.4.5",
    "vite": "^5.2.11"
  }
}
```

```json
// app/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Install all dependencies**

```bash
cd /Users/luuk/Projects/slimluccii/horizon
npm install
```

Expected: workspace symlinks created, `node_modules` populated.

- [ ] **Step 6: Commit**

```bash
git init
git add package.json tsconfig.base.json server/package.json server/tsconfig.json sdk/package.json sdk/tsconfig.json app/package.json app/tsconfig.json
git commit -m "chore: monorepo scaffold with npm workspaces"
```

---

## Task 2: Config + Server Skeleton

**Files:**
- Create: `server/src/config.ts`
- Create: `server/src/server.ts`
- Create: `server/src/index.ts`
- Create: `server/src/routes/health.ts`

- [ ] **Step 1: Write config test**

```typescript
// server/test/config.test.ts
import { describe, it, expect, beforeEach } from 'vitest'

describe('config', () => {
  beforeEach(() => {
    delete process.env.HORIZON_PORT
    delete process.env.HORIZON_MOVIES_ROOT
    delete process.env.HORIZON_SHOWS_ROOT
    delete process.env.HORIZON_CORS_ORIGINS
    delete process.env.HORIZON_CACHE_DIR
    delete process.env.HORIZON_MAX_SESSIONS
    delete process.env.HORIZON_WS_GRACE_MS
    delete process.env.HORIZON_WS_ATTACH_MS
    delete process.env.HORIZON_MAX_RENDITIONS
  })

  it('returns defaults when env vars not set', async () => {
    const { loadConfig } = await import('../src/config.ts')
    const cfg = loadConfig()
    expect(cfg.port).toBe(7777)
    expect(cfg.maxSessions).toBe(4)
    expect(cfg.wsGraceMs).toBe(10000)
    expect(cfg.wsAttachMs).toBe(10000)
    expect(cfg.maxRenditions).toBe(3)
    expect(cfg.moviesRoots).toEqual([])
    expect(cfg.showsRoots).toEqual([])
  })

  it('parses env vars', async () => {
    process.env.HORIZON_PORT = '8888'
    process.env.HORIZON_MOVIES_ROOT = '/movies1:/movies2'
    process.env.HORIZON_MAX_SESSIONS = '2'
    const { loadConfig } = await import('../src/config.ts')
    const cfg = loadConfig()
    expect(cfg.port).toBe(8888)
    expect(cfg.moviesRoots).toEqual(['/movies1', '/movies2'])
    expect(cfg.maxSessions).toBe(2)
  })
})
```

- [ ] **Step 2: Run test — expect fail**

```bash
cd server && npx vitest run test/config.test.ts
```

Expected: `FAIL — Cannot find module '../src/config.ts'`

- [ ] **Step 3: Implement config**

```typescript
// server/src/config.ts
import os from 'node:os'

export interface Config {
  port: number
  moviesRoots: string[]
  showsRoots: string[]
  corsOrigins: string[]
  cacheDir: string
  maxSessions: number
  wsGraceMs: number
  wsAttachMs: number
  maxRenditions: number
  forceEncoder: string | undefined
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.HORIZON_PORT ?? '7777'),
    moviesRoots: (process.env.HORIZON_MOVIES_ROOT ?? '').split(':').filter(Boolean),
    showsRoots: (process.env.HORIZON_SHOWS_ROOT ?? '').split(':').filter(Boolean),
    corsOrigins: (process.env.HORIZON_CORS_ORIGINS ?? '*').split(',').filter(Boolean),
    cacheDir: process.env.HORIZON_CACHE_DIR ?? `${os.tmpdir()}/horizon-cache`,
    maxSessions: parseInt(process.env.HORIZON_MAX_SESSIONS ?? '4'),
    wsGraceMs: parseInt(process.env.HORIZON_WS_GRACE_MS ?? '10000'),
    wsAttachMs: parseInt(process.env.HORIZON_WS_ATTACH_MS ?? '10000'),
    maxRenditions: parseInt(process.env.HORIZON_MAX_RENDITIONS ?? '3'),
    forceEncoder: process.env.HORIZON_FORCE_ENCODER,
  }
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd server && npx vitest run test/config.test.ts
```

Expected: `PASS`

- [ ] **Step 5: Implement server factory + health route**

```typescript
// server/src/routes/health.ts
import type { FastifyInstance } from 'fastify'
import type { HwAccel } from '../transcode/hwaccel.ts'

export function registerHealth(app: FastifyInstance, hwAccel: HwAccel) {
  app.get('/health', async () => ({
    status: 'ok',
    ffmpeg: hwAccel.ffmpegVersion,
    hwAccel: hwAccel.encoder,
  }))
}
```

```typescript
// server/src/server.ts
import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import type { Config } from './config.ts'
import type { HwAccel } from './transcode/hwaccel.ts'
import type { LibraryIndex } from './scanner/scanner.ts'
import type { SessionManager } from './session/manager.ts'
import { registerHealth } from './routes/health.ts'
import { registerLibrary } from './routes/library.ts'
import { registerSessions } from './routes/sessions.ts'

export async function buildServer(
  cfg: Config,
  hwAccel: HwAccel,
  index: LibraryIndex,
  sessions: SessionManager,
) {
  const app = Fastify({ logger: true })

  await app.register(fastifyCors, {
    origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins,
  })
  await app.register(fastifyWebSocket)

  registerHealth(app, hwAccel)
  registerLibrary(app, index)
  registerSessions(app, cfg, hwAccel, index, sessions)

  return app
}
```

```typescript
// server/src/index.ts
import { loadConfig } from './config.ts'
import { detectHwAccel } from './transcode/hwaccel.ts'
import { createScanner } from './scanner/scanner.ts'
import { createSessionManager } from './session/manager.ts'
import { buildServer } from './server.ts'

async function main() {
  const cfg = loadConfig()
  const hwAccel = await detectHwAccel(cfg.forceEncoder)
  const index = await createScanner(cfg)
  const sessions = createSessionManager(cfg)
  const app = await buildServer(cfg, hwAccel, index, sessions)

  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`Horizon listening on :${cfg.port}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 6: Commit**

```bash
git add server/src/config.ts server/src/server.ts server/src/index.ts server/src/routes/health.ts server/test/config.test.ts
git commit -m "feat(server): config parsing, server factory, health route"
```

---

## Task 3: ffprobe + Probe Cache

**Files:**
- Create: `server/src/scanner/probe.ts`
- Create: `server/test/probe.test.ts`

- [ ] **Step 1: Write probe tests**

```typescript
// server/test/probe.test.ts
import { describe, it, expect } from 'vitest'
import { parseProbeOutput } from '../src/scanner/probe.ts'

const FAKE_PROBE_OUTPUT = JSON.stringify({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'hevc',
      width: 3840,
      height: 2160,
      bit_rate: '40000000',
      color_transfer: 'smpte2084',
      side_data_list: [
        { side_data_type: 'Mastering display metadata' },
        { side_data_type: 'DOVI configuration record', dv_profile: 7 },
      ],
    },
    {
      codec_type: 'audio',
      codec_name: 'truehd',
      channels: 8,
      tags: { language: 'eng', title: 'Atmos' },
      disposition: { default: 1 },
    },
    {
      codec_type: 'audio',
      codec_name: 'ac3',
      channels: 6,
      tags: { language: 'eng', title: 'AC3' },
      disposition: { default: 0 },
    },
    {
      codec_type: 'subtitle',
      codec_name: 'hdmv_pgs_subtitle',
      tags: { language: 'eng' },
      disposition: { forced: 0 },
    },
    {
      codec_type: 'subtitle',
      codec_name: 'subrip',
      tags: { language: 'eng' },
      disposition: { forced: 0 },
    },
  ],
  format: {
    duration: '9000.5',
    bit_rate: '42000000',
    format_name: 'matroska,webm',
  },
})

describe('parseProbeOutput', () => {
  it('extracts video info', () => {
    const result = parseProbeOutput(FAKE_PROBE_OUTPUT)
    expect(result.resolution).toBe('3840x2160')
    expect(result.videoCodec).toBe('hevc')
    expect(result.duration).toBe(9000.5)
  })

  it('detects Dolby Vision + HDR10', () => {
    const result = parseProbeOutput(FAKE_PROBE_OUTPUT)
    expect(result.hdr.dv).toBe(true)
    expect(result.hdr.dvProfile).toBe(7)
    expect(result.hdr.hdr10).toBe(true)
  })

  it('extracts audio tracks', () => {
    const result = parseProbeOutput(FAKE_PROBE_OUTPUT)
    expect(result.audioTracks).toHaveLength(2)
    expect(result.audioTracks[0].codec).toBe('truehd')
    expect(result.audioTracks[0].channels).toBe(8)
    expect(result.audioTracks[0].default).toBe(true)
    expect(result.audioTracks[1].codec).toBe('ac3')
  })

  it('marks PGS subtitle as not embeddable', () => {
    const result = parseProbeOutput(FAKE_PROBE_OUTPUT)
    const pgs = result.subtitleTracks.find(s => s.codec === 'hdmv_pgs_subtitle')
    expect(pgs?.embeddable).toBe(false)
  })

  it('marks SRT subtitle as embeddable', () => {
    const result = parseProbeOutput(FAKE_PROBE_OUTPUT)
    const srt = result.subtitleTracks.find(s => s.codec === 'subrip')
    expect(srt?.embeddable).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
cd server && npx vitest run test/probe.test.ts
```

Expected: `FAIL — Cannot find module '../src/scanner/probe.ts'`

- [ ] **Step 3: Implement probe.ts**

```typescript
// server/src/scanner/probe.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const execFileAsync = promisify(execFile)

export interface AudioTrack {
  index: number
  codec: string
  channels: number
  language: string
  title: string
  default: boolean
}

export interface SubtitleTrack {
  index: number
  codec: string
  language: string
  forced: boolean
  embeddable: boolean
}

export interface HdrInfo {
  dv: boolean
  dvProfile?: number
  hdr10: boolean
  hdr10plus: boolean
}

export interface ProbeResult {
  duration: number
  resolution: string
  videoCodec: string
  videoBitrate: number
  hdr: HdrInfo
  audioTracks: AudioTrack[]
  subtitleTracks: SubtitleTrack[]
  container: string
}

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'])

export function parseProbeOutput(stdout: string): ProbeResult {
  const data = JSON.parse(stdout)
  const streams = data.streams as any[]
  const format = data.format as any

  const video = streams.find(s => s.codec_type === 'video')
  const audioStreams = streams.filter(s => s.codec_type === 'audio')
  const subStreams = streams.filter(s => s.codec_type === 'subtitle')

  const dvData = video?.side_data_list?.find(
    (s: any) => s.side_data_type === 'DOVI configuration record'
  )
  const hdr10Data = video?.side_data_list?.find(
    (s: any) => s.side_data_type === 'Mastering display metadata'
  )
  const hdr10plusData = video?.side_data_list?.find(
    (s: any) => s.side_data_type === 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)'
  )

  return {
    duration: parseFloat(format.duration ?? '0'),
    resolution: `${video?.width ?? 0}x${video?.height ?? 0}`,
    videoCodec: video?.codec_name ?? 'unknown',
    videoBitrate: parseInt(video?.bit_rate ?? format.bit_rate ?? '0'),
    hdr: {
      dv: !!dvData,
      dvProfile: dvData?.dv_profile,
      hdr10: !!hdr10Data || video?.color_transfer === 'smpte2084',
      hdr10plus: !!hdr10plusData,
    },
    audioTracks: audioStreams.map((s, i) => ({
      index: i,
      codec: s.codec_name,
      channels: s.channels,
      language: s.tags?.language ?? 'und',
      title: s.tags?.title ?? '',
      default: s.disposition?.default === 1,
    })),
    subtitleTracks: subStreams.map((s, i) => ({
      index: i,
      codec: s.codec_name,
      language: s.tags?.language ?? 'und',
      forced: s.disposition?.forced === 1,
      embeddable: TEXT_SUB_CODECS.has(s.codec_name),
    })),
    container: format.format_name,
  }
}

interface CacheEntry { key: string; result: ProbeResult }

function cacheKey(filePath: string, mtimeMs: number, size: number) {
  return crypto.createHash('sha1')
    .update(`${filePath}:${mtimeMs}:${size}`)
    .digest('hex')
}

async function readCache(cacheDir: string, key: string): Promise<CacheEntry | null> {
  const entryPath = path.join(cacheDir, `${key.slice(0, 8)}.json`)
  try {
    const raw = await readFile(entryPath, 'utf8')
    return JSON.parse(raw) as CacheEntry
  } catch {
    return null
  }
}

async function writeCache(cacheDir: string, key: string, result: ProbeResult) {
  await mkdir(cacheDir, { recursive: true })
  const entryPath = path.join(cacheDir, `${key.slice(0, 8)}.json`)
  await writeFile(entryPath, JSON.stringify({ key, result }))
}

export async function probe(filePath: string, cacheDir: string): Promise<ProbeResult> {
  const s = await stat(filePath)
  const key = cacheKey(filePath, s.mtimeMs, s.size)
  const cached = await readCache(cacheDir, key)
  if (cached?.key === key) return cached.result

  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ])

  const result = parseProbeOutput(stdout)
  await writeCache(cacheDir, key, result)
  return result
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd server && npx vitest run test/probe.test.ts
```

Expected: `PASS`

- [ ] **Step 5: Commit**

```bash
git add server/src/scanner/probe.ts server/test/probe.test.ts
git commit -m "feat(server): ffprobe wrapper with parse + disk cache"
```

---

## Task 4: Collection Detection

**Files:**
- Create: `server/src/scanner/collections.ts`
- Create: `server/test/collections.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// server/test/collections.test.ts
import { describe, it, expect } from 'vitest'
import { detectCollections, stripCollectionSuffix } from '../src/scanner/collections.ts'

describe('stripCollectionSuffix', () => {
  it('strips Part N', () => expect(stripCollectionSuffix('The Godfather Part II')).toBe('The Godfather'))
  it('strips Chapter N', () => expect(stripCollectionSuffix('John Wick Chapter 2')).toBe('John Wick'))
  it('strips Vol. N', () => expect(stripCollectionSuffix('Kill Bill Vol. 1')).toBe('Kill Bill'))
  it('strips trailing Roman numerals II-XX', () => expect(stripCollectionSuffix('Rocky III')).toBe('Rocky'))
  it('does NOT strip bare digits (Blade Runner 2049)', () => expect(stripCollectionSuffix('Blade Runner 2049')).toBe('Blade Runner 2049'))
  it('strips year before suffix check', () => expect(stripCollectionSuffix('John Wick (2014)')).toBe('John Wick'))
  it('handles no suffix', () => expect(stripCollectionSuffix('Inception')).toBe('Inception'))
})

describe('detectCollections', () => {
  it('groups movies with same base into collection', () => {
    const movies = [
      { id: '1', title: 'John Wick', year: 2014 },
      { id: '2', title: 'John Wick Chapter 2', year: 2017 },
      { id: '3', title: 'John Wick Chapter 3 - Parabellum', year: 2019 },
    ] as any[]
    const cols = detectCollections(movies)
    expect(cols).toHaveLength(1)
    expect(cols[0].name).toBe('John Wick')
    expect(cols[0].movies).toHaveLength(3)
    expect(cols[0].movies[0].year).toBe(2014)
  })

  it('does not create collection for single movie', () => {
    const movies = [{ id: '1', title: 'Inception', year: 2010 }] as any[]
    expect(detectCollections(movies)).toHaveLength(0)
  })

  it('does not merge Blade Runner 2049 with Blade Runner', () => {
    const movies = [
      { id: '1', title: 'Blade Runner', year: 1982 },
      { id: '2', title: 'Blade Runner 2049', year: 2017 },
    ] as any[]
    // 2049 is NOT stripped (bare digits) so base names differ
    const cols = detectCollections(movies)
    expect(cols).toHaveLength(0)
  })

  it('sorts by year ascending', () => {
    const movies = [
      { id: '2', title: 'Rocky II', year: 1979 },
      { id: '1', title: 'Rocky', year: 1976 },
      { id: '3', title: 'Rocky III', year: 1982 },
    ] as any[]
    const cols = detectCollections(movies)
    expect(cols[0].movies.map((m: any) => m.year)).toEqual([1976, 1979, 1982])
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
cd server && npx vitest run test/collections.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// server/src/scanner/collections.ts
import type { MovieItem } from './scanner.ts'

const ROMAN = /\b(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)$/i
// Optional `(?:\s*[-–—]\s*.+)?` consumes a trailing subtitle so titles like
// "John Wick Chapter 3 - Parabellum" still strip to "John Wick".
const COLLECTION_TOKENS = [
  /\s+Part\s+\w+(?:\s*[-–—]\s*.+)?$/i,
  /\s+Chapter\s+\w+(?:\s*[-–—]\s*.+)?$/i,
  /\s+Vol(?:ume|\.)\s*\w+(?:\s*[-–—]\s*.+)?$/i,
]

export function stripCollectionSuffix(title: string): string {
  // strip year tag first
  let t = title.replace(/\s*\(\d{4}\)$/, '').trim()
  // strip known collection tokens
  for (const pattern of COLLECTION_TOKENS) {
    t = t.replace(pattern, '').trim()
  }
  // strip trailing Roman numerals (but not words that happen to match)
  t = t.replace(ROMAN, '').trim()
  // strip trailing hyphen/dash leftovers
  t = t.replace(/[-–—]+$/, '').trim()
  return t
}

export interface Collection {
  id: string
  name: string
  movies: MovieItem[]
}

export function detectCollections(movies: MovieItem[]): Collection[] {
  const groups = new Map<string, MovieItem[]>()

  for (const movie of movies) {
    const base = stripCollectionSuffix(movie.title)
    const existing = groups.get(base) ?? []
    existing.push(movie)
    groups.set(base, existing)
  }

  const collections: Collection[] = []
  for (const [base, members] of groups) {
    if (members.length < 2) continue
    const sorted = [...members].sort((a, b) => a.year - b.year)
    collections.push({
      id: Buffer.from(base).toString('hex').slice(0, 16),
      name: base,
      movies: sorted,
    })
  }

  return collections
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd server && npx vitest run test/collections.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add server/src/scanner/collections.ts server/test/collections.test.ts
git commit -m "feat(server): collection detection with title suffix stripping"
```

---

## Task 5: File Scanner + Library Index

**Files:**
- Create: `server/src/scanner/scanner.ts`

- [ ] **Step 1: Implement scanner**

No isolated unit test possible here (requires real filesystem). Integration covered in Task 21.

```typescript
// server/src/scanner/scanner.ts
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { probe, type ProbeResult } from './probe.ts'
import { detectCollections, type Collection } from './collections.ts'
import type { Config } from '../config.ts'

export interface MovieItem extends ProbeResult {
  id: string
  title: string
  year: number
  filePath: string
}

export interface EpisodeItem extends ProbeResult {
  id: string
  showId: string
  showTitle: string
  season: number
  episode: number
  title: string
  filePath: string
}

export interface ShowSummary {
  id: string
  title: string
  seasons: { number: number; episodeCount: number }[]
}

export interface LibraryIndex {
  movies: MovieItem[]
  shows: Map<string, { summary: ShowSummary; episodes: EpisodeItem[] }>
  collections: Collection[]
  byId: Map<string, MovieItem | EpisodeItem>
  rescan(): Promise<void>
}

function movieId(filePath: string) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16)
}

const MOVIE_RE = /^(.+?)\s*\((\d{4})\)/
const EPISODE_RE = /S(\d{2})E(\d{2})/i

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walkDir(full))
    else if (/\.(mkv|mp4|mov|avi|m4v)$/i.test(entry.name)) files.push(full)
  }
  return files
}

async function scanMovies(roots: string[], cacheDir: string): Promise<MovieItem[]> {
  const movies: MovieItem[] = []
  for (const root of roots) {
    const files = await walkDir(root).catch(() => [])
    for (const file of files) {
      const basename = path.basename(file, path.extname(file))
      const match = MOVIE_RE.exec(basename)
      if (!match) continue
      const probeResult = await probe(file, cacheDir).catch(() => null)
      if (!probeResult) continue
      movies.push({
        ...probeResult,
        id: movieId(file),
        title: match[1].trim(),
        year: parseInt(match[2]),
        filePath: file,
      })
    }
  }
  return movies
}

async function scanShows(
  roots: string[],
  cacheDir: string,
): Promise<Map<string, { summary: ShowSummary; episodes: EpisodeItem[] }>> {
  const shows = new Map<string, { summary: ShowSummary; episodes: EpisodeItem[] }>()
  for (const root of roots) {
    const showDirs = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const showDir of showDirs) {
      if (!showDir.isDirectory()) continue
      const showTitle = showDir.name
      const showId = movieId(path.join(root, showDir.name))
      const files = await walkDir(path.join(root, showDir.name)).catch(() => [])
      const episodes: EpisodeItem[] = []
      for (const file of files) {
        const basename = path.basename(file)
        const epMatch = EPISODE_RE.exec(basename)
        if (!epMatch) continue
        const probeResult = await probe(file, cacheDir).catch(() => null)
        if (!probeResult) continue
        episodes.push({
          ...probeResult,
          id: movieId(file),
          showId,
          showTitle,
          season: parseInt(epMatch[1]),
          episode: parseInt(epMatch[2]),
          title: basename.replace(/\.[^.]+$/, ''),
          filePath: file,
        })
      }
      if (episodes.length === 0) continue
      const seasonMap = new Map<number, number>()
      for (const ep of episodes) {
        seasonMap.set(ep.season, (seasonMap.get(ep.season) ?? 0) + 1)
      }
      shows.set(showId, {
        summary: {
          id: showId,
          title: showTitle,
          seasons: [...seasonMap.entries()]
            .map(([number, episodeCount]) => ({ number, episodeCount }))
            .sort((a, b) => a.number - b.number),
        },
        episodes,
      })
    }
  }
  return shows
}

export async function createScanner(cfg: Config): Promise<LibraryIndex> {
  let movies: MovieItem[] = []
  let shows = new Map<string, { summary: ShowSummary; episodes: EpisodeItem[] }>()
  let collections: Collection[] = []
  const byId = new Map<string, MovieItem | EpisodeItem>()

  const index: LibraryIndex = { movies, shows, collections, byId, rescan }

  async function rescan() {
    movies = await scanMovies(cfg.moviesRoots, cfg.cacheDir)
    shows = await scanShows(cfg.showsRoots, cfg.cacheDir)
    collections = detectCollections(movies)
    byId.clear()
    for (const m of movies) byId.set(m.id, m)
    for (const show of shows.values()) {
      for (const ep of show.episodes) byId.set(ep.id, ep)
    }
    // update index refs so callers see fresh data after rescan
    index.movies = movies
    index.shows = shows
    index.collections = collections
    console.log(`Library: ${movies.length} movies, ${shows.size} shows`)
  }

  await rescan()
  return index
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/scanner/scanner.ts
git commit -m "feat(server): file scanner with movie/show index + media IDs"
```

---

## Task 6: Hardware Acceleration Detection

**Files:**
- Create: `server/src/transcode/hwaccel.ts`

- [ ] **Step 1: Implement**

```typescript
// server/src/transcode/hwaccel.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface HwAccel {
  ffmpegVersion: string
  encoder: string           // e.g. 'hevc_videotoolbox'
  h264Encoder: string
  hevcEncoder: string
  hwaccelDecode: string[]   // e.g. ['-hwaccel', 'videotoolbox']
}

const ENCODER_PRIORITY: Array<{
  name: string
  h264: string
  hevc: string
  decode: string[]
}> = [
  {
    name: 'videotoolbox',
    h264: 'h264_videotoolbox',
    hevc: 'hevc_videotoolbox',
    decode: ['-hwaccel', 'videotoolbox'],
  },
  {
    name: 'nvenc',
    h264: 'h264_nvenc',
    hevc: 'hevc_nvenc',
    decode: ['-hwaccel', 'nvdec'],
  },
  {
    name: 'qsv',
    h264: 'h264_qsv',
    hevc: 'hevc_qsv',
    decode: ['-hwaccel', 'qsv', '-init_hw_device', 'qsv=hw'],
  },
]

async function getFFmpegVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version'])
    return stdout.split('\n')[0] ?? 'unknown'
  } catch {
    throw new Error('ffmpeg not found in PATH — install ffmpeg to use Horizon')
  }
}

async function getAvailableEncoders(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-encoders', '-v', 'quiet'])
    const encoders = new Set<string>()
    for (const line of stdout.split('\n')) {
      const match = /^\s*[VAS].+?\s+(\S+)\s/.exec(line)
      if (match) encoders.add(match[1])
    }
    return encoders
  } catch {
    return new Set()
  }
}

export async function detectHwAccel(forceEncoder?: string): Promise<HwAccel> {
  const ffmpegVersion = await getFFmpegVersion()
  const available = await getAvailableEncoders()

  if (forceEncoder) {
    console.log(`Using forced encoder: ${forceEncoder}`)
    return {
      ffmpegVersion,
      encoder: forceEncoder,
      h264Encoder: forceEncoder.includes('h264') ? forceEncoder : 'libx264',
      hevcEncoder: forceEncoder.includes('hevc') ? forceEncoder : 'libx265',
      hwaccelDecode: [],
    }
  }

  for (const opt of ENCODER_PRIORITY) {
    if (available.has(opt.h264) || available.has(opt.hevc)) {
      console.log(`Hardware acceleration: ${opt.name}`)
      return {
        ffmpegVersion,
        encoder: opt.name,
        h264Encoder: available.has(opt.h264) ? opt.h264 : 'libx264',
        hevcEncoder: available.has(opt.hevc) ? opt.hevc : 'libx265',
        hwaccelDecode: opt.decode,
      }
    }
  }

  console.log('Hardware acceleration: none (CPU only)')
  return {
    ffmpegVersion,
    encoder: 'cpu',
    h264Encoder: 'libx264',
    hevcEncoder: 'libx265',
    hwaccelDecode: [],
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/transcode/hwaccel.ts
git commit -m "feat(server): hardware acceleration detection (VideoToolbox/NVENC/QSV/CPU)"
```

---

## Task 7: Bitrate Profiles + Playback Decision

**Files:**
- Create: `server/src/transcode/profiles.ts`
- Create: `server/src/transcode/decision.ts`
- Create: `server/test/decision.test.ts`

- [ ] **Step 1: Write decision tests**

```typescript
// server/test/decision.test.ts
import { describe, it, expect } from 'vitest'
import { decidePlayback, type ClientCapabilities } from '../src/transcode/decision.ts'
import type { ProbeResult } from '../src/scanner/probe.ts'

const h265MkvProbe: Partial<ProbeResult> = {
  videoCodec: 'hevc',
  videoBitrate: 40_000_000,
  hdr: { dv: true, dvProfile: 7, hdr10: true, hdr10plus: false },
  container: 'matroska,webm',
  audioTracks: [{ index: 0, codec: 'truehd', channels: 8, language: 'eng', title: '', default: true }],
}

const shieldCaps: ClientCapabilities = {
  videoCodecs: ['hevc', 'h264'],
  audioCodecs: ['truehd', 'eac3', 'ac3', 'aac'],
  hdr: ['dv', 'hdr10'],
  maxBitrate: 0,
  container: ['matroska', 'mp4'],
}

const browserCaps: ClientCapabilities = {
  videoCodecs: ['h264'],
  audioCodecs: ['aac'],
  hdr: [],
  maxBitrate: 8000,
  container: ['mp4'],
}

const safariCaps: ClientCapabilities = {
  videoCodecs: ['hevc', 'h264'],
  audioCodecs: ['aac', 'ac3'],
  hdr: ['hdr10'],
  maxBitrate: 0,
  container: ['mp4'],
}

describe('decidePlayback', () => {
  it('returns direct-play for fully compatible client', () => {
    const result = decidePlayback(h265MkvProbe as ProbeResult, shieldCaps)
    expect(result.method).toBe('direct-play')
  })

  it('returns direct-stream when container unsupported but codecs ok', () => {
    const caps = { ...shieldCaps, container: ['mp4'] }
    const result = decidePlayback(h265MkvProbe as ProbeResult, caps)
    expect(result.method).toBe('direct-stream')
  })

  it('returns partial-transcode when video ok but audio not', () => {
    const caps = { ...safariCaps, container: ['mp4'] }
    const probe = { ...h265MkvProbe, hdr: { dv: false, hdr10: true, hdr10plus: false }, videoCodec: 'hevc' }
    const result = decidePlayback(probe as ProbeResult, caps)
    // hevc supported by safari, truehd not -> partial-transcode
    expect(result.method).toBe('partial-transcode')
  })

  it('returns transcode for browser (h264 only, SDR)', () => {
    const result = decidePlayback(h265MkvProbe as ProbeResult, browserCaps)
    expect(result.method).toBe('transcode')
  })

  it('forces transcode when maxBitrate exceeded even if codecs match', () => {
    const caps = { ...shieldCaps, maxBitrate: 8000 } // 8000 kbps, source is 40000 kbps
    const result = decidePlayback(h265MkvProbe as ProbeResult, caps)
    expect(result.method).toBe('transcode')
  })

  it('includes tonemap flag when HDR source + SDR client', () => {
    const result = decidePlayback(h265MkvProbe as ProbeResult, browserCaps)
    expect(result.needsToneMap).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
cd server && npx vitest run test/decision.test.ts
```

- [ ] **Step 3: Implement profiles + decision**

```typescript
// server/src/transcode/profiles.ts
export interface Profile {
  name: string
  videoBitrate: number   // kbps
  audioBitrate: number   // kbps
  width: number
  height: number
}

export const PROFILES: Profile[] = [
  { name: '4k',      videoBitrate: 40000, audioBitrate: 256, width: 3840, height: 2160 },
  { name: '1080p-hi',videoBitrate: 20000, audioBitrate: 256, width: 1920, height: 1080 },
  { name: '1080p',   videoBitrate: 8000,  audioBitrate: 192, width: 1920, height: 1080 },
  { name: '720p',    videoBitrate: 4000,  audioBitrate: 128, width: 1280, height: 720  },
  { name: '480p',    videoBitrate: 2000,  audioBitrate: 96,  width: 854,  height: 480  },
]

export function selectInitialProfile(maxBitrate: number, sourceWidth: number): Profile {
  const ceiling = maxBitrate === 0 ? Infinity : maxBitrate
  const eligible = PROFILES.filter(
    p => p.videoBitrate <= ceiling && p.width <= sourceWidth
  )
  return eligible[0] ?? PROFILES[PROFILES.length - 1]
}

export function selectRenditionLadder(
  topProfile: Profile,
  maxRenditions: number,
  sourceWidth: number,
): Profile[] {
  // If topProfile isn't a reference from PROFILES, fall back to top of ladder.
  const topIdx = Math.max(0, PROFILES.indexOf(topProfile))
  const ladder = PROFILES
    .slice(topIdx, topIdx + maxRenditions)
    .filter(p => p.width <= sourceWidth)
  return ladder.length > 0 ? ladder : [PROFILES[PROFILES.length - 1]]
}
```

```typescript
// server/src/transcode/decision.ts
import type { ProbeResult } from '../scanner/probe.ts'

export interface ClientCapabilities {
  videoCodecs: string[]
  audioCodecs: string[]
  hdr: string[]
  maxBitrate: number    // kbps; 0 = unlimited
  container: string[]
}

export type PlaybackMethod = 'direct-play' | 'direct-stream' | 'partial-transcode' | 'transcode'

export interface PlaybackDecision {
  method: PlaybackMethod
  needsToneMap: boolean
  audioTranscodeNeeded: boolean
}

const CONTAINER_MAP: Record<string, string[]> = {
  'matroska,webm': ['matroska', 'webm', 'mkv'],
  'mov,mp4,m4a,3gp,3g2,mj2': ['mp4', 'mov', 'm4a'],
}

function containerSupported(ffContainer: string, clientContainers: string[]): boolean {
  const aliases = CONTAINER_MAP[ffContainer] ?? [ffContainer]
  return aliases.some(a => clientContainers.includes(a))
}

function hdrSupported(hdr: ProbeResult['hdr'], clientHdr: string[]): boolean {
  if (hdr.dv && !clientHdr.includes('dv')) return false
  if ((hdr.hdr10 || hdr.hdr10plus) && !clientHdr.includes('hdr10') && !clientHdr.includes('dv')) return false
  return true
}

export function decidePlayback(probe: ProbeResult, caps: ClientCapabilities): PlaybackDecision {
  const sourceBitrateKbps = Math.round(probe.videoBitrate / 1000)
  const bitrateOk = caps.maxBitrate === 0 || sourceBitrateKbps <= caps.maxBitrate

  const videoCodecOk = caps.videoCodecs.includes(probe.videoCodec)
  const hdrOk = hdrSupported(probe.hdr, caps.hdr)
  const containerOk = containerSupported(probe.container, caps.container)
  const defaultAudio = probe.audioTracks.find(t => t.default) ?? probe.audioTracks[0]
  const audioOk = defaultAudio ? caps.audioCodecs.includes(defaultAudio.codec) : true

  const needsToneMap = (probe.hdr.dv || probe.hdr.hdr10 || probe.hdr.hdr10plus) && !hdrOk

  // direct-play: everything compatible + bitrate ok
  if (videoCodecOk && hdrOk && audioOk && containerOk && bitrateOk) {
    return { method: 'direct-play', needsToneMap: false, audioTranscodeNeeded: false }
  }

  // direct-stream: codecs+hdr ok but container wrong, bitrate ok
  if (videoCodecOk && hdrOk && audioOk && !containerOk && bitrateOk) {
    return { method: 'direct-stream', needsToneMap: false, audioTranscodeNeeded: false }
  }

  // partial-transcode: video+hdr ok but audio needs transcode, bitrate ok
  if (videoCodecOk && hdrOk && !audioOk && bitrateOk) {
    return { method: 'partial-transcode', needsToneMap: false, audioTranscodeNeeded: true }
  }

  // full transcode (codec mismatch, HDR mismatch, or bitrate exceeded)
  return { method: 'transcode', needsToneMap, audioTranscodeNeeded: true }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd server && npx vitest run test/decision.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add server/src/transcode/profiles.ts server/src/transcode/decision.ts server/test/decision.test.ts
git commit -m "feat(server): bitrate profiles + playback decision tree"
```

---

## Task 8: FFmpeg Process Manager

**Files:**
- Create: `server/src/transcode/ffmpeg.ts`
- Create: `server/src/session/types.ts`

- [ ] **Step 1: Implement session types**

```typescript
// server/src/session/types.ts
import type { ClientCapabilities, PlaybackDecision } from '../transcode/decision.ts'
import type { Profile } from '../transcode/profiles.ts'

export type SessionState = 'pre-buffer' | 'active' | 'detached' | 'parked' | 'destroyed'

export interface Session {
  id: string
  mediaId: string
  filePath: string
  state: SessionState
  method: PlaybackDecision['method']
  capabilities: ClientCapabilities
  selectedAudioTrack: number
  selectedSubtitleTrack: number | null
  profiles: Profile[]          // rendition ladder
  renditionCodecs: string[]    // e.g. ['avc1.640028','hvc1.1.6.L150.90'] per rendition
  needsToneMap: boolean        // HDR → SDR tone-map required
  sessionDir: string           // temp dir for segments
  sessionReady: boolean        // true once FFmpeg pre-buffer complete
  ffmpegPid?: number
  ffmpegProcess?: import('node:child_process').ChildProcess
  /** Guard: drop concurrent restart requests so we never SIGTERM + spawn into the same dirs twice. */
  ffmpegRestartInFlight?: boolean
  wsSocket?: import('ws').WebSocket
  reconnectToken: string
  attachTimer?: NodeJS.Timeout  // fires if WS not attached in time
  graceTimer?: NodeJS.Timeout   // fires after WS disconnect grace window
  seekPositionMs: number        // current FFmpeg start position
  createdAt: number
}
```

- [ ] **Step 2: Implement FFmpeg process manager**

```typescript
// server/src/transcode/ffmpeg.ts
import { spawn } from 'node:child_process'
import { mkdir, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { HwAccel } from './hwaccel.ts'
import type { Profile } from './profiles.ts'
import type { Session } from '../session/types.ts'

export async function createSessionDir(sessionId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'horizon', 'sessions', sessionId)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function cleanupSessionDir(sessionDir: string): Promise<void> {
  await rm(sessionDir, { recursive: true, force: true })
}

export function killFfmpeg(session: Session): void {
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill('SIGTERM')
    setTimeout(() => {
      if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
        session.ffmpegProcess.kill('SIGKILL')
      }
    }, 2000)
  }
}

function isAlive(session: Session): boolean {
  const p = session.ffmpegProcess
  return !!p && !p.killed && p.exitCode === null && p.signalCode === null
}

export function pauseFfmpeg(session: Session): void {
  if (!isAlive(session)) return
  try { session.ffmpegProcess?.kill('SIGSTOP') } catch {/* ESRCH: process gone */}
}

export function resumeFfmpeg(session: Session): void {
  if (!isAlive(session)) return
  try { session.ffmpegProcess?.kill('SIGCONT') } catch {/* ESRCH: process gone */}
}

function buildTranscodeArgs(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  audioTrackIndex: number,
): { args: string[]; renditionCodecs: string[] } {
  const { filePath, seekPositionMs, sessionDir, needsToneMap } = session
  const seekSecs = seekPositionMs / 1000
  const canHevc = session.capabilities.videoCodecs.includes('hevc')

  const args: string[] = []
  const renditionCodecs: string[] = []

  // hardware decode
  if (hwAccel.hwaccelDecode.length > 0) {
    args.push(...hwAccel.hwaccelDecode)
  }

  // fast seek before input
  if (seekSecs > 0) {
    args.push('-ss', seekSecs.toFixed(3))
  }

  args.push('-i', filePath)

  // map video + selected audio for each rendition
  for (let i = 0; i < profiles.length; i++) {
    args.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}`)
  }

  // encode each rendition
  const scaleBase = (p: Profile) =>
    `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2`
  const toneMapFilter =
    'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]
    // use HEVC only when client supports it and resolution warrants it
    const useHevc = canHevc && p.width >= 1920
    const vEncoder = useHevc ? hwAccel.hevcEncoder : hwAccel.h264Encoder
    renditionCodecs.push(useHevc ? 'hvc1.1.6.L150.90' : 'avc1.640028')

    const vfValue = needsToneMap
      ? `${toneMapFilter},${scaleBase(p)}`
      : scaleBase(p)

    args.push(
      `-c:v:${i}`, vEncoder,
      `-b:v:${i}`, `${p.videoBitrate}k`,
      `-maxrate:v:${i}`, `${Math.round(p.videoBitrate * 1.1)}k`,
      `-bufsize:v:${i}`, `${p.videoBitrate * 2}k`,
      `-vf:${i}`, vfValue,
      `-g:v:${i}`, '48',        // keyframe every 48 frames (~2s at 24fps)
      `-sc_threshold:v:${i}`, '0',
      `-c:a:${i}`, 'aac',
      `-b:a:${i}`, `${p.audioBitrate}k`,
      `-ac:a:${i}`, '2',
    )
  }

  // HLS output
  const varStreamMap = profiles.map((_, i) => `v:${i},a:${i}`).join(' ')
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', `${sessionDir}/r%v/seg%03d.m4s`,
    '-var_stream_map', varStreamMap,
    `${sessionDir}/r%v/index.m3u8`,
  )

  return { args, renditionCodecs }
}

function buildDirectStreamArgs(
  session: Session,
  audioTrackIndex: number,
): string[] {
  const { filePath, seekPositionMs, sessionDir } = session
  const seekSecs = seekPositionMs / 1000
  const args: string[] = []
  if (seekSecs > 0) args.push('-ss', seekSecs.toFixed(3))
  args.push('-i', filePath)
  args.push('-map', '0:v:0', `-map`, `0:a:${audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'copy')
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', `${sessionDir}/r0/seg%03d.m4s`,
    `${sessionDir}/r0/index.m3u8`,
  )
  return args
}

function buildPartialTranscodeArgs(
  session: Session,
  hwAccel: HwAccel,
  profile: Profile,
  audioTrackIndex: number,
): string[] {
  const { filePath, seekPositionMs, sessionDir } = session
  const seekSecs = seekPositionMs / 1000
  const args: string[] = []
  if (hwAccel.hwaccelDecode.length > 0) args.push(...hwAccel.hwaccelDecode)
  if (seekSecs > 0) args.push('-ss', seekSecs.toFixed(3))
  args.push('-i', filePath)
  args.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'aac', `-b:a`, `${profile.audioBitrate}k`)
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', `${sessionDir}/r0/seg%03d.m4s`,
    `${sessionDir}/r0/index.m3u8`,
  )
  return args
}

export async function waitForSegments(sessionDir: string, renditionCount: number, minSegments = 3): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    let allReady = true
    for (let r = 0; r < renditionCount; r++) {
      const dir = path.join(sessionDir, `r${r}`)
      const files = await readdir(dir).catch(() => [])
      const segs = files.filter(f => f.endsWith('.m4s'))
      if (segs.length < minSegments) { allReady = false; break }
    }
    if (allReady) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('FFmpeg pre-buffer timeout')
}

export async function spawnFfmpeg(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  audioTrackIndex: number,
): Promise<void> {
  const { sessionDir, method } = session

  // ensure rendition dirs exist
  const renditionCount = method === 'transcode' ? profiles.length : 1
  for (let r = 0; r < renditionCount; r++) {
    await mkdir(path.join(sessionDir, `r${r}`), { recursive: true })
  }

  let args: string[]
  if (method === 'transcode') {
    const result = buildTranscodeArgs(session, hwAccel, profiles, audioTrackIndex)
    args = result.args
    session.renditionCodecs = result.renditionCodecs
  } else if (method === 'direct-stream') {
    args = buildDirectStreamArgs(session, audioTrackIndex)
  } else if (method === 'partial-transcode') {
    args = buildPartialTranscodeArgs(session, hwAccel, profiles[0], audioTrackIndex)
  } else {
    return // direct-play: no FFmpeg
  }

  const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  session.ffmpegProcess = proc
  session.ffmpegPid = proc.pid

  proc.stderr?.on('data', (chunk: Buffer) => {
    // Log FFmpeg stderr at debug level only
    process.env.HORIZON_DEBUG && process.stderr.write(chunk)
  })

  proc.on('error', (err) => {
    // spawn-level failure (e.g. ffmpeg binary missing). Notify client.
    try {
      session.wsSocket?.send(JSON.stringify({
        type: 'error',
        code: 'ffmpeg-spawn-failed',
        message: err.message,
        fatal: true,
      }))
    } catch {/* socket may be gone */}
  })

  proc.on('exit', (code) => {
    try {
      if (code !== 0 && code !== null) {
        session.wsSocket?.send(JSON.stringify({
          type: 'error',
          code: 'transcode-failed',
          message: `FFmpeg exited with code ${code}`,
          fatal: true,
        }))
      } else if (code === 0) {
        session.wsSocket?.send(JSON.stringify({ type: 'ended' }))
      }
    } catch {/* socket may be gone */}
  })

  await waitForSegments(sessionDir, renditionCount, 3)
}
```

- [ ] **Step 3: Commit**

```bash
git add server/src/session/types.ts server/src/transcode/ffmpeg.ts
git commit -m "feat(server): FFmpeg process manager with spawn/kill/pause + HLS pipeline"
```

---

## Task 9: Session Manager

**Files:**
- Create: `server/src/session/manager.ts`

- [ ] **Step 1: Implement**

```typescript
// server/src/session/manager.ts
import crypto from 'node:crypto'
import type { Config } from '../config.ts'
import type { Session, SessionState } from './types.ts'
import { cleanupSessionDir, killFfmpeg } from '../transcode/ffmpeg.ts'

export interface SessionManager {
  create(partial: Omit<Session, 'id' | 'reconnectToken' | 'createdAt' | 'state' | 'seekPositionMs'>): Session
  get(id: string): Session | undefined
  getByReconnectToken(token: string): Session | undefined
  destroy(id: string): Promise<void>
  size(): number
}

export function createSessionManager(cfg: Config): SessionManager {
  const sessions = new Map<string, Session>()
  const byToken = new Map<string, string>()  // token → sessionId

  function create(partial: Omit<Session, 'id' | 'reconnectToken' | 'createdAt' | 'state' | 'seekPositionMs'>): Session {
    if (sessions.size >= cfg.maxSessions) {
      throw Object.assign(new Error('Server at session capacity'), { code: 'max-sessions' })
    }

    const id = crypto.randomUUID()
    const reconnectToken = crypto.randomBytes(32).toString('hex')
    const session: Session = {
      ...partial,
      id,
      reconnectToken,
      state: 'pre-buffer',
      seekPositionMs: 0,
      createdAt: Date.now(),
    }
    sessions.set(id, session)
    byToken.set(reconnectToken, id)

    // start attach timeout
    session.attachTimer = setTimeout(async () => {
      if (session.state === 'pre-buffer') {
        console.log(`Session ${id}: WS attach timeout`)
        await destroy(id)
      }
    }, cfg.wsAttachMs)

    return session
  }

  function get(id: string) { return sessions.get(id) }

  function getByReconnectToken(token: string) {
    const id = byToken.get(token)
    return id ? sessions.get(id) : undefined
  }

  async function destroy(id: string) {
    const session = sessions.get(id)
    if (!session) return

    clearTimeout(session.attachTimer)
    clearTimeout(session.graceTimer)
    killFfmpeg(session)
    // also reap subtitle extraction ffmpeg if still running (Task 13)
    if (session.subtitleProcess && !session.subtitleProcess.killed) {
      try { session.subtitleProcess.kill('SIGTERM') } catch {/* gone */}
    }
    await cleanupSessionDir(session.sessionDir).catch((err) => {
      console.error(`Session ${id}: cleanup failed`, err)
    })
    byToken.delete(session.reconnectToken)
    sessions.delete(id)
    session.state = 'destroyed' as SessionState
  }

  return { create, get, getByReconnectToken, destroy, size: () => sessions.size }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/session/manager.ts
git commit -m "feat(server): session manager with TTL, grace window, reconnect token"
```

---

## Task 10: Library Routes

**Files:**
- Create: `server/src/routes/library.ts`

- [ ] **Step 1: Implement**

```typescript
// server/src/routes/library.ts
import type { FastifyInstance } from 'fastify'
import type { LibraryIndex } from '../scanner/scanner.ts'

export function registerLibrary(app: FastifyInstance, index: LibraryIndex) {
  app.get('/library/movies', async () => index.movies)

  app.get('/library/movies/collections', async () => index.collections)

  app.get<{ Params: { collection: string } }>(
    '/library/movies/collections/:collection',
    async (req, reply) => {
      const col = index.collections.find(c => c.id === req.params.collection)
      if (!col) return reply.status(404).send({ error: 'Collection not found', code: 'not-found' })
      return col
    },
  )

  app.get('/library/shows', async () =>
    [...index.shows.values()].map(s => s.summary)
  )

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show',
    async (req, reply) => {
      const show = index.shows.get(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      return show.summary
    },
  )

  app.get<{ Params: { show: string } }>(
    '/library/shows/:show/seasons',
    async (req, reply) => {
      const show = index.shows.get(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      return show.summary.seasons
    },
  )

  app.get<{ Params: { show: string; season: string } }>(
    '/library/shows/:show/seasons/:season',
    async (req, reply) => {
      const show = index.shows.get(req.params.show)
      if (!show) return reply.status(404).send({ error: 'Show not found', code: 'not-found' })
      const season = parseInt(req.params.season, 10)
      if (!Number.isFinite(season)) {
        return reply.status(400).send({ error: 'Invalid season', code: 'invalid-input' })
      }
      const episodes = show.episodes
        .filter(e => e.season === season)
        .sort((a, b) => a.episode - b.episode)
      return episodes
    },
  )

  app.post('/library/rescan', async () => {
    index.rescan().catch(err => console.error('Rescan error:', err))
    return { status: 'scanning' }
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/routes/library.ts
git commit -m "feat(server): library REST routes"
```

---

## Task 11: Master Playlist Generation + Session Routes

**Files:**
- Create: `server/src/routes/sessions.ts`

- [ ] **Step 1: Implement session routes + HLS serving**

```typescript
// server/src/routes/sessions.ts
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import path from 'node:path'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { LibraryIndex } from '../scanner/scanner.ts'
import type { SessionManager } from '../session/manager.ts'
import type { ClientCapabilities } from '../transcode/decision.ts'
import { decidePlayback } from '../transcode/decision.ts'
import { selectInitialProfile, selectRenditionLadder } from '../transcode/profiles.ts'
import { createSessionDir, spawnFfmpeg } from '../transcode/ffmpeg.ts'
import { handleWsMessage } from '../ws/handler.ts'
import crypto from 'node:crypto'

interface CreateSessionBody {
  mediaId: string
  capabilities: ClientCapabilities
  audioTrackIndex?: number
  subtitleTrackIndex?: number | null
}

function buildMasterPlaylist(
  sessionId: string,
  profiles: import('../transcode/profiles.ts').Profile[],
  renditionCodecs: string[],
): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '']
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]
    const bw = (p.videoBitrate + p.audioBitrate) * 1000
    const vCodec = renditionCodecs[i] ?? 'avc1.640028'
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${p.width}x${p.height},CODECS="${vCodec},mp4a.40.2"`)
    lines.push(`/sessions/${sessionId}/renditions/${i}.m3u8`)
  }
  return lines.join('\n')
}

export function registerSessions(
  app: FastifyInstance,
  cfg: Config,
  hwAccel: HwAccel,
  index: LibraryIndex,
  sessions: SessionManager,
) {
  // POST /sessions — create session
  app.post<{ Body: CreateSessionBody }>('/sessions', async (req, reply) => {
    const { mediaId, capabilities, audioTrackIndex = 0, subtitleTrackIndex = null } = req.body

    const media = index.byId.get(mediaId)
    if (!media) return reply.status(404).send({ error: 'Media not found', code: 'media-not-found' })

    if (sessions.size() >= cfg.maxSessions) {
      return reply.status(503).send({ error: 'Server at capacity', code: 'max-sessions' })
    }

    const decision = decidePlayback(media, capabilities)
    const [srcW] = (media.resolution ?? '1920x1080').split('x').map(Number)
    const topProfile = selectInitialProfile(capabilities.maxBitrate, srcW)
    const profiles = decision.method === 'transcode'
      ? selectRenditionLadder(topProfile, cfg.maxRenditions, srcW)
      : [topProfile]

    const sessionDir = await createSessionDir(crypto.randomUUID())
    const session = sessions.create({
      mediaId,
      filePath: media.filePath,
      method: decision.method,
      capabilities,
      selectedAudioTrack: audioTrackIndex,
      selectedSubtitleTrack: subtitleTrackIndex,
      profiles,
      renditionCodecs: [],
      needsToneMap: decision.needsToneMap,
      sessionDir,
      sessionReady: false,
    })

    // spawn FFmpeg (pre-buffer — awaits 3 segments)
    if (decision.method !== 'direct-play') {
      spawnFfmpeg(session, hwAccel, profiles, audioTrackIndex).then(() => {
        session.sessionReady = true
        session.state = 'active'
        // send session-ready only if WS already attached; otherwise WS attach handler sends it
        if (session.wsSocket) {
          session.wsSocket.send(JSON.stringify({
            type: 'session-ready',
            method: session.method,
            streamUrl: `/sessions/${session.id}/stream.m3u8`,
            profile: profiles[0],
            reconnectToken: session.reconnectToken,
          }))
        }
      }).catch(err => {
        sessions.destroy(session.id)
        console.error('FFmpeg start error:', err)
      })
    } else {
      session.sessionReady = true
    }

    const streamUrl = decision.method === 'direct-play'
      ? `/sessions/${session.id}/direct`
      : `/sessions/${session.id}/stream.m3u8`

    return {
      sessionId: session.id,
      method: decision.method,
      streamUrl,
      wsUrl: `/sessions/${session.id}/ws`,
      profiles,
      selectedAudioTrack: audioTrackIndex,
      selectedSubtitleTrack: subtitleTrackIndex,
    }
  })

  // GET /sessions/:id/stream.m3u8 — master playlist
  app.get<{ Params: { id: string } }>('/sessions/:id/stream.m3u8', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
    if (session.method === 'direct-stream' || session.method === 'partial-transcode') {
      // single rendition — serve the media playlist directly as the "master"
      const content = await readFile(path.join(session.sessionDir, 'r0', 'index.m3u8'), 'utf8')
      return reply.header('Content-Type', 'application/vnd.apple.mpegurl').send(content)
    }
    const master = buildMasterPlaylist(session.id, session.profiles, session.renditionCodecs)
    return reply.header('Content-Type', 'application/vnd.apple.mpegurl').send(master)
  })

  // GET /sessions/:id/renditions/:r.m3u8 — media playlist
  app.get<{ Params: { id: string; r: string } }>('/sessions/:id/renditions/:r.m3u8', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
    // SECURITY: validate :r is purely numeric — block path traversal via ../
    if (!/^\d+$/.test(req.params.r)) {
      return reply.status(400).send({ error: 'Invalid rendition', code: 'invalid-input' })
    }
    const playlistPath = path.join(session.sessionDir, `r${req.params.r}`, 'index.m3u8')
    if (!existsSync(playlistPath)) return reply.status(404).send({ error: 'Not ready', code: 'not-ready' })
    const content = await readFile(playlistPath, 'utf8')
    return reply.header('Content-Type', 'application/vnd.apple.mpegurl').send(content)
  })

  // GET /sessions/:id/renditions/:r/:seg — segment
  app.get<{ Params: { id: string; r: string; seg: string } }>(
    '/sessions/:id/renditions/:r/:seg',
    async (req, reply) => {
      const session = sessions.get(req.params.id)
      if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
      // SECURITY: validate :r is numeric and basename :seg — block path traversal
      if (!/^\d+$/.test(req.params.r)) {
        return reply.status(400).send({ error: 'Invalid rendition', code: 'invalid-input' })
      }
      const segName = path.basename(req.params.seg)
      const segPath = path.join(session.sessionDir, `r${req.params.r}`, segName)
      if (!existsSync(segPath)) return reply.status(404).send({ error: 'Segment not found', code: 'not-found' })
      return reply.header('Content-Type', 'video/mp4').send(createReadStream(segPath))
    },
  )

  // GET /sessions/:id/direct — raw file with range support
  app.get<{ Params: { id: string } }>('/sessions/:id/direct', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
    const { createReadStream: crs, statSync } = await import('node:fs')
    const { size } = statSync(session.filePath)
    const range = req.headers.range
    if (range) {
      const [startStr, endStr] = range.replace('bytes=', '').split('-')
      const start = parseInt(startStr)
      const end = endStr ? parseInt(endStr) : size - 1
      if (isNaN(start) || isNaN(end) || start < 0 || end >= size || start > end) {
        return reply.status(416).header('Content-Range', `bytes */${size}`).send()
      }
      reply.status(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', end - start + 1)
        .header('Content-Type', 'video/x-matroska')
      return reply.send(crs(session.filePath, { start, end }))
    }
    reply.header('Content-Type', 'video/x-matroska').header('Content-Length', size)
    return reply.send(crs(session.filePath))
  })

  // GET /sessions/:id/subtitles/:trackIdx.vtt
  app.get<{ Params: { id: string; trackIdx: string } }>(
    '/sessions/:id/subtitles/:trackIdx.vtt',
    async (req, reply) => {
      const session = sessions.get(req.params.id)
      if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
      // SECURITY: validate :trackIdx is numeric — block path traversal
      if (!/^\d+$/.test(req.params.trackIdx)) {
        return reply.status(400).send({ error: 'Invalid track index', code: 'invalid-input' })
      }
      const vttPath = path.join(session.sessionDir, `sub_${req.params.trackIdx}.vtt`)
      if (!existsSync(vttPath)) return reply.status(404).send({ error: 'Subtitle not ready', code: 'not-ready' })
      const content = await readFile(vttPath, 'utf8')
      return reply.header('Content-Type', 'text/vtt').send(content)
    },
  )

  // DELETE /sessions/:id
  app.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    await sessions.destroy(req.params.id)
    return reply.status(204).send()
  })

  // WS /sessions/:id/ws — @fastify/websocket v8.3.x still wraps as SocketStream
  // ({ socket: ws.WebSocket } & Duplex). Pull the raw WebSocket via connection.socket.
  app.get<{ Params: { id: string } }>('/sessions/:id/ws', { websocket: true }, (connection, req) => {
    const socket = connection.socket
    const session = sessions.get(req.params.id)
    if (!session) {
      socket.close(4004, 'session-not-found')
      return
    }

    clearTimeout(session.attachTimer)
    clearTimeout(session.graceTimer)
    session.wsSocket = socket
    session.state = 'active'

    // if FFmpeg pre-buffer finished before WS attached, send ready now
    if (session.sessionReady) {
      socket.send(JSON.stringify({
        type: 'session-ready',
        method: session.method,
        streamUrl: session.method === 'direct-play'
          ? `/sessions/${session.id}/direct`
          : `/sessions/${session.id}/stream.m3u8`,
        profile: session.profiles[0],
        reconnectToken: session.reconnectToken,
      }))
    }

    socket.on('message', (raw: Buffer) => {
      let msg: unknown
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return // ignore malformed JSON silently
      }
      try {
        handleWsMessage(msg, session, sessions, cfg, hwAccel)
      } catch (err) {
        // log handler bugs — don't lose them in catch-all
        console.error(`Session ${session.id}: WS handler error`, err)
      }
    })

    // send ping every 15s
    const pingInterval = setInterval(() => {
      if (socket.readyState === 1 /* WebSocket.OPEN */) {
        socket.ping()
      }
    }, 15_000)

    // single close handler — ping cleanup + state transition
    socket.on('close', () => {
      clearInterval(pingInterval)
      if (session.state === 'destroyed') return
      session.state = 'detached'
      session.wsSocket = undefined
      session.graceTimer = setTimeout(() => {
        sessions.destroy(session.id)
      }, cfg.wsGraceMs)
    })
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/routes/sessions.ts
git commit -m "feat(server): session routes — create, HLS serving, direct play, WS upgrade"
```

---

## Task 12: WebSocket Handler + ABR Logic

**Files:**
- Create: `server/src/ws/handler.ts`
- Create: `server/test/abr.test.ts`

- [ ] **Step 1: Write ABR tests**

```typescript
// server/test/abr.test.ts
import { describe, it, expect } from 'vitest'
import { computeAbrAction, type AbrState } from '../src/ws/handler.ts'
import { PROFILES } from '../src/transcode/profiles.ts'

describe('computeAbrAction', () => {
  const state: AbrState = {
    currentProfileIndex: 1, // 1080p-hi
    lastChangeAt: 0,
    cooldownMs: 15_000,
    profiles: PROFILES.slice(0, 4), // 4K, 1080p-hi, 1080p, 720p
  }

  it('steps down 2 on critical buffer', () => {
    const action = computeAbrAction({ kbps: 30000, bufferSeconds: 2 }, state, Date.now())
    expect(action).toBe('emergency-down')
  })

  it('steps down 1 on low buffer', () => {
    const action = computeAbrAction({ kbps: 30000, bufferSeconds: 6 }, state, Date.now())
    expect(action).toBe('down')
  })

  it('steps down when bandwidth insufficient', () => {
    // current profile 1080p-hi = 20000 kbps, reported 15000 < 20000*1.2=24000
    const action = computeAbrAction({ kbps: 15000, bufferSeconds: 20 }, state, Date.now())
    expect(action).toBe('down')
  })

  it('steps up when bandwidth high and buffer healthy', () => {
    const stateAt1080p = { ...state, currentProfileIndex: 2 } // 1080p
    // next profile up = 1080p-hi = 20000 kbps, reported 35000 > 20000*1.5=30000, buffer 18
    const action = computeAbrAction({ kbps: 35000, bufferSeconds: 18 }, stateAt1080p, Date.now())
    expect(action).toBe('up')
  })

  it('respects cooldown on step-up', () => {
    const stateAt1080p = { ...state, currentProfileIndex: 2, lastChangeAt: Date.now() - 5000 }
    const action = computeAbrAction({ kbps: 35000, bufferSeconds: 18 }, stateAt1080p, Date.now())
    expect(action).toBe('none')
  })

  it('ignores cooldown on emergency down', () => {
    const stateRecent = { ...state, lastChangeAt: Date.now() - 1000 }
    const action = computeAbrAction({ kbps: 30000, bufferSeconds: 2 }, stateRecent, Date.now())
    expect(action).toBe('emergency-down')
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
cd server && npx vitest run test/abr.test.ts
```

- [ ] **Step 3: Implement handler**

```typescript
// server/src/ws/handler.ts
import type { Session } from '../session/types.ts'
import type { SessionManager } from '../session/manager.ts'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { Profile } from '../transcode/profiles.ts'
import { PROFILES } from '../transcode/profiles.ts'
import { killFfmpeg, spawnFfmpeg, pauseFfmpeg, resumeFfmpeg } from '../transcode/ffmpeg.ts'
import { rm } from 'node:fs/promises'
import path from 'node:path'

export interface AbrState {
  currentProfileIndex: number  // index into PROFILES global array
  lastChangeAt: number
  cooldownMs: number
  profiles: Profile[]          // must equal PROFILES for consistent indexing
}

export type AbrAction = 'up' | 'down' | 'emergency-down' | 'none'

interface BandwidthReport {
  kbps: number
  bufferSeconds: number
}

export function computeAbrAction(report: BandwidthReport, state: AbrState, now: number): AbrAction {
  const { kbps, bufferSeconds } = report
  const { currentProfileIndex, lastChangeAt, cooldownMs, profiles } = state
  const current = profiles[currentProfileIndex]
  const inCooldown = now - lastChangeAt < cooldownMs

  if (bufferSeconds < 4) return 'emergency-down'
  if (inCooldown) return 'none'
  if (bufferSeconds < 8) return 'down'
  if (kbps < current.videoBitrate * 1.2) return 'down'
  const nextUp = profiles[currentProfileIndex - 1]
  if (nextUp && kbps > nextUp.videoBitrate * 1.5 && bufferSeconds > 15) return 'up'
  return 'none'
}

function send(session: Session, msg: object) {
  session.wsSocket?.send(JSON.stringify(msg))
}

/**
 * Serialize ffmpeg restart paths. kill → rm → spawn is not concurrent-safe:
 * SIGTERM returns immediately but the process can live up to 2s, and a second
 * spawn races it on shared r{N}/ paths. Callers drop the request when another
 * restart is in flight (client can retry). Add `ffmpegRestartInFlight?: boolean`
 * to Session (session/types.ts).
 */
async function withRestartLock(session: Session, fn: () => Promise<void>): Promise<boolean> {
  if (session.ffmpegRestartInFlight) return false
  session.ffmpegRestartInFlight = true
  try {
    await fn()
    return true
  } finally {
    session.ffmpegRestartInFlight = false
  }
}

async function restartFfmpegAtPosition(
  session: Session,
  hwAccel: HwAccel,
  newProfile: Profile,
): Promise<boolean> {
  return withRestartLock(session, async () => {
    killFfmpeg(session)
    // clean stale segments before restart
    for (let r = 0; r < session.profiles.length; r++) {
      await rm(path.join(session.sessionDir, `r${r}`), { recursive: true, force: true })
    }
    session.profiles = [newProfile]
    await spawnFfmpeg(session, hwAccel, session.profiles, session.selectedAudioTrack)
    send(session, {
      type: 'quality-changed',
      profile: newProfile,
      reason: 'abr-restart',
    })
  })
}

// WeakMap: auto-GC'd when session object is released from manager
const sessionAbrState = new WeakMap<Session, AbrState>()

export function handleWsMessage(
  msg: any,
  session: Session,
  sessions: SessionManager,
  cfg: Config,
  hwAccel: HwAccel,
) {
  switch (msg.type) {
    case 'hello': {
      // reconnect: verify token
      if (msg.reconnectToken && msg.reconnectToken !== session.reconnectToken) {
        session.wsSocket?.close(4401, 'invalid-reconnect-token')
        return
      }
      clearTimeout(session.graceTimer)
      session.state = 'active'
      // re-send session-ready
      send(session, {
        type: 'session-ready',
        method: session.method,
        streamUrl: session.method === 'direct-play'
          ? `/sessions/${session.id}/direct`
          : `/sessions/${session.id}/stream.m3u8`,
        profile: session.profiles[0],
        reconnectToken: session.reconnectToken,
      })
      break
    }

    case 'bandwidth-report': {
      if (session.method !== 'transcode') break // multi-rendition: informational only
      if (session.profiles.length > 1) break    // multi-rendition: hls.js handles ABR

      let abrState = sessionAbrState.get(session)
      if (!abrState) {
        const idx = PROFILES.findIndex(p => p.name === session.profiles[0].name)
        abrState = { currentProfileIndex: idx < 0 ? 0 : idx, lastChangeAt: 0, cooldownMs: 15_000, profiles: PROFILES }
        sessionAbrState.set(session, abrState)
      }

      const action = computeAbrAction(
        { kbps: msg.kbps, bufferSeconds: msg.bufferSeconds },
        abrState,
        Date.now(),
      )

      if (action === 'none') break
      const step = action === 'emergency-down' ? 2 : action === 'down' ? 1 : -1
      const newIdx = Math.max(0, Math.min(PROFILES.length - 1, abrState.currentProfileIndex + step))
      if (newIdx === abrState.currentProfileIndex) break

      abrState.currentProfileIndex = newIdx
      abrState.lastChangeAt = Date.now()

      restartFfmpegAtPosition(session, hwAccel, PROFILES[newIdx]).catch(console.error)
      send(session, {
        type: 'quality-changed',
        profile: PROFILES[newIdx],
        reason: action === 'emergency-down' ? 'buffer-low' : action === 'down' ? 'bandwidth-drop' : 'bandwidth-increase',
      })
      break
    }

    case 'seek': {
      const posMs = typeof msg.positionMs === 'number' ? msg.positionMs : 0
      session.seekPositionMs = posMs
      if (session.method === 'direct-play') break // client seeks natively
      withRestartLock(session, async () => {
        killFfmpeg(session)
        await Promise.all(session.profiles.map((_, r) =>
          rm(path.join(session.sessionDir, `r${r}`), { recursive: true, force: true })
        ))
        await spawnFfmpeg(session, hwAccel, session.profiles, session.selectedAudioTrack)
        send(session, { type: 'seek-ready', positionMs: posMs })
      }).then(started => {
        if (!started) send(session, { type: 'error', code: 'restart-busy', message: 'seek rejected: restart in progress' })
      }).catch(err => {
        console.error(`Session ${session.id}: seek failed`, err)
        send(session, { type: 'error', code: 'seek-failed', message: String(err) })
      })
      break
    }

    case 'quality-override': {
      if (session.method !== 'transcode') break
      if (msg.bitrate === 0) {
        // resume ABR: remove state so next report recomputes
        sessionAbrState.delete(session)
        break
      }
      const profile = PROFILES.find(p => p.videoBitrate <= msg.bitrate)
      if (!profile) break
      const idx = PROFILES.indexOf(profile)
      const abrState = sessionAbrState.get(session)
      if (abrState) abrState.currentProfileIndex = idx
      restartFfmpegAtPosition(session, hwAccel, profile).catch(console.error)
      send(session, { type: 'quality-changed', profile, reason: 'user-override' })
      break
    }

    case 'audio-track': {
      if (typeof msg.index !== 'number') break
      session.selectedAudioTrack = msg.index
      if (session.method === 'direct-play') {
        send(session, { type: 'track-changed', audioTrackIndex: msg.index })
        break
      }
      withRestartLock(session, async () => {
        killFfmpeg(session)
        await Promise.all(session.profiles.map((_, r) =>
          rm(path.join(session.sessionDir, `r${r}`), { recursive: true, force: true })
        ))
        await spawnFfmpeg(session, hwAccel, session.profiles, session.selectedAudioTrack)
        send(session, { type: 'track-changed', audioTrackIndex: msg.index })
      }).then(started => {
        if (!started) send(session, { type: 'error', code: 'restart-busy', message: 'audio-track rejected: restart in progress' })
      }).catch(err => {
        console.error(`Session ${session.id}: audio-track failed`, err)
        send(session, { type: 'error', code: 'audio-track-failed', message: String(err) })
      })
      break
    }

    case 'subtitle-track': {
      session.selectedSubtitleTrack = typeof msg.index === 'number' ? msg.index : null
      send(session, { type: 'track-changed', subtitleTrackIndex: session.selectedSubtitleTrack })
      break
    }

    case 'park': {
      session.state = 'parked'
      pauseFfmpeg(session)
      break
    }

    case 'resume': {
      session.state = 'active'
      resumeFfmpeg(session)
      break
    }
  }
}
```

- [ ] **Step 4: Run ABR tests — expect pass**

```bash
cd server && npx vitest run test/abr.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add server/src/ws/handler.ts server/test/abr.test.ts
git commit -m "feat(server): WebSocket handler with ABR, seek, park/resume, reconnect"
```

---

## Task 13: Subtitle Extraction

**Files:**
- Modify: `server/src/routes/sessions.ts` (add subtitle extraction call on session create)
- Create: `server/src/transcode/subtitles.ts`

- [ ] **Step 1: Implement subtitle extractor**

```typescript
// server/src/transcode/subtitles.ts
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { SubtitleTrack } from '../scanner/probe.ts'
import type { Session } from '../session/types.ts'

const EXTRACT_TIMEOUT_MS = 5 * 60_000 // hard cap to avoid hangs on broken streams

/**
 * Extract embeddable text subtitles to WebVTT files under sessionDir.
 * Spawns one ffmpeg with N -map outputs. Process is attached to
 * session.subtitleProcess so destroy() can kill it. Errors are non-fatal.
 *
 * Add to Session (session/types.ts):
 *   subtitleProcess?: import('node:child_process').ChildProcess
 *
 * Add to SessionManager.destroy() after killFfmpeg():
 *   if (session.subtitleProcess && !session.subtitleProcess.killed) {
 *     try { session.subtitleProcess.kill('SIGTERM') } catch {}
 *   }
 */
export async function extractSubtitles(
  filePath: string,
  subtitleTracks: SubtitleTrack[],
  sessionDir: string,
  session?: Session,
): Promise<void> {
  const embeddable = subtitleTracks.filter(t => t.embeddable)
  if (embeddable.length === 0) return

  await mkdir(sessionDir, { recursive: true })

  const args = ['-i', filePath, '-y', '-vn', '-an']
  for (const track of embeddable) {
    // SECURITY: coerce to integer — index comes from probe but defend the path join anyway
    const idx = Math.trunc(Number(track.index))
    if (!Number.isFinite(idx) || idx < 0) continue
    args.push(
      '-map', `0:s:${idx}`,
      '-c:s', 'webvtt',
      path.join(sessionDir, `sub_${idx}.vtt`),
    )
  }

  // Bail if every track was filtered out by the index guard
  if (args.indexOf('-map') === -1) return

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    if (session) session.subtitleProcess = proc

    let stderrBuf = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      // keep last ~4KB for diagnostics; full output is noisy
      stderrBuf = (stderrBuf + chunk.toString()).slice(-4096)
    })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`subtitle extraction timed out after ${EXTRACT_TIMEOUT_MS}ms`))
    }, EXTRACT_TIMEOUT_MS)

    proc.on('error', (err) => {
      clearTimeout(timer)
      if (session) session.subtitleProcess = undefined
      reject(err)
    })

    proc.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (session) session.subtitleProcess = undefined
      if (code === 0) resolve()
      else if (signal === 'SIGTERM' || signal === 'SIGKILL') resolve() // killed by destroy — not an error
      else reject(new Error(`ffmpeg subtitle extraction exited code=${code}; tail: ${stderrBuf}`))
    })
  })
}
```

- [ ] **Step 2: Call subtitle extraction in session creation**

In `server/src/routes/sessions.ts`, inside the `spawnFfmpeg(...).then(...)` block, add after the session-ready send:

```typescript
// After spawnFfmpeg resolves, also extract subtitles concurrently
import { extractSubtitles } from '../transcode/subtitles.ts'

// In the .then() after spawnFfmpeg — pass session so destroy() can reap it:
extractSubtitles(media.filePath, media.subtitleTracks ?? [], session.sessionDir, session)
  .catch(err => console.error(`Session ${session.id}: subtitle extraction error`, err))
```

Full updated block in sessions.ts (replace the existing spawnFfmpeg call):

```typescript
if (decision.method !== 'direct-play') {
  spawnFfmpeg(session, hwAccel, profiles, audioTrackIndex).then(() => {
    session.wsSocket?.socket.send(JSON.stringify({
      type: 'session-ready',
      method: session.method,
      streamUrl: decision.method === 'direct-play'
        ? `/sessions/${session.id}/direct`
        : `/sessions/${session.id}/stream.m3u8`,
      profile: profiles[0],
      reconnectToken: session.reconnectToken,
    }))
    session.state = 'active'
    // extract text subtitles in background
    extractSubtitles(media.filePath, media.subtitleTracks ?? [], session.sessionDir)
      .catch(err => console.error('Subtitle extraction error:', err))
  }).catch(err => {
    sessions.destroy(session.id)
    console.error('FFmpeg start error:', err)
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add server/src/transcode/subtitles.ts server/src/routes/sessions.ts
git commit -m "feat(server): subtitle extraction to WebVTT for text-based tracks"
```

---

## Task 14: SDK — Types + Capability Detection

**Files:**
- Create: `sdk/src/types.ts`
- Create: `sdk/src/capabilities.ts`
- Create: `sdk/test/capabilities.test.ts`

- [ ] **Step 1: Write capability tests**

```typescript
// sdk/test/capabilities.test.ts
import { describe, it, expect, vi } from 'vitest'
import { detectCapabilities } from '../src/capabilities.ts'

describe('detectCapabilities', () => {
  it('returns safe defaults when MediaSource unavailable (non-browser)', () => {
    const caps = detectCapabilities()
    expect(caps.videoCodecs).toContain('h264')
    expect(caps.audioCodecs).toContain('aac')
    expect(caps.container).toContain('mp4')
    expect(caps.maxBitrate).toBe(0)
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
cd sdk && npx vitest run test/capabilities.test.ts
```

- [ ] **Step 3: Implement types + capabilities**

```typescript
// sdk/src/types.ts
export interface ClientCapabilities {
  videoCodecs: string[]
  audioCodecs: string[]
  hdr: string[]
  maxBitrate: number    // kbps; 0 = unlimited
  container: string[]
}

export type PlaybackMethod = 'direct-play' | 'direct-stream' | 'partial-transcode' | 'transcode'

export type HorizonErrorCode =
  | 'media-not-found' | 'session-not-found' | 'session-attach-timeout'
  | 'capabilities-unsupported' | 'transcode-failed' | 'file-read-error'
  | 'audio-track-invalid' | 'max-sessions' | 'probe-failed'
  | 'session-destroyed' | 'network-error'

export interface HorizonError {
  code: HorizonErrorCode
  message: string
  fatal: boolean
}

export interface HorizonWarning {
  code: string
  message: string
}

export interface QualityProfile {
  name?: string
  videoBitrate: number
  audioBitrate: number
  width?: number
  height?: number
  videoCodec?: string   // not included in server Profile; optional for display only
  audioCodec?: string
}

export interface SessionInfo {
  sessionId: string
  method: PlaybackMethod
  streamUrl: string
  wsUrl: string
  profiles: QualityProfile[]
  selectedAudioTrack: number
  selectedSubtitleTrack: number | null
}

export interface AudioTrack {
  index: number
  codec: string
  channels: number
  language: string
  title: string
  default: boolean
}

export interface SubtitleTrack {
  index: number
  codec: string
  language: string
  forced: boolean
  embeddable: boolean
}

export interface MediaItem {
  id: string
  title: string
  year?: number
  duration: number
  resolution: string
  videoCodec: string
  hdr: { dv: boolean; hdr10: boolean; hdr10plus: boolean }
  audioTracks: AudioTrack[]
  subtitleTracks: SubtitleTrack[]
  container: string
}
```

```typescript
// sdk/src/capabilities.ts
import type { ClientCapabilities } from './types.ts'

const CODEC_TESTS: Array<{ codec: string; mimeType: string }> = [
  { codec: 'hevc', mimeType: 'video/mp4; codecs="hvc1.1.6.L150.90"' },
  { codec: 'h264', mimeType: 'video/mp4; codecs="avc1.640028"' },
  { codec: 'av1',  mimeType: 'video/mp4; codecs="av01.0.08M.08"' },
  { codec: 'vp9',  mimeType: 'video/webm; codecs="vp9"' },
]

const AUDIO_TESTS: Array<{ codec: string; mimeType: string }> = [
  { codec: 'eac3', mimeType: 'audio/mp4; codecs="ec-3"' },
  { codec: 'ac3',  mimeType: 'audio/mp4; codecs="ac-3"' },
  { codec: 'aac',  mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
  { codec: 'opus', mimeType: 'audio/webm; codecs="opus"' },
]

const HDR_TESTS: Array<{ format: string; mimeType: string }> = [
  { format: 'dv',    mimeType: 'video/mp4; codecs="dvhe.08.07"' },
  { format: 'hdr10', mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0"' },
]

function supported(mimeType: string): boolean {
  if (typeof MediaSource === 'undefined') return false
  try {
    return MediaSource.isTypeSupported(mimeType)
  } catch {
    return false
  }
}

export function detectCapabilities(overrides?: Partial<ClientCapabilities>): ClientCapabilities {
  const videoCodecs = CODEC_TESTS.filter(t => supported(t.mimeType)).map(t => t.codec)
  const audioCodecs = AUDIO_TESTS.filter(t => supported(t.mimeType)).map(t => t.codec)
  const hdr = HDR_TESTS.filter(t => supported(t.mimeType)).map(t => t.format)
  const container = ['mp4']
  if (typeof MediaSource === 'undefined') {
    // non-browser: return safe defaults
    return {
      videoCodecs: overrides?.videoCodecs ?? ['h264'],
      audioCodecs: overrides?.audioCodecs ?? ['aac'],
      hdr: overrides?.hdr ?? [],
      maxBitrate: overrides?.maxBitrate ?? 0,
      container: overrides?.container ?? ['mp4'],
    }
  }
  // ensure h264 + aac always present as fallback
  if (!videoCodecs.includes('h264')) videoCodecs.push('h264')
  if (!audioCodecs.includes('aac')) audioCodecs.push('aac')

  // NOTE: do NOT spread `...overrides` after the explicit `?? fallback` lines —
  // explicit `undefined` in overrides would clobber the computed value.
  return {
    videoCodecs: overrides?.videoCodecs ?? videoCodecs,
    audioCodecs: overrides?.audioCodecs ?? audioCodecs,
    hdr: overrides?.hdr ?? hdr,
    maxBitrate: overrides?.maxBitrate ?? 0,
    container: overrides?.container ?? container,
  }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd sdk && npx vitest run test/capabilities.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add sdk/src/types.ts sdk/src/capabilities.ts sdk/test/capabilities.test.ts
git commit -m "feat(sdk): shared types + MediaSource capability detection"
```

> **Implementation note (2026-04-22):** the scaffolded `sdk/tsconfig.json` had `rootDir: "src"` while including `test/**/*`, so `tsc --noEmit` errored TS6059 for the new test file. Fixed inline by widening `rootDir` to `"."` and adding `allowImportingTsExtensions: true` + `noEmit: true` (mirroring `server/tsconfig.json`). A real bundler/build config will land with later SDK packaging work; staging the fix as part of this commit.

---

## Task 15: SDK — Bandwidth Measurement

**Files:**
- Create: `sdk/src/bandwidth.ts`

- [ ] **Step 1: Implement**

```typescript
// sdk/src/bandwidth.ts
export interface BandwidthSample {
  kbps: number
  segmentDownloadMs: number
  timestamp: number
}

export class BandwidthSampler {
  private samples: BandwidthSample[] = []
  private readonly windowSize = 5

  record(bytes: number, durationMs: number) {
    // skip uninformative samples — they would dilute the rolling estimate
    if (durationMs <= 0 || bytes <= 0) return
    const kbps = Math.round((bytes * 8) / durationMs)  // bytes * 8 bits / ms = kbps
    this.samples.push({ kbps, segmentDownloadMs: durationMs, timestamp: Date.now() })
    if (this.samples.length > this.windowSize) this.samples.shift()
  }

  estimate(): number {
    if (this.samples.length === 0) return 0
    // weighted average: more recent samples weighted higher
    let weightedSum = 0
    let totalWeight = 0
    this.samples.forEach((s, i) => {
      const weight = i + 1
      weightedSum += s.kbps * weight
      totalWeight += weight
    })
    return Math.round(weightedSum / totalWeight)
  }

  lastSample(): BandwidthSample | undefined {
    // return a shallow copy — caller must not mutate internal state
    const last = this.samples[this.samples.length - 1]
    return last ? { ...last } : undefined
  }

  reset(): void {
    this.samples = []
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add sdk/src/bandwidth.ts
git commit -m "feat(sdk): weighted bandwidth sampler"
```

---

## Task 16: SDK — PlaybackSession + HorizonClient

**Files:**
- Create: `sdk/src/session.ts`
- Create: `sdk/src/client.ts`
- Create: `sdk/src/index.ts`

- [ ] **Step 1: Implement PlaybackSession**

```typescript
// sdk/src/session.ts
import type {
  ClientCapabilities, PlaybackMethod, QualityProfile,
  HorizonError, HorizonWarning, SessionInfo,
} from './types.ts'
import { BandwidthSampler } from './bandwidth.ts'

export type SessionState = 'attaching' | 'active' | 'detached' | 'destroyed'

export interface PlaybackSessionOptions {
  sessionInfo: SessionInfo
  baseUrl: string
  capabilities: ClientCapabilities
  onReady?: (info: SessionInfo) => void
  onQualityChange?: (profile: QualityProfile, reason: string) => void
  onTrackChange?: (info: { audio?: number; subtitle?: number | null }) => void
  onWarning?: (w: HorizonWarning) => void
  onEnded?: () => void
  onError?: (err: HorizonError) => void
}

const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_BASE_MS = 1000

export class PlaybackSession {
  readonly sessionId: string
  readonly method: PlaybackMethod
  readonly streamUrl: string
  readonly wsUrl: string

  private _profile: QualityProfile
  private _state: SessionState = 'attaching'
  private _ws: WebSocket | null = null
  private _reconnectToken: string | null = null
  private _reconnectAttempts = 0
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _sampler = new BandwidthSampler()
  private _opts: PlaybackSessionOptions
  private _destroyed = false

  constructor(opts: PlaybackSessionOptions) {
    this._opts = opts
    this.sessionId = opts.sessionInfo.sessionId
    this.method = opts.sessionInfo.method
    this.streamUrl = `${opts.baseUrl}${opts.sessionInfo.streamUrl}`
    this.wsUrl = `${opts.baseUrl.replace(/^http/, 'ws')}${opts.sessionInfo.wsUrl}`
    this._profile = opts.sessionInfo.profiles?.[0] as QualityProfile
    this._connect()
    this._registerUnloadCleanup()
  }

  get state(): SessionState { return this._state }
  get profile(): QualityProfile { return this._profile }

  private _connect() {
    if (this._destroyed) return
    this._ws = new WebSocket(this.wsUrl)

    this._ws.onopen = () => {
      this._reconnectAttempts = 0
      if (this._reconnectToken) {
        this._send({ type: 'hello', reconnectToken: this._reconnectToken })
      }
    }

    this._ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        this._handleMessage(msg)
      } catch { /* ignore */ }
    }

    this._ws.onclose = () => {
      if (this._destroyed) return
      this._state = 'detached'
      this._scheduleReconnect()
    }

    this._ws.onerror = () => {
      // close event will fire next; handled there
    }
  }

  private _scheduleReconnect() {
    if (this._destroyed || this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._opts.onError?.({
        code: 'session-destroyed',
        message: 'WebSocket reconnect failed — session expired',
        fatal: true,
      })
      this._state = 'destroyed'
      return
    }
    const delay = RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts)
    this._reconnectAttempts++
    this._reconnectTimer = setTimeout(() => this._connect(), delay)
  }

  private _handleMessage(msg: any) {
    switch (msg.type) {
      case 'session-ready':
        this._reconnectToken = msg.reconnectToken ?? null
        this._profile = msg.profile
        this._state = 'active'
        this._opts.onReady?.(this._opts.sessionInfo)
        break
      case 'quality-changed':
        this._profile = msg.profile
        this._opts.onQualityChange?.(msg.profile, msg.reason)
        break
      case 'track-changed':
        this._opts.onTrackChange?.({ audio: msg.audioTrackIndex, subtitle: msg.subtitleTrackIndex })
        break
      case 'warning':
        this._opts.onWarning?.({ code: msg.code, message: msg.message })
        break
      case 'error':
        this._opts.onError?.({ code: msg.code, message: msg.message, fatal: msg.fatal ?? true })
        if (msg.fatal) { this._state = 'destroyed'; this._destroyed = true }
        break
      case 'ended':
        this._opts.onEnded?.()
        break
      case 'seek-ready':
        // client may reload HLS source here
        break
    }
  }

  private _send(msg: object) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg))
    }
  }

  /** Call with hls.js fragment-loaded stats */
  reportSegment(bytes: number, durationMs: number, bufferSeconds: number) {
    this._sampler.record(bytes, durationMs)
    this._send({
      type: 'bandwidth-report',
      kbps: this._sampler.estimate(),
      bufferSeconds,
      segmentDownloadMs: durationMs,
    })
  }

  seek(positionMs: number) {
    this._send({ type: 'seek', positionMs })
  }

  setQuality(bitrateKbps: number | 'auto') {
    this._send({ type: 'quality-override', bitrate: bitrateKbps === 'auto' ? 0 : bitrateKbps })
  }

  setAudioTrack(index: number) {
    this._send({ type: 'audio-track', index })
  }

  setSubtitleTrack(index: number | null) {
    this._send({ type: 'subtitle-track', index })
  }

  park() { this._send({ type: 'park' }) }
  resume() { this._send({ type: 'resume' }) }

  disconnect() {
    this._destroyed = true
    this._state = 'destroyed'
    clearTimeout(this._reconnectTimer ?? undefined)
    this._ws?.close()
    // fire and forget DELETE
    fetch(`${this._opts.baseUrl}/sessions/${this.sessionId}`, { method: 'DELETE' }).catch(() => {})
  }

  private _registerUnloadCleanup() {
    if (typeof window === 'undefined') return
    const handler = () => this.disconnect()
    window.addEventListener('beforeunload', handler)
    window.addEventListener('pagehide', handler)
  }
}
```

- [ ] **Step 2: Implement HorizonClient**

```typescript
// sdk/src/client.ts
import type { ClientCapabilities, MediaItem, SessionInfo } from './types.ts'
import { detectCapabilities } from './capabilities.ts'
import { PlaybackSession, type PlaybackSessionOptions } from './session.ts'

export interface HorizonClientOptions {
  baseUrl: string
}

export interface PlayOptions extends Omit<PlaybackSessionOptions, 'sessionInfo' | 'baseUrl' | 'capabilities'> {
  capabilities?: Partial<ClientCapabilities>
  audioTrackIndex?: number
  subtitleTrackIndex?: number | null
  autoCleanup?: boolean
}

export class HorizonClient {
  private baseUrl: string

  constructor(opts: HorizonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { code: body.code })
    }
    return res.json()
  }

  readonly library = {
    listMovies: () => this.fetch<MediaItem[]>('/library/movies'),
    listCollections: () => this.fetch<{ id: string; name: string; movies: MediaItem[] }[]>('/library/movies/collections'),
    listShows: () => this.fetch<{ id: string; title: string; seasonCount: number }[]>('/library/shows'),
    listSeasons: (showId: string) => this.fetch<{ number: number; episodeCount: number }[]>(`/library/shows/${showId}/seasons`),
    listEpisodes: (showId: string, season: number) => this.fetch<MediaItem[]>(`/library/shows/${showId}/seasons/${season}`),
  }

  async play(mediaId: string, opts: PlayOptions): Promise<PlaybackSession> {
    const caps = detectCapabilities(opts.capabilities)
    const sessionInfo = await this.fetch<SessionInfo>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        mediaId,
        capabilities: caps,
        audioTrackIndex: opts.audioTrackIndex ?? 0,
        subtitleTrackIndex: opts.subtitleTrackIndex ?? null,
      }),
    })

    return new PlaybackSession({
      sessionInfo,
      baseUrl: this.baseUrl,
      capabilities: caps,
      onReady: opts.onReady,
      onQualityChange: opts.onQualityChange,
      onTrackChange: opts.onTrackChange,
      onWarning: opts.onWarning,
      onEnded: opts.onEnded,
      onError: opts.onError,
    })
  }
}
```

- [ ] **Step 3: Create index exports**

```typescript
// sdk/src/index.ts
export { HorizonClient } from './client.ts'
export { PlaybackSession } from './session.ts'
export { detectCapabilities } from './capabilities.ts'
export { BandwidthSampler } from './bandwidth.ts'
export type {
  ClientCapabilities, PlaybackMethod, QualityProfile,
  HorizonError, HorizonWarning, HorizonErrorCode,
  SessionInfo, MediaItem, AudioTrack, SubtitleTrack,
} from './types.ts'
```

- [ ] **Step 4: Commit**

```bash
git add sdk/src/session.ts sdk/src/client.ts sdk/src/index.ts
git commit -m "feat(sdk): HorizonClient + PlaybackSession with WS lifecycle and reconnect"
```

---

## Task 17: App Scaffold

**Files:**
- Create: `app/vite.config.ts`
- Create: `app/index.html`
- Create: `app/src/main.tsx`
- Create: `app/src/App.tsx`
- Create: `app/src/horizon.ts`

- [ ] **Step 1: Create Vite config**

```typescript
// app/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/library': 'http://localhost:7777',
      '/sessions': { target: 'http://localhost:7777', ws: true },
      '/health': 'http://localhost:7777',
    },
  },
})
```

```html
<!-- app/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Horizon</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #0a0a0a; color: #f0f0f0; font-family: system-ui, sans-serif; }
      a { color: inherit; text-decoration: none; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```typescript
// app/src/horizon.ts
import { HorizonClient } from '@horizon/sdk'
export const horizon = new HorizonClient({ baseUrl: '' }) // empty = same origin via Vite proxy
```

```tsx
// app/src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
```

```tsx
// app/src/App.tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import Library from './pages/Library.tsx'
import Player from './pages/Player.tsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Library />} />
      <Route path="/play/:mediaId" element={<Player />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/vite.config.ts app/index.html app/src/main.tsx app/src/App.tsx app/src/horizon.ts
git commit -m "feat(app): Vite + React scaffold with routing and server proxy"
```

---

## Task 18: Library Page

**Files:**
- Create: `app/src/components/MediaCard.tsx`
- Create: `app/src/pages/Library.tsx`

- [ ] **Step 1: Implement**

```tsx
// app/src/components/MediaCard.tsx
import { useNavigate } from 'react-router-dom'
import type { MediaItem } from '@horizon/sdk'

interface Props { item: MediaItem; subtitle?: string }

export default function MediaCard({ item, subtitle }: Props) {
  const navigate = useNavigate()
  const [w, h] = (item.resolution ?? '').split('x')
  const res = parseInt(h) >= 2160 ? '4K' : parseInt(h) >= 1080 ? '1080p' : '720p'
  const hdrBadge = item.hdr?.dv ? 'DV' : item.hdr?.hdr10 ? 'HDR10' : null

  return (
    <div
      onClick={() => navigate(`/play/${item.id}`)}
      style={{
        cursor: 'pointer', background: '#1a1a1a', borderRadius: 8,
        padding: 16, display: 'flex', flexDirection: 'column', gap: 8,
        border: '1px solid #2a2a2a', transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = '#555')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a2a2a')}
    >
      <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.3 }}>
        {item.title}{item.year ? ` (${item.year})` : ''}
      </div>
      {subtitle && <div style={{ fontSize: 12, color: '#888' }}>{subtitle}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        <Badge>{res}</Badge>
        {hdrBadge && <Badge color="#8b5cf6">{hdrBadge}</Badge>}
        <Badge>{item.videoCodec?.toUpperCase()}</Badge>
        {item.audioTracks?.[0] && <Badge>{item.audioTracks[0].codec.toUpperCase()}</Badge>}
      </div>
    </div>
  )
}

function Badge({ children, color = '#333' }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      background: color, borderRadius: 4, padding: '2px 6px',
      fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
    }}>
      {children}
    </span>
  )
}
```

```tsx
// app/src/pages/Library.tsx
import { useEffect, useState } from 'react'
import { horizon } from '../horizon.ts'
import MediaCard from '../components/MediaCard.tsx'
import type { MediaItem } from '@horizon/sdk'

type Tab = 'movies' | 'shows' | 'collections'

export default function Library() {
  const [tab, setTab] = useState<Tab>('movies')
  const [movies, setMovies] = useState<MediaItem[]>([])
  const [shows, setShows] = useState<{ id: string; title: string; seasonCount?: number }[]>([])
  const [collections, setCollections] = useState<{ id: string; name: string; movies: MediaItem[] }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      horizon.library.listMovies().then(setMovies),
      horizon.library.listShows().then(setShows),
      horizon.library.listCollections().then(setCollections),
    ]).finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 16px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Horizon</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {(['movies', 'shows', 'collections'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: tab === t ? '#fff' : '#222', color: tab === t ? '#000' : '#fff',
              fontWeight: 600, textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: '#666' }}>Loading library…</p>}

      {!loading && tab === 'movies' && (
        <Grid>
          {movies.map(m => <MediaCard key={m.id} item={m} />)}
          {movies.length === 0 && <Empty>No movies found. Check HORIZON_MOVIES_ROOT.</Empty>}
        </Grid>
      )}

      {!loading && tab === 'shows' && (
        <Grid>
          {shows.map(s => (
            <div key={s.id} style={{ background: '#1a1a1a', borderRadius: 8, padding: 16, border: '1px solid #2a2a2a' }}>
              <div style={{ fontWeight: 600 }}>{s.title}</div>
            </div>
          ))}
          {shows.length === 0 && <Empty>No shows found. Check HORIZON_SHOWS_ROOT.</Empty>}
        </Grid>
      )}

      {!loading && tab === 'collections' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {collections.map(col => (
            <div key={col.id}>
              <h2 style={{ fontSize: 18, marginBottom: 12 }}>{col.name}</h2>
              <Grid>
                {col.movies.map((m, i) => <MediaCard key={m.id} item={m} subtitle={`Part ${i + 1}`} />)}
              </Grid>
            </div>
          ))}
          {collections.length === 0 && <Empty>No collections detected.</Empty>}
        </div>
      )}
    </div>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: '#666', gridColumn: '1/-1' }}>{children}</p>
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/components/MediaCard.tsx app/src/pages/Library.tsx
git commit -m "feat(app): library page with movies, shows, collections tabs"
```

---

## Task 19: VideoPlayer + QualityOverlay

**Files:**
- Create: `app/src/components/VideoPlayer.tsx`
- Create: `app/src/components/QualityOverlay.tsx`
- Create: `app/src/pages/Player.tsx`

- [ ] **Step 1: Implement VideoPlayer**

```tsx
// app/src/components/VideoPlayer.tsx
import { useEffect, useRef } from 'react'
import Hls from 'hls.js'
import type { PlaybackSession, QualityProfile } from '@horizon/sdk'

interface Props {
  session: PlaybackSession
  onBufferUpdate?: (seconds: number) => void
  onQualityChange?: (profile: QualityProfile, reason: string) => void
}

export default function VideoPlayer({ session, onBufferUpdate, onQualityChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (session.method === 'direct-play') {
      video.src = session.streamUrl
      return
    }

    if (!Hls.isSupported()) {
      video.src = session.streamUrl
      return
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
    })
    hlsRef.current = hls
    hls.loadSource(session.streamUrl)
    hls.attachMedia(video)

    hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
      const bytes = data.frag.stats.total
      const durationMs = data.frag.stats.loading.end - data.frag.stats.loading.start
      const bufferSeconds = hls.mainForwardBufferInfo?.len ?? 0
      session.reportSegment(bytes, durationMs, bufferSeconds)
      onBufferUpdate?.(bufferSeconds)
    })

    video.play().catch(() => {})

    return () => {
      hls.destroy()
      hlsRef.current = null
    }
  }, [session])

  // keyboard controls
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handler = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'Space': e.preventDefault(); video.paused ? video.play() : video.pause(); break
        case 'ArrowLeft': video.currentTime -= 10; break
        case 'ArrowRight': video.currentTime += 10; break
        case 'ArrowUp': video.volume = Math.min(1, video.volume + 0.1); break
        case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.1); break
        case 'KeyF': document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen(); break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <video
      ref={videoRef}
      controls
      style={{ width: '100%', height: '100%', background: '#000' }}
      playsInline
    />
  )
}
```

- [ ] **Step 2: Implement QualityOverlay**

```tsx
// app/src/components/QualityOverlay.tsx
import type { PlaybackMethod, QualityProfile } from '@horizon/sdk'

interface QualityLogEntry {
  profile: QualityProfile
  reason: string
  time: Date
}

interface Props {
  method: PlaybackMethod
  profile: QualityProfile | null
  bufferSeconds: number
  qualityLog: QualityLogEntry[]
}

const METHOD_COLORS: Record<PlaybackMethod, string> = {
  'direct-play': '#22c55e',
  'direct-stream': '#3b82f6',
  'partial-transcode': '#f59e0b',
  'transcode': '#ef4444',
}

const METHOD_LABELS: Record<PlaybackMethod, string> = {
  'direct-play': 'DIRECT PLAY',
  'direct-stream': 'DIRECT STREAM',
  'partial-transcode': 'PARTIAL TRANSCODE',
  'transcode': 'TRANSCODE',
}

export default function QualityOverlay({ method, profile, bufferSeconds, qualityLog }: Props) {
  const bufferPct = Math.min(100, (bufferSeconds / 30) * 100)

  return (
    <div style={{
      position: 'absolute', top: 16, right: 16, background: 'rgba(0,0,0,0.8)',
      borderRadius: 8, padding: '10px 14px', minWidth: 220, fontSize: 12,
      display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none',
    }}>
      {/* Method badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: METHOD_COLORS[method] ?? '#888',
        }} />
        <span style={{ fontWeight: 700, letterSpacing: 0.5 }}>{METHOD_LABELS[method]}</span>
      </div>

      {/* Quality */}
      {profile && (
        <div style={{ color: '#ccc' }}>
          {profile.height ? `${profile.height}p` : '—'} · {Math.round(profile.videoBitrate / 1000)} Mbps
        </div>
      )}

      {/* Buffer bar */}
      <div>
        <div style={{ color: '#666', marginBottom: 3 }}>
          Buffer: {bufferSeconds.toFixed(1)}s
        </div>
        <div style={{ height: 4, background: '#333', borderRadius: 2 }}>
          <div style={{
            height: '100%', borderRadius: 2,
            width: `${bufferPct}%`,
            background: bufferSeconds < 4 ? '#ef4444' : bufferSeconds < 8 ? '#f59e0b' : '#22c55e',
            transition: 'width 0.5s',
          }} />
        </div>
      </div>

      {/* Quality log */}
      {qualityLog.length > 0 && (
        <div style={{ borderTop: '1px solid #333', paddingTop: 8 }}>
          <div style={{ color: '#666', marginBottom: 4 }}>Recent switches</div>
          {qualityLog.slice(-5).reverse().map((entry, i) => (
            <div key={i} style={{ color: '#aaa', fontSize: 11, lineHeight: 1.6 }}>
              {entry.time.toLocaleTimeString()} — {entry.profile.height}p ({entry.reason})
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Implement Player page**

```tsx
// app/src/pages/Player.tsx
import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import VideoPlayer from '../components/VideoPlayer.tsx'
import QualityOverlay from '../components/QualityOverlay.tsx'
import type { PlaybackSession, QualityProfile, MediaItem } from '@horizon/sdk'

export default function Player() {
  const { mediaId } = useParams<{ mediaId: string }>()
  const navigate = useNavigate()
  const [session, setSession] = useState<PlaybackSession | null>(null)
  const [media, setMedia] = useState<MediaItem | null>(null)
  const [currentProfile, setCurrentProfile] = useState<QualityProfile | null>(null)
  const [bufferSeconds, setBufferSeconds] = useState(0)
  const [qualityLog, setQualityLog] = useState<{ profile: QualityProfile; reason: string; time: Date }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef<PlaybackSession | null>(null)

  useEffect(() => {
    if (!mediaId) return

    horizon.library.listMovies()
      .then(movies => setMedia(movies.find(m => m.id === mediaId) ?? null))
      .catch(() => {})

    horizon.play(mediaId, {
      onReady: (info) => {
        setLoading(false)
        setCurrentProfile(info.profiles?.[0] ?? null)
      },
      onQualityChange: (profile, reason) => {
        setCurrentProfile(profile)
        setQualityLog(log => [...log, { profile, reason, time: new Date() }])
      },
      onError: (err) => {
        setError(err.message)
        setLoading(false)
      },
      onEnded: () => navigate('/'),
    }).then(s => {
      setSession(s)
      sessionRef.current = s
    }).catch(err => {
      setError(String(err.message ?? err))
      setLoading(false)
    })

    return () => { sessionRef.current?.disconnect() }
  }, [mediaId])

  if (error) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16 }}>
      <div style={{ color: '#ef4444', fontSize: 18 }}>Playback error</div>
      <div style={{ color: '#888' }}>{error}</div>
      <button onClick={() => navigate('/')} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#fff', color: '#000' }}>← Back</button>
    </div>
  )

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000' }}>
      {/* Back button */}
      <button
        onClick={() => { sessionRef.current?.disconnect(); navigate('/') }}
        style={{
          position: 'absolute', top: 16, left: 16, zIndex: 10,
          background: 'rgba(0,0,0,0.7)', border: '1px solid #444',
          color: '#fff', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
        }}
      >
        ← Library
      </button>

      {/* Loading */}
      {loading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#888',
        }}>
          <div style={{ fontSize: 14 }}>Starting playback…</div>
          {media && <div style={{ fontSize: 12 }}>{media.title}</div>}
        </div>
      )}

      {/* Video */}
      {session && (
        <VideoPlayer
          session={session}
          onBufferUpdate={setBufferSeconds}
          onQualityChange={(profile, reason) => {
            setCurrentProfile(profile)
            setQualityLog(log => [...log, { profile, reason, time: new Date() }])
          }}
        />
      )}

      {/* Overlay */}
      {session && currentProfile && (
        <QualityOverlay
          method={session.method}
          profile={currentProfile}
          bufferSeconds={bufferSeconds}
          qualityLog={qualityLog}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add app/src/components/VideoPlayer.tsx app/src/components/QualityOverlay.tsx app/src/pages/Player.tsx
git commit -m "feat(app): player page with hls.js, quality overlay, keyboard controls"
```

---

## Task 20: End-to-End Verification

**Goal:** confirm server starts, scans the media file in the working directory, creates a session, FFmpeg spawns and is killed on disconnect.

- [ ] **Step 1: Start the server with the test media file**

```bash
cd /Users/luuk/Projects/slimluccii/horizon
HORIZON_MOVIES_ROOT="$(pwd)" HORIZON_PORT=7777 npm -w server run dev
```

Expected: server logs `Library: 1 movies, 0 shows`, `Horizon listening on :7777`

- [ ] **Step 2: Verify health endpoint**

```bash
curl http://localhost:7777/health
```

Expected:
```json
{"status":"ok","ffmpeg":"ffmpeg version ...","hwAccel":"videotoolbox"}
```

- [ ] **Step 3: Verify library endpoint returns the test file**

```bash
curl http://localhost:7777/library/movies | python3 -m json.tool
```

Expected: JSON array with one movie entry whose `title` contains "A Knight of the Seven Kingdoms".

- [ ] **Step 4: Create a session (browser caps)**

```bash
curl -X POST http://localhost:7777/sessions \
  -H "Content-Type: application/json" \
  -d '{"mediaId":"<ID_FROM_STEP_3>","capabilities":{"videoCodecs":["h264"],"audioCodecs":["aac"],"hdr":[],"maxBitrate":8000,"container":["mp4"]}}'
```

Expected: `{"sessionId":"...","method":"transcode","streamUrl":"/sessions/.../stream.m3u8","wsUrl":"/sessions/.../ws",...}`

Copy the `sessionId`.

- [ ] **Step 5: Verify FFmpeg spawned and segments exist**

```bash
ls /tmp/horizon/sessions/<sessionId>/r0/
```

Expected: at least 3 `.m4s` segment files + `index.m3u8`

- [ ] **Step 6: Verify DELETE kills FFmpeg**

```bash
curl -X DELETE http://localhost:7777/sessions/<sessionId>
```

Then:

```bash
ls /tmp/horizon/sessions/<sessionId>/
```

Expected: `No such file or directory` — session dir cleaned up.

- [ ] **Step 7: Start the app and play in browser**

```bash
# Terminal 2 (keep server running in terminal 1)
npm -w app run dev
```

Open `http://localhost:5173` in browser.

Verify:
- Library page loads, shows "A Knight of the Seven Kingdoms"
- Click card → Player page shows loading
- After a few seconds, video plays
- Quality overlay shows `TRANSCODE` badge, bitrate, buffer bar
- Press Space to pause/play, arrow keys seek
- Click ← Library → session disconnects (DELETE fires, FFmpeg killed)

- [ ] **Step 8: Verify WS disconnect kills FFmpeg**

In browser, open DevTools → Network → WS. Start playback. Close the browser tab. Wait 10s (grace window). Check server logs: should show `Session destroyed` and temp dir removed.

- [ ] **Step 9: Commit final state**

```bash
git add -A
git commit -m "feat: Horizon streaming server, SDK, and test app — complete v1"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Direct play / direct stream / partial transcode / full transcode decision
- ✅ Multi-rendition HLS for transcode (client-side ABR)
- ✅ Hardware accel: VideoToolbox → NVENC → QSV → CPU
- ✅ Hardware decode on input
- ✅ HDR capability check + needsToneMap flag threaded through decision → session → ffmpeg.ts vf filter
- ✅ HEVC encoder chosen only when client caps include 'hevc'
- ✅ Per-rendition CODECS string in HLS master playlist (avc1 vs hvc1)
- ✅ WebSocket per session: bandwidth-report, seek, quality-override, park, resume, audio-track, subtitle-track
- ✅ ABR: per-segment trigger, buffer-based, cooldown; stale segments cleaned on seek/track change
- ✅ 10s grace window on WS disconnect
- ✅ 10s attach window (TTL if WS never connects)
- ✅ session-ready sent correctly even when FFmpeg finishes before WS attaches
- ✅ Reconnect token
- ✅ Session TTL + max sessions cap
- ✅ ffprobe cache (path+mtime+size, correct key for both read and write)
- ✅ ABR state WeakMap — auto-GC'd with session object, no manual cleanup needed
- ✅ Collection detection
- ✅ Audio + subtitle track selection (WS handlers implemented)
- ✅ WebVTT subtitle extraction (skip A/V demux with -vn -an)
- ✅ SDK: HorizonClient, PlaybackSession, capability detection, bandwidth sampler
- ✅ SDK: auto-cleanup on unload (guarded for non-browser envs)
- ✅ SDK: WS reconnect with backoff
- ✅ SDK: QualityProfile codec fields optional (server Profile doesn't include them)
- ✅ App: Library page (movies, shows, collections)
- ✅ App: Player page with hls.js + direct play
- ✅ App: QualityOverlay (method badge, buffer bar, log)
- ✅ App: keyboard controls
- ✅ CORS config
- ✅ Error taxonomy exported from SDK
- ✅ Range request validation (416 on malformed/out-of-bounds range)
- ✅ selectRenditionLadder fallback when all profiles exceed source width
