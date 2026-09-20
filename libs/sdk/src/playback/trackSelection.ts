/**
 * Initial track selection — maps a user's stored preferences (default audio
 * language, default subtitles) onto a media item's actual track lists at
 * session-create time. Pure; shared by every client.
 */
import type { MediaItem } from '../library/mediaItem.ts'
import { trackMatchesLanguage, type Preferences } from '../identity/preferences.ts'
import type { SubtitleTrack } from './session.ts'

export interface InitialTracks {
  audioTrackIndex: number
  subtitleTrackIndex: number | null
}

/** Image-based subtitle track (PGS/VobSub): rendered by server-side burn-in. */
export function isImageSubtitle(t: SubtitleTrack): boolean {
  return !t.embeddable && !t.external
}

export function pickInitialTracks(media: MediaItem, prefs: Preferences | undefined): InitialTracks {
  let audioTrackIndex = 0
  if (prefs?.audioLanguage) {
    const match = media.audioTracks.find(t => trackMatchesLanguage(t.language, prefs.audioLanguage!))
    if (match) audioTrackIndex = match.index
  }

  let subtitleTrackIndex: number | null = null
  if (prefs?.subtitlesEnabled) {
    const candidates = prefs.subtitleLanguage
      ? media.subtitleTracks.filter(t => trackMatchesLanguage(t.language, prefs.subtitleLanguage!))
      : media.subtitleTracks
    // Prefer a full track over a forced-only one, and text over image —
    // an image sub forces the burn-in transcode path.
    const pick =
      candidates.find(t => t.embeddable && !t.forced) ??
      candidates.find(t => !t.forced) ??
      candidates[0]
    if (pick) subtitleTrackIndex = pick.index
  }
  return { audioTrackIndex, subtitleTrackIndex }
}
