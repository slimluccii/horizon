import { useEffect, useState } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { ScanStatusResponse } from '@horizon/sdk'
import { useActivityStream } from '../hooks/useActivityStream.ts'
import ActivityLogPanel from './ActivityLogPanel.tsx'

/** Compact "x ago" for the last-scan line. */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * Discreet scan/metadata status indicator for the admin Server tab only — it
 * lives inside Settings → Server, which is owner/admin-gated, so regular users
 * never see it. Polls /library/scan-status every 5s while mounted; shows a
 * pulsing "Scanning…" chip when a scan or metadata refresh is running, else an
 * idle line with the last-scan summary. Includes a manual "Rescan now" button.
 */
export default function ScanStatusBadge({ onToast }: { onToast: (msg: string) => void }) {
  const [status, setStatus] = useState<ScanStatusResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const activity = useActivityStream(true)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const s = await horizon.library.scanStatus()
        if (alive) setStatus(s)
      } catch { /* transient — keep last known */ }
    }
    void poll()
    const id = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  async function rescan() {
    setBusy(true)
    try {
      await horizon.library.rescan()
      onToast('Rescan started.')
      setStatus(await horizon.library.scanStatus())
    } catch {
      onToast('Could not start a rescan.')
    } finally {
      setBusy(false)
    }
  }

  const scanning = !!status?.scan.running
  const refreshing = !!status?.metadata.running
  const active = scanning || refreshing
  const cur = status?.scan.current
  const last = status?.scan.lastResult
  const lastAt = status?.scan.lastFinishedAt

  // Live "scanned X of Y" while a scan runs and totals are known.
  const processed = cur?.processed ?? 0
  const total = cur?.total ?? 0
  const showBar = scanning && total > 0
  const pct = showBar ? Math.min(100, Math.round((processed / total) * 100)) : 0

  let detail: string
  if (scanning) {
    if (total > 0) {
      const where = cur?.scope && cur.scope !== 'full' ? ` · ${cur.scope}` : ''
      detail = `Scanning ${processed} of ${total} items${where}`
    } else {
      detail = 'Scanning library… (discovering files)'
    }
  } else if (refreshing) {
    detail = 'Refreshing metadata…'
  } else if (lastAt && last) {
    detail = `Idle · last scan ${timeAgo(lastAt)} (${last.itemsSeen} items${last.itemsFailed ? `, ${last.itemsFailed} failed` : ''})`
  } else {
    detail = 'Idle · no scan yet'
  }

  return (
    <div>
      <div>
        <span>{detail}</span>
        <button type="button" disabled={busy || active} onClick={rescan}>
          {busy ? 'Starting…' : 'Rescan now'}
        </button>
      </div>
      {showBar && (
        <progress max={total} value={processed} aria-label="Scan progress" />
      )}
      {active && (
        <div>
          <span>Movies: {activity.counts.movies} · Series: {activity.counts.shows}</span>
          {activity.current && (
            <span>
              {' · '}{activity.current.step} — “{activity.current.title}”
              {activity.current.tmdbId ? ` #${activity.current.tmdbId}` : ''}
            </span>
          )}
        </div>
      )}
      <button type="button" onClick={() => setShowLog(v => !v)}>
        {showLog ? 'Hide raw log' : 'Show raw log'}
      </button>
      {showLog && <ActivityLogPanel lines={activity.rawLines} />}
    </div>
  )
}
