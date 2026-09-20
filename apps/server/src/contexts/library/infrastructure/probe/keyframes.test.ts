import { describe, it, expect } from 'vitest'
import { parseKeyframes } from './keyframes.ts'

describe('parseKeyframes', () => {
  it('keeps the keyframe packets of an ffprobe packet listing, with both timestamps', () => {
    const csv = [
      '0.000000,-0.083000,K__',
      '0.166000,-0.042000,___',
      '0.083000,0.000000,___',
      '0.500000,0.417000,K__',
      '9.000000,8.917000,K_D',
    ].join('\n')
    expect(parseKeyframes(csv)).toEqual([
      { ptsSec: 0, dtsSec: -0.083 },
      { ptsSec: 0.5, dtsSec: 0.417 },
      { ptsSec: 9, dtsSec: 8.917 },
    ])
  })

  it('uses the presentation time where a container gives no decode time', () => {
    expect(parseKeyframes('0.000000,N/A,K__\n2.000000,N/A,K__')).toEqual([
      { ptsSec: 0, dtsSec: 0 },
      { ptsSec: 2, dtsSec: 2 },
    ])
  })

  it('returns them in presentation order and skips lines it cannot read', () => {
    const csv = '4.000000,3.900000,K__\nnot a packet\n,,K__\n2.000000,1.900000,K__\n'
    expect(parseKeyframes(csv).map(k => k.ptsSec)).toEqual([2, 4])
  })
})
