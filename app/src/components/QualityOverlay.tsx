import type { PlaybackMethod, QualityProfile } from '@horizon/sdk'
import './QualityOverlay.css'

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
  'direct-play':      'var(--good)',
  'direct-stream':    'var(--accent)',
  'partial-transcode':'var(--popcorn)',
  'transcode':        'var(--danger)',
}

const METHOD_LABELS: Record<PlaybackMethod, string> = {
  'direct-play':      'Direct play',
  'direct-stream':    'Direct stream',
  'partial-transcode':'Partial transcode',
  'transcode':        'Transcode',
}

/** Small floating chip top-right of the player — live playback telemetry.
 *  Click-through is on the quality log expansion; otherwise informational. */
export default function QualityOverlay({ method, profile, bufferSeconds, qualityLog }: Props) {
  const bufferPct = Math.min(100, (bufferSeconds / 30) * 100)
  const bufferColor =
    bufferSeconds < 4 ? 'var(--danger)'
    : bufferSeconds < 8 ? 'var(--popcorn)'
    : 'var(--good)'

  return (
    <div className="qo">
      <div className="qo__method">
        <span className="qo__dot" style={{ background: METHOD_COLORS[method] }} />
        <span className="qo__label">{METHOD_LABELS[method]}</span>
      </div>

      {profile && (
        <div className="qo__profile">
          {profile.height ? `${profile.height}p` : '—'}
          <span className="qo__dot-sep">·</span>
          {Math.round(profile.videoBitrate / 1000)} Mbps
        </div>
      )}

      <div className="qo__buffer">
        <div className="qo__buffer-head">
          <span>Buffer</span>
          <span className="qo__buffer-val">{bufferSeconds.toFixed(1)}s</span>
        </div>
        <div className="qo__buffer-track">
          <div className="qo__buffer-fill" style={{ width: `${bufferPct}%`, background: bufferColor }} />
        </div>
      </div>

      {qualityLog.length > 0 && (
        <div className="qo__log">
          <div className="qo__log-title">Recent switches</div>
          {qualityLog.slice(-3).reverse().map((entry, i) => (
            <div key={i} className="qo__log-item">
              <span className="qo__log-time">{entry.time.toLocaleTimeString()}</span>
              <span className="qo__log-profile">{entry.profile.height}p</span>
              <span className="qo__log-reason">{entry.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
