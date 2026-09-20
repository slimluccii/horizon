import { useEffect, useState } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { ActiveSessionSummary } from '@horizon/sdk'

const POLL_MS = 5000

const METHOD_LABELS: Record<string, string> = {
  'direct-play': 'Direct play',
  'direct-stream': 'Direct stream',
  'partial-transcode': 'Partial transcode',
  'transcode': 'Transcode',
}

function fmtPosition(positionMs: number | null, durationMs: number | null): string {
  if (positionMs == null) return '—'
  const fmt = (ms: number) => {
    const total = Math.floor(ms / 1000)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
  }
  return durationMs ? `${fmt(positionMs)} / ${fmt(durationMs)}` : fmt(positionMs)
}

/** Server tab (owner/admin): live view of who is streaming what and how.
 *  Transcodes are the expensive rows — this is where a pegged CPU gets
 *  explained. Polls while mounted. */
export default function NowPlayingPanel() {
  const [rows, setRows] = useState<ActiveSessionSummary[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      horizon.sessions.listActive()
        .then(list => { if (!cancelled) { setRows(list); setLoaded(true) } })
        .catch(() => { if (!cancelled) setLoaded(true) })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  return (
    <section aria-label="Now playing">
      <h3>Now playing</h3>
      {!loaded && <p>Loading sessions…</p>}
      {loaded && rows.length === 0 && <p>Nothing is streaming right now.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">Title</th>
              <th scope="col">Method</th>
              <th scope="col">Quality</th>
              <th scope="col">Position</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id}>
                <td>{row.userName ?? 'Unknown'}</td>
                <td>{row.mediaTitle ?? row.mediaId}</td>
                <td>{METHOD_LABELS[row.method] ?? row.method}</td>
                <td>{row.profile ?? 'Original'}</td>
                <td>{fmtPosition(row.positionMs, row.durationMs)}</td>
                <td>{row.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
