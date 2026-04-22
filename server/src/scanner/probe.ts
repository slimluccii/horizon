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
