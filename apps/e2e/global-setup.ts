import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/**
 * E2E global setup.
 *
 * 1. The first-boot wizard requires an EMPTY household, so wipe the dedicated
 *    e2e SQLite DB + cache before the run.
 * 2. Generate a tiny synthetic HEVC/AAC clip so the PLAYBACK specs exercise the
 *    real transcode pipeline (ffprobe scan → ffmpeg HEVC→H.264 transcode →
 *    playlist → HLS segments) against a real file — no mocking. HEVC (not H.264)
 *    so an h264-only browser client forces a full transcode rather than
 *    direct-play; the server transcodes it to H.264 the test browser can decode.
 *    ~30s, 320x240, libx265/aac, named for the scanner's `Title (YYYY)` regex.
 *    30s (not 3s) so the specs can seek forward + assert currentTime advances
 *    over a multi-second window without hitting the end.
 *
 * Paths are shared with playwright.config (it mirrors this layout).
 */
export const E2E_DIR = path.join(os.tmpdir(), 'horizon-e2e')
export const E2E_DB = path.join(E2E_DIR, 'horizon.db')
export const E2E_CACHE = path.join(E2E_DIR, 'cache')
export const E2E_MEDIA = path.join(E2E_DIR, 'media')
export const E2E_MOVIES = path.join(E2E_MEDIA, 'Movies')
export const E2E_SHOWS = path.join(E2E_MEDIA, 'Shows')

/** Title the playback spec looks for (matches the scanner's `Title (YYYY)`). */
export const E2E_MOVIE_TITLE = 'Test Movie'
export const E2E_MOVIE_FILE = path.join(E2E_MOVIES, 'Test Movie (2024)', 'Test Movie (2024).mp4')

/** True when a playable fixture exists (ffmpeg was available to generate it). */
export function hasPlayableFixture(): boolean {
  return existsSync(E2E_MOVIE_FILE)
}

export default function globalSetup(): void {
  // Nuke the whole e2e dir so DB + WAL/SHM + cache all reset together.
  rmSync(E2E_DIR, { recursive: true, force: true })
  mkdirSync(E2E_CACHE, { recursive: true })
  mkdirSync(E2E_MOVIES, { recursive: true })
  mkdirSync(E2E_SHOWS, { recursive: true })

  // Synthetic clip for the playback specs. Best-effort: if ffmpeg isn't on PATH
  // the file won't exist and the playback specs skip themselves (see
  // hasPlayableFixture). Everything else (auth, library scenarios, profiles)
  // runs regardless.
  mkdirSync(path.dirname(E2E_MOVIE_FILE), { recursive: true })
  try {
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
      // HEVC video so an h264-only client forces a full transcode (not direct-play).
      // Keyframe every 15 frames (1s @ 15fps) + exact 30s so the server's static
      // VOD playlist (ceil(duration / 1s) segments) matches what ffmpeg emits —
      // otherwise the final segment 404s and hls.js stalls at the end.
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
      '-g', '15', '-keyint_min', '15',
      '-c:a', 'aac', '-t', '30', '-shortest',
      E2E_MOVIE_FILE,
    ], { stdio: 'ignore' })
  } catch {
    // ffmpeg missing or failed — playback specs will skip. Log for visibility.
    console.warn('[e2e] ffmpeg unavailable — playback specs will be skipped')
  }
}
