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
