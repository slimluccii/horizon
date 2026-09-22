import { describe, it, expect } from 'vitest'
import { renderArgs, type RenderContext } from './render.ts'
import type { PlaybackPlan } from '../domain/plan.ts'
import type { HwAccel } from '../domain/hwaccel.ts'

const hwAccel: HwAccel = {
  ffmpegVersion: 'x', encoder: 'cpu', h264Encoder: 'libx264', hevcEncoder: 'libx265', hwaccelDecode: [],
  h264SupportsA53cc: true,
}

const ctx: RenderContext = {
  sourceFilePath: '/media/movie.mkv',
  sessionDir: '/cache/sessions/s1',
  startSegment: 0,
  seekPositionMs: 0,
}

function transcodePlan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    method: 'transcode',
    needsToneMap: false,
    toneMap: { operator: 'hable', postCorrection: true },
    renditions: [
      { profile: { name: '1080p', videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080, h264Level: '4.2' }, videoCodec: 'avc1.64002A' },
      { profile: { name: '720p', videoBitrate: 4000, audioBitrate: 128, width: 1280, height: 720, h264Level: '4.0' }, videoCodec: 'avc1.640028' },
    ],
    audioTrackIndex: 0,
    audioStrategy: 'aac',
    videoStrategy: 'transcode',
    burnInSubtitleIndex: null,
    ...overrides,
  }
}

function filterGraphOf(args: string[]): string {
  const i = args.indexOf('-filter_complex')
  expect(i).toBeGreaterThan(-1)
  return args[i + 1]
}

describe('renderArgs burn-in filter graph', () => {
  it('composites the subtitle stream before split/scale (happy path)', () => {
    const { args } = renderArgs(transcodePlan({ burnInSubtitleIndex: 1 }), ctx, hwAccel)
    const graph = filterGraphOf(args)
    expect(graph).toContain('[0:v][0:s:1]overlay[burned];')
    expect(graph).toContain('[burned]split=2')
  })

  it('burn-in + tonemap: overlay first, tonemap applied downstream', () => {
    const plan = transcodePlan({
      burnInSubtitleIndex: 0,
      needsToneMap: true,
      renditions: [transcodePlan().renditions[0]],
    })
    const { args } = renderArgs(plan, ctx, hwAccel)
    const graph = filterGraphOf(args)
    expect(graph).toContain('[0:v][0:s:0]overlay[burned];[burned]')
    expect(graph).toContain('tonemap')
  })

  it('no burn-in leaves the graph untouched (edge path)', () => {
    const { args } = renderArgs(transcodePlan(), ctx, hwAccel)
    const graph = filterGraphOf(args)
    expect(graph).not.toContain('overlay')
    expect(graph).toContain('[0:v]split=2')
  })
})
