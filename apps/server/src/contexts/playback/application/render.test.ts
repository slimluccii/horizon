import { describe, it, expect } from 'vitest'
import { renderArgs, type RenderContext } from './render.ts'
import { keyframeTimeline } from '../domain/timeline.ts'
import type { PlaybackPlan } from '../domain/plan.ts'
import type { HwAccel } from '../domain/hwaccel.ts'

const hwAccel: HwAccel = {
  ffmpegVersion: '6.0', encoder: 'videotoolbox', h264Encoder: 'h264_videotoolbox',
  hevcEncoder: 'hevc_videotoolbox', hwaccelDecode: ['-hwaccel', 'videotoolbox'],
  h264SupportsA53cc: true,
}

const hwAccelWithoutA53cc: HwAccel = { ...hwAccel, h264SupportsA53cc: false }

const ctx: RenderContext = {
  sourceFilePath: '/movies/film.mkv',
  sessionDir: '/tmp/sess1',
  startSegment: 0,
  seekPositionMs: 0,
}

const ctxSeek: RenderContext = { ...ctx, startSegment: 30, seekPositionMs: 30_500 }

const transcodePlan: PlaybackPlan = {
  method: 'transcode',
  needsToneMap: false,
  toneMap: { operator: 'hable', postCorrection: true },
  renditions: [
    { profile: { name: '1080p', videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080, h264Level: '4.2' }, videoCodec: 'avc1.640028' },
    { profile: { name: '720p', videoBitrate: 4000, audioBitrate: 128, width: 1280, height: 720, h264Level: '4.0' },  videoCodec: 'avc1.640028' },
  ],
  audioTrackIndex: 0,
  audioStrategy: 'aac',
  videoStrategy: 'transcode',
  burnInSubtitleIndex: null,
}

const directStreamPlan: PlaybackPlan = {
  ...transcodePlan,
  method: 'direct-stream',
  renditions: [],
  audioStrategy: 'copy',
  videoStrategy: 'copy',
  burnInSubtitleIndex: null,
}

const partialPlan: PlaybackPlan = {
  ...transcodePlan,
  method: 'partial-transcode',
  renditions: [transcodePlan.renditions[1]],
  videoStrategy: 'copy',
  burnInSubtitleIndex: null,
}

const tonemapPlan: PlaybackPlan = {
  method: 'transcode',
  needsToneMap: true,
  toneMap: { operator: 'hable', postCorrection: true },
  renditions: [
    { profile: { name: '720p', videoBitrate: 4000, audioBitrate: 160, width: 1280, height: 720, h264Level: '4.0' }, videoCodec: 'avc1.640028' },
  ],
  audioTrackIndex: 0,
  audioStrategy: 'aac',
  videoStrategy: 'transcode',
  burnInSubtitleIndex: null,
}

const directPlayPlan: PlaybackPlan = {
  method: 'direct-play',
  needsToneMap: false,
  toneMap: { operator: 'hable', postCorrection: true },
  renditions: [],
  audioTrackIndex: 0,
  audioStrategy: 'copy',
  videoStrategy: 'copy',
  burnInSubtitleIndex: null,
}

describe('renderArgs', () => {
  describe('direct-play', () => {
    it('returns empty args + no rendition codecs (no spawn needed)', () => {
      const result = renderArgs(directPlayPlan, ctx, hwAccel)
      expect(result.args).toEqual([])
      expect(result.renditionCodecs).toEqual([])
    })
  })

  describe('transcode', () => {
    it('includes hwaccel decode, input file, filter_complex, var_stream_map', () => {
      const { args, renditionCodecs } = renderArgs(transcodePlan, ctx, hwAccel)
      expect(args).toEqual(expect.arrayContaining(['-hwaccel', 'videotoolbox']))
      expect(args).toEqual(expect.arrayContaining(['-i', '/movies/film.mkv']))
      expect(args).toContain('-filter_complex')
      expect(args).toEqual(expect.arrayContaining(['-var_stream_map', 'v:0,a:0 v:1,a:1']))
      expect(renditionCodecs).toEqual(['avc1.640028', 'avc1.640028'])
    })

    it('uses h264_videotoolbox encoder from hwAccel for every rendition', () => {
      const { args } = renderArgs(transcodePlan, ctx, hwAccel)
      const indices = args.reduce<number[]>((acc, a, i) => (a.startsWith('-c:v:') ? [...acc, i] : acc), [])
      expect(indices).toHaveLength(2)
      for (const i of indices) expect(args[i + 1]).toBe('h264_videotoolbox')
    })

    it('emits -ss + -copyts when ctx has seekPositionMs', () => {
      const { args } = renderArgs(transcodePlan, ctxSeek, hwAccel)
      const ssIdx = args.indexOf('-ss')
      expect(ssIdx).toBeGreaterThanOrEqual(0)
      expect(parseFloat(args[ssIdx + 1])).toBeCloseTo(30.5, 1)
      expect(args).toContain('-copyts')
    })

    it('emits start_number matching ctx.startSegment', () => {
      const { args } = renderArgs(transcodePlan, ctxSeek, hwAccel)
      const idx = args.indexOf('-start_number')
      expect(args[idx + 1]).toBe('30')
    })

    it('pins SDR color tags + 8-bit pix_fmt per rendition', () => {
      const { args } = renderArgs(transcodePlan, ctx, hwAccel)
      expect(args).toEqual(expect.arrayContaining(['-pix_fmt:v:0', 'yuv420p']))
      expect(args).toEqual(expect.arrayContaining(['-color_primaries:v:0', 'bt709']))
      expect(args).toEqual(expect.arrayContaining(['-color_trc:v:1', 'bt709']))
    })

    it('turns off A53 caption embedding per rendition when the encoder takes the option', () => {
      const { args } = renderArgs(transcodePlan, ctx, hwAccel)
      expect(args).toEqual(expect.arrayContaining(['-a53cc:v:0', '0']))
      expect(args).toEqual(expect.arrayContaining(['-a53cc:v:1', '0']))
    })

    it('omits the option entirely on an encoder that does not have it', () => {
      const { args } = renderArgs(transcodePlan, ctx, hwAccelWithoutA53cc)
      expect(args.some(a => a.startsWith('-a53cc'))).toBe(false)
    })
  })

  describe('tonemap', () => {
    it('emits a single filter_complex chain with tonemap prefix for n=1', () => {
      const { args } = renderArgs(tonemapPlan, ctx, hwAccel)
      const idx = args.indexOf('-filter_complex')
      const graph = args[idx + 1]
      expect(graph).toContain('tonemap=hable')
      expect(graph).toContain('scale=1280:720')
      expect(graph).toContain('[sv0]')
      // No split for n=1
      expect(graph).not.toContain('split=')
    })
  })

  describe('direct-stream', () => {
    it('uses copy codecs + no filter graph + no hwaccel decode', () => {
      const { args, renditionCodecs } = renderArgs(directStreamPlan, ctx, hwAccel)
      expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'copy']))
      expect(args).not.toContain('-filter_complex')
      expect(args).not.toContain('-hwaccel')
      expect(renditionCodecs).toEqual([])
    })
  })

  describe('partial-transcode', () => {
    it('copies video + transcodes audio to AAC at the rendition bitrate', () => {
      const { args, renditionCodecs } = renderArgs(partialPlan, ctx, hwAccel)
      expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy']))
      expect(args).toEqual(expect.arrayContaining(['-c:a', 'aac']))
      expect(args).toEqual(expect.arrayContaining(['-b:a', '128k']))
      expect(args).toEqual(expect.arrayContaining(['-hwaccel', 'videotoolbox']))
      expect(renditionCodecs).toEqual([])
    })
  })

  describe('audio track selection', () => {
    it('maps the audio stream named by plan.audioTrackIndex', () => {
      const plan = { ...transcodePlan, audioTrackIndex: 2 }
      const { args } = renderArgs(plan, ctx, hwAccel)
      expect(args).toEqual(expect.arrayContaining(['-map', '0:a:2']))
    })
  })
})

describe('stream copy follows the source keyframes', () => {
  // Timestamps from the irregular B-frame file this was validated against with real ffmpeg.
  const keyframes = [
    { ptsSec: 0, dtsSec: -0.083 }, { ptsSec: 0.5, dtsSec: 0.417 }, { ptsSec: 3.5, dtsSec: 3.417 },
    { ptsSec: 9, dtsSec: 8.917 }, { ptsSec: 9.25, dtsSec: 9.167 }, { ptsSec: 15, dtsSec: 14.917 },
  ]
  const copyCtx = (startSegment: number): RenderContext => ({
    ...ctx, startSegment, seekPositionMs: keyframes[startSegment].ptsSec * 1000, copyTimeline: keyframeTimeline(keyframes, 20),
  })
  const valueAfter = (args: string[], flag: string, from = 0) => args[args.indexOf(flag, from) + 1]

  it('cuts a segment at every keyframe, since that is the only cut that survives a restart', () => {
    const { args } = renderArgs(directStreamPlan, copyCtx(0), hwAccel)
    expect(valueAfter(args, '-hls_time')).toBe('0.001')
  })

  it('keeps source timestamps from the first run, so every run shares one clock', () => {
    const { args } = renderArgs(directStreamPlan, copyCtx(0), hwAccel)
    expect(args).toContain('-copyts')
    expect(args).not.toContain('-ss')
  })

  it('restarts by seeking one keyframe early and trimming to just before the decode time of the wanted one', () => {
    const { args } = renderArgs(directStreamPlan, copyCtx(3), hwAccel)
    const input = args.indexOf('-i')
    expect(args.indexOf('-ss')).toBeLessThan(input)
    expect(valueAfter(args, '-ss')).toBe('3.500')
    expect(valueAfter(args, '-ss', input)).toBe('8.916')
    expect(valueAfter(args, '-start_number')).toBe('3')
  })

  it('does the same when only the audio is transcoded', () => {
    const { args } = renderArgs(partialPlan, copyCtx(4), hwAccel)
    const input = args.indexOf('-i')
    expect(valueAfter(args, '-hls_time')).toBe('0.001')
    expect(valueAfter(args, '-ss')).toBe('9.000')
    expect(valueAfter(args, '-ss', input)).toBe('9.166')
  })

  it('leaves an encode on fixed one-second segments', () => {
    const { args } = renderArgs(transcodePlan, ctxSeek, hwAccel)
    expect(valueAfter(args, '-hls_time')).toBe('1')
    expect(args.filter(a => a === '-ss')).toHaveLength(1)
  })
})
