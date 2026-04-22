// app/src/components/QualityOverlay.tsx
import type { PlaybackMethod, QualityProfile } from '@horizon/sdk'

interface QualityLogEntry {
  profile: QualityProfile
  reason: string
  time: Date
}

interface Props {
  method: PlaybackMethod
  profile: QualityProfile | null
  bufferSeconds: number
  qualityLog: QualityLogEntry[]
}

const METHOD_COLORS: Record<PlaybackMethod, string> = {
  'direct-play': '#22c55e',
  'direct-stream': '#3b82f6',
  'partial-transcode': '#f59e0b',
  'transcode': '#ef4444',
}

const METHOD_LABELS: Record<PlaybackMethod, string> = {
  'direct-play': 'DIRECT PLAY',
  'direct-stream': 'DIRECT STREAM',
  'partial-transcode': 'PARTIAL TRANSCODE',
  'transcode': 'TRANSCODE',
}

export default function QualityOverlay({ method, profile, bufferSeconds, qualityLog }: Props) {
  const bufferPct = Math.min(100, (bufferSeconds / 30) * 100)

  return (
    <div style={{
      position: 'absolute', top: 16, right: 16, background: 'rgba(0,0,0,0.8)',
      borderRadius: 8, padding: '10px 14px', minWidth: 220, fontSize: 12,
      display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none',
    }}>
      {/* Method badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: METHOD_COLORS[method] ?? '#888',
        }} />
        <span style={{ fontWeight: 700, letterSpacing: 0.5 }}>{METHOD_LABELS[method]}</span>
      </div>

      {/* Quality */}
      {profile && (
        <div style={{ color: '#ccc' }}>
          {profile.height ? `${profile.height}p` : '—'} · {Math.round(profile.videoBitrate / 1000)} Mbps
        </div>
      )}

      {/* Buffer bar */}
      <div>
        <div style={{ color: '#666', marginBottom: 3 }}>
          Buffer: {bufferSeconds.toFixed(1)}s
        </div>
        <div style={{ height: 4, background: '#333', borderRadius: 2 }}>
          <div style={{
            height: '100%', borderRadius: 2,
            width: `${bufferPct}%`,
            background: bufferSeconds < 4 ? '#ef4444' : bufferSeconds < 8 ? '#f59e0b' : '#22c55e',
            transition: 'width 0.5s',
          }} />
        </div>
      </div>

      {/* Quality log */}
      {qualityLog.length > 0 && (
        <div style={{ borderTop: '1px solid #333', paddingTop: 8 }}>
          <div style={{ color: '#666', marginBottom: 4 }}>Recent switches</div>
          {qualityLog.slice(-5).reverse().map((entry, i) => (
            <div key={i} style={{ color: '#aaa', fontSize: 11, lineHeight: 1.6 }}>
              {entry.time.toLocaleTimeString()} — {entry.profile.height}p ({entry.reason})
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
