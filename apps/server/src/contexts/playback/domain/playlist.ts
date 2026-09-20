import type { Profile } from './profiles.ts'
import { segmentName } from './segments.ts'
import type { SegmentTimeline } from './timeline.ts'

/**
 * Build a static VOD-style rendition playlist covering the whole timeline.
 * Segments are listed by their deterministic filename — they may not yet exist
 * on disk; the segment route produces them on demand (restarting ffmpeg if the
 * request lands outside the current run's segment range = seek).
 *
 * `segPathPrefix` is prepended to each `segNNNNN.m4s` URI so the playlist works
 * both standalone (`prefix=""`) and rewritten under a stream.m3u8 wrapper
 * (`prefix="renditions/0/"`). Same applies to the EXT-X-MAP URI.
 */
export function buildRenditionPlaylist(timeline: SegmentTimeline, segPathPrefix = ''): string {
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${timeline.targetDurationSec}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${segPathPrefix}init.mp4"`,
  ]
  for (let i = 0; i < timeline.count; i++) {
    lines.push(`#EXTINF:${timeline.durationSec(i).toFixed(3)},`)
    lines.push(`${segPathPrefix}${segmentName(i)}`)
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

/** Build a HLS master playlist that points at one rendition variant per profile. */
export function buildMasterPlaylist(
  _sessionId: string,
  profiles: Profile[],
  renditionCodecs: string[],
): string {
  // Variant URIs are relative to the master playlist URL. Some clients
  // (AVFoundation) refuse absolute-path variants and fail silently with
  // CoreMediaErrorDomain -12927 — hls.js and ffplay accept either.
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '']
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]
    const bw = (p.videoBitrate + p.audioBitrate) * 1000
    // Deliberately NOT emitting CODECS: h264_videotoolbox writes an avcC box
    // without a valid profile/level in some builds, so AVFoundation fails
    // strict CODECS validation (`avc1.640028` declared but init.mp4 reports
    // profile=unknown) with CoreMediaErrorDomain -12927. Letting the player
    // probe the init segment is slower but correct on every client.
    void renditionCodecs
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${p.width}x${p.height}`)
    lines.push(`renditions/${i}.m3u8`)
  }
  return lines.join('\n')
}
