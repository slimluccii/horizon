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

const METHOD_LABELS: Record<PlaybackMethod, string> = {
  'direct-play':      'Direct play',
  'direct-stream':    'Direct stream',
  'partial-transcode':'Partial transcode',
  'transcode':        'Transcode',
}

/** Live playback telemetry shown alongside the player. */
export default function QualityOverlay({ method, profile, bufferSeconds, qualityLog }: Props) {
  return (
    <aside aria-label="Playback telemetry">
      <p>{METHOD_LABELS[method]}</p>

      {profile && (
        <p>
          {profile.height ? `${profile.height}p` : '—'}
          {' · '}
          {Math.round(profile.videoBitrate / 1000)} Mbps
        </p>
      )}

      <p>Buffer: {bufferSeconds.toFixed(1)}s</p>

      {qualityLog.length > 0 && (
        <section aria-label="Recent quality switches">
          <p>Recent switches</p>
          <ul>
            {qualityLog.slice(-3).reverse().map((entry) => (
              <li key={`${entry.time.getTime()}-${entry.reason}`}>
                <span>{entry.time.toLocaleTimeString()}</span>
                {' — '}
                <span>{entry.profile.height}p</span>
                {' ('}
                <span>{entry.reason}</span>
                {')'}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}
