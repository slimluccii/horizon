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
}

export const PROFILES: Profile[] = [
  { name: '4k',      videoBitrate: 40000, audioBitrate: 256, width: 3840, height: 2160 },
  { name: '1080p-hi',videoBitrate: 20000, audioBitrate: 256, width: 1920, height: 1080 },
  { name: '1080p',   videoBitrate: 8000,  audioBitrate: 192, width: 1920, height: 1080 },
  { name: '720p',    videoBitrate: 4000,  audioBitrate: 128, width: 1280, height: 720  },
  { name: '480p',    videoBitrate: 2000,  audioBitrate: 96,  width: 854,  height: 480  },
]
