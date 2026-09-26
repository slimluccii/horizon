import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseProbeOutput } from './probe.ts'

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
  chapters: [
    { id: 0, start_time: '0.000000', end_time: '51.000000', tags: { title: 'Scene 1' } },
    { id: 1, start_time: '51.000000', end_time: '96.500000', tags: { title: 'Intro' } },
    { id: 2, start_time: '96.500000', end_time: '1204.000000' },
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

describe('parseProbeOutput — chapters', () => {
  it('extracts chapters in seconds, with an empty title when the chapter has none', () => {
    expect(parseProbeOutput(FAKE_PROBE_OUTPUT).chapters).toEqual([
      { title: 'Scene 1', startSec: 0, endSec: 51 },
      { title: 'Intro', startSec: 51, endSec: 96.5 },
      { title: '', startSec: 96.5, endSec: 1204 },
    ])
  })

  it('has no chapters when ffprobe reports none', () => {
    const out = JSON.parse(FAKE_PROBE_OUTPUT)
    delete out.chapters
    expect(parseProbeOutput(JSON.stringify(out)).chapters).toEqual([])
  })
})

describe('parseProbeOutput — malformed input (#72)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('logs and re-throws on a JSON parse error', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Truncated / non-JSON output (e.g. ffprobe hit maxBuffer mid-write).
    expect(() => parseProbeOutput('{ not valid json')).toThrow()
    const logged = errSpy.mock.calls.some(c => String(c[0]).includes('Failed to parse ffprobe output'))
    expect(logged).toBe(true)
  })
})
