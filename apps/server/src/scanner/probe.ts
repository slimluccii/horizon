import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const execFileAsync = promisify(execFile)

/** ffprobe wall-clock cap. Without it a pathological input could hang the
 *  scan worker indefinitely. 60s (not 30s) tolerates ffprobe on very large
 *  files (>50GB) on slow hardware; tune if probes legitimately time out. */
const PROBE_TIMEOUT_MS = 60_000
/** Max stdout we accept from ffprobe. Normal JSON output is <1MB even for
 *  exotic files; 10MB is a generous ceiling that still bounds memory. Node
 *  throws ENOBUFS past this, which the caller's .catch() handles like any
 *  other probe failure. */
const PROBE_MAX_BUFFER = 10 * 1024 * 1024

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

// ffprobe JSON shape — minimal subset we read. Defensive: every field optional
// + verified at use site. See `ffprobe -print_format json -show_streams`.
interface FfprobeSideData { side_data_type?: string; dv_profile?: number }
interface FfprobeDisposition { default?: number; forced?: number }
interface FfprobeTags { language?: string; title?: string }
interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  bit_rate?: string
  channels?: number
  color_transfer?: string
  side_data_list?: FfprobeSideData[]
  disposition?: FfprobeDisposition
  tags?: FfprobeTags
}
interface FfprobeFormat { duration?: string; bit_rate?: string; format_name?: string }
interface FfprobeJson { streams?: FfprobeStream[]; format?: FfprobeFormat }

const SIDE_DATA = {
  DOVI: 'DOVI configuration record',
  HDR10: 'Mastering display metadata',
  HDR10PLUS: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)',
} as const

function findSideData(stream: FfprobeStream | undefined, type: string): FfprobeSideData | undefined {
  return stream?.side_data_list?.find(s => s.side_data_type === type)
}

export function parseProbeOutput(stdout: string): ProbeResult {
  let data: FfprobeJson
  try {
    data = JSON.parse(stdout) as FfprobeJson
  } catch (e) {
    // Malformed / truncated ffprobe output (e.g. hit maxBuffer, or ffprobe
    // emitted garbage). Log the specific failure for debugging, then re-throw
    // so the caller's .catch() still increments the failed count.
    console.error(`Failed to parse ffprobe output: ${e instanceof Error ? e.message : String(e)}`)
    throw e
  }
  const streams = data.streams ?? []
  const format = data.format ?? {}

  const video = streams.find(s => s.codec_type === 'video')
  const audioStreams = streams.filter(s => s.codec_type === 'audio')
  const subStreams = streams.filter(s => s.codec_type === 'subtitle')

  const dvData = findSideData(video, SIDE_DATA.DOVI)
  const hdr10Data = findSideData(video, SIDE_DATA.HDR10)
  const hdr10plusData = findSideData(video, SIDE_DATA.HDR10PLUS)

  return {
    duration: parseFloat(format.duration ?? '0') || 0,
    resolution: `${video?.width ?? 0}x${video?.height ?? 0}`,
    videoCodec: video?.codec_name ?? 'unknown',
    videoBitrate: parseInt(video?.bit_rate ?? format.bit_rate ?? '0', 10) || 0,
    hdr: {
      dv: !!dvData,
      dvProfile: dvData?.dv_profile,
      hdr10: !!hdr10Data || video?.color_transfer === 'smpte2084',
      hdr10plus: !!hdr10plusData,
    },
    audioTracks: audioStreams.map((s, i) => ({
      index: i,
      codec: s.codec_name ?? 'unknown',
      channels: s.channels ?? 2,
      language: s.tags?.language ?? 'und',
      title: s.tags?.title ?? '',
      default: s.disposition?.default === 1,
    })),
    subtitleTracks: subStreams.map((s, i) => ({
      index: i,
      codec: s.codec_name ?? 'unknown',
      language: s.tags?.language ?? 'und',
      forced: s.disposition?.forced === 1,
      embeddable: TEXT_SUB_CODECS.has(s.codec_name ?? ''),
    })),
    container: format.format_name ?? 'unknown',
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
  ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER })

  const result = parseProbeOutput(stdout)
  await writeCache(cacheDir, key, result)
  return result
}
