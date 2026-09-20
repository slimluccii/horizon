/**
 * Profile ladder — the menu of encode targets that PlaybackPlan picks from.
 * Selection logic lives in `transcode/plan.ts`; this module is data + the
 * shared `Profile` type.
 */

export interface Profile {
  name: string
  videoBitrate: number
  audioBitrate: number
  width: number
  height: number
  /** H.264 level for the encoder (`-level:v`). Must actually permit the
   *  profile's resolution at up to 60 fps — Level 4.0 tops out at 1080p30,
   *  so 4K needs 5.2 and 1080p needs 4.2 or decoders may reject the stream. */
  h264Level: string
}

export const PROFILES: Profile[] = [
  { name: '4k',      videoBitrate: 40000, audioBitrate: 256, width: 3840, height: 2160, h264Level: '5.2' },
  { name: '1080p-hi',videoBitrate: 20000, audioBitrate: 256, width: 1920, height: 1080, h264Level: '4.2' },
  { name: '1080p',   videoBitrate: 8000,  audioBitrate: 192, width: 1920, height: 1080, h264Level: '4.2' },
  { name: '720p',    videoBitrate: 4000,  audioBitrate: 128, width: 1280, height: 720,  h264Level: '4.0' },
  { name: '480p',    videoBitrate: 2000,  audioBitrate: 96,  width: 854,  height: 480,  h264Level: '3.1' },
]

/** RFC 6381 codec string for H.264 High profile at the given level, e.g.
 *  '4.0' → `avc1.640028` (0x64 = High, 0x00 = no constraints, 0x28 = 40). */
export function h264CodecString(level: string): string {
  const lvl = Math.round(parseFloat(level) * 10)
  return `avc1.6400${lvl.toString(16).toUpperCase().padStart(2, '0')}`
}
