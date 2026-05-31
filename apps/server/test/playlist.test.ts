import { describe, it, expect } from 'vitest'
import { buildRenditionPlaylist, buildMasterPlaylist } from '../src/transcode/playlist.ts'
import type { Profile } from '../src/transcode/profiles.ts'

describe('buildRenditionPlaylist', () => {
  it('emits VOD playlist with EXTM3U + ENDLIST', () => {
    const pl = buildRenditionPlaylist(8)
    expect(pl).toContain('#EXTM3U')
    expect(pl).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(pl).toContain('#EXT-X-ENDLIST')
  })

  it('lists every segment for the duration', () => {
    // 3s @ 1s/seg = 3 segs
    const pl = buildRenditionPlaylist(3)
    const segs = pl.split('\n').filter(l => l.endsWith('.m4s'))
    expect(segs).toHaveLength(3)
    expect(segs[0]).toBe('seg00000.m4s')
    expect(segs[2]).toBe('seg00002.m4s')
  })

  it('rounds up partial last segment', () => {
    // 2.5s @ 1s/seg = 2 full + 1 partial
    const pl = buildRenditionPlaylist(2.5)
    const segs = pl.split('\n').filter(l => l.endsWith('.m4s'))
    expect(segs).toHaveLength(3)
  })

  it('honours segment path prefix in segment URIs and EXT-X-MAP', () => {
    const pl = buildRenditionPlaylist(4, 'renditions/0/')
    expect(pl).toContain('#EXT-X-MAP:URI="renditions/0/init.mp4"')
    expect(pl).toContain('renditions/0/seg00000.m4s')
  })

  it('emits at least one segment for tiny durations', () => {
    const pl = buildRenditionPlaylist(0.5)
    const segs = pl.split('\n').filter(l => l.endsWith('.m4s'))
    expect(segs).toHaveLength(1)
  })
})

describe('buildMasterPlaylist', () => {
  const profiles: Profile[] = [
    { name: '1080p', videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080 },
    { name: '720p',  videoBitrate: 4000, audioBitrate: 128, width: 1280, height: 720 },
  ]

  it('emits one STREAM-INF per profile', () => {
    const pl = buildMasterPlaylist('sess1', profiles, ['avc1.640028', 'avc1.640028'])
    const streamLines = pl.split('\n').filter(l => l.startsWith('#EXT-X-STREAM-INF'))
    expect(streamLines).toHaveLength(2)
    expect(streamLines[0]).toContain('RESOLUTION=1920x1080')
    expect(streamLines[1]).toContain('RESOLUTION=1280x720')
  })

  // Master playlist deliberately omits CODECS — h264_videotoolbox writes an
  // avcC box without a valid profile/level in some builds, so AVFoundation's
  // strict CODECS validation fails with CoreMediaErrorDomain -12927. Letting
  // the player probe the init segment is slower but correct on every client.
  // See the comment in buildMasterPlaylist. Do not re-add a CODECS assertion.
  it('omits CODECS so clients probe the init segment', () => {
    const pl = buildMasterPlaylist('sess1', profiles, [])
    expect(pl).not.toContain('CODECS')
    // renditionCodecs is intentionally unused; passing it changes nothing.
    const withCodecs = buildMasterPlaylist('sess1', profiles, ['avc1.640028', 'avc1.640028'])
    expect(withCodecs).not.toContain('CODECS')
  })

  // Variant URIs are RELATIVE to the master playlist URL — AVFoundation refuses
  // absolute-path variants and fails silently (CoreMediaErrorDomain -12927).
  it('points URIs at relative rendition playlist endpoints', () => {
    const pl = buildMasterPlaylist('sess1', profiles, ['avc1.640028', 'avc1.640028'])
    expect(pl).toContain('renditions/0.m3u8')
    expect(pl).toContain('renditions/1.m3u8')
    // Must NOT be absolute / session-prefixed.
    expect(pl).not.toContain('/sessions/')
  })
})
