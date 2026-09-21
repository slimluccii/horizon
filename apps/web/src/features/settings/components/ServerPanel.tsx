import { useEffect, useState } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { ServerSettings } from '@horizon/sdk'

const ACTIVE_KNOBS: Array<keyof ServerSettings> = ['scanCronHour', 'scanConcurrency', 'watchFs', 'watchDebounceMs']

function activeKnobLabel(patch: Partial<ServerSettings>): string | null {
  if (patch.watchFs !== undefined || patch.watchDebounceMs !== undefined) {
    return 'Library settings updated. Watcher restarted.'
  }
  if (patch.scanCronHour !== undefined || patch.scanConcurrency !== undefined) {
    return 'Library settings updated. Scheduler updated.'
  }
  return null
}

type LibraryForm = {
  watchedThresholdPct: number
  scanCronHour: number
  scanConcurrency: number
  watchFs: boolean
  watchDebounceMs: number
}

type MetadataForm = {
  metadataBatchSize: number
  metadataMaxAgeMovieDays: number
  metadataMaxAgeShowDays: number
  metadataMaxAgeEpDays: number
}

type PlaybackForm = {
  maxSessions: number
  maxRenditions: number
  wsGraceMs: number
  wsAttachMs: number
  forceEncoder: string
  tonemapOperator: string
  tonemapParam: string      // stored as string so the input can be empty for null
  tonemapDesat: string
}

const TONEMAP_OPERATORS = [
  'hable', 'mobius', 'reinhard', 'gamma', 'clip', 'linear', 'none',
] as const

export default function ServerPanel({ onSave }: { onSave: (msg: string) => void }) {
  const [initialLib, setInitialLib] = useState<LibraryForm | null>(null)
  const [form, setForm] = useState<LibraryForm | null>(null)
  const [initialMeta, setInitialMeta] = useState<MetadataForm | null>(null)
  const [metaForm, setMetaForm] = useState<MetadataForm | null>(null)
  // tmdbToken state: what the server last reported, pending new value
  const [tmdbStatus, setTmdbStatus] = useState<'set' | 'unset'>('unset')
  const [showTokenInput, setShowTokenInput] = useState(false)
  const [pendingToken, setPendingToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [playbackInitial, setPlaybackInitial] = useState<PlaybackForm | null>(null)
  const [playbackForm, setPlaybackForm] = useState<PlaybackForm | null>(null)
  const [playbackBusy, setPlaybackBusy] = useState(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [detectedEncoder, setDetectedEncoder] = useState<string | null>(null)

  useEffect(() => {
    horizon.settings.getServer().then(s => {
      const f: LibraryForm = {
        watchedThresholdPct: s.watchedThresholdPct,
        scanCronHour: s.scanCronHour,
        scanConcurrency: s.scanConcurrency,
        watchFs: s.watchFs,
        watchDebounceMs: s.watchDebounceMs,
      }
      setInitialLib(f)
      setForm(f)

      const m: MetadataForm = {
        metadataBatchSize: s.metadataBatchSize,
        metadataMaxAgeMovieDays: s.metadataMaxAgeMovieDays,
        metadataMaxAgeShowDays: s.metadataMaxAgeShowDays,
        metadataMaxAgeEpDays: s.metadataMaxAgeEpDays,
      }
      setInitialMeta(m)
      setMetaForm(m)
      setTmdbStatus(s.tmdbToken)

      const pf: PlaybackForm = {
        maxSessions: s.maxSessions,
        maxRenditions: s.maxRenditions,
        wsGraceMs: s.wsGraceMs,
        wsAttachMs: s.wsAttachMs,
        forceEncoder: s.forceEncoder ?? '',
        tonemapOperator: s.tonemapOperator,
        tonemapParam: s.tonemapParam != null ? String(s.tonemapParam) : '',
        tonemapDesat: s.tonemapDesat != null ? String(s.tonemapDesat) : '',
      }
      setPlaybackInitial(pf)
      setPlaybackForm(pf)
    }).catch(() => setError('Failed to load server settings.'))

    fetch('/api/health').then(r => r.json()).then((h: { hwAccel?: string }) => {
      if (h.hwAccel) setDetectedEncoder(h.hwAccel)
    }).catch(() => {/* non-critical */})
  }, [])

  if (!form || !initialLib || !metaForm || !initialMeta) {
    return error
      ? <p>{error}</p>
      : <p>Loading…</p>
  }

  function set<K extends keyof LibraryForm>(key: K, value: LibraryForm[K]) {
    setForm(f => f ? { ...f, [key]: value } : f)
  }

  function setMeta<K extends keyof MetadataForm>(key: K, value: MetadataForm[K]) {
    setMetaForm(f => f ? { ...f, [key]: value } : f)
  }

  function setPlayback<K extends keyof PlaybackForm>(key: K, value: PlaybackForm[K]) {
    setPlaybackForm(f => f ? { ...f, [key]: value } : f)
  }

  const libDiff = Object.fromEntries(
    Object.entries(form).filter(([k, v]) => v !== initialLib![k as keyof LibraryForm])
  ) as Partial<LibraryForm>

  const metaDiff = Object.fromEntries(
    Object.entries(metaForm).filter(([k, v]) => v !== initialMeta![k as keyof MetadataForm])
  ) as Partial<MetadataForm>

  const hasTokenChange = showTokenInput && (pendingToken !== '' || tmdbStatus === 'set')
  const canSave = (Object.keys(libDiff).length > 0 || Object.keys(metaDiff).length > 0 || hasTokenChange) && !busy

  async function handleSave() {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const patch: Record<string, unknown> = { ...libDiff, ...metaDiff }
      if (showTokenInput) {
        // Empty string normalises to null server-side (clears the token).
        patch.tmdbToken = pendingToken
      }
      const updated = await horizon.settings.patchServer(patch)
      setInitialLib({ ...form! })
      setInitialMeta({ ...metaForm! })
      setTmdbStatus(updated.tmdbToken)
      setShowTokenInput(false)
      setPendingToken('')
      const hasActive = (Object.keys(libDiff) as Array<keyof LibraryForm>).some(k =>
        (ACTIVE_KNOBS as string[]).includes(k)
      )
      if (showTokenInput) {
        onSave(updated.tmdbToken === 'set' ? 'TMDB token saved.' : 'TMDB token cleared.')
      } else {
        const msg = activeKnobLabel(libDiff) ?? 'Settings updated.'
        onSave(hasActive ? msg : 'Settings updated.')
      }
    } catch {
      setError('Failed to save settings. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const playbackDiff: Record<string, unknown> = {}
  if (playbackForm && playbackInitial) {
    if (playbackForm.maxSessions !== playbackInitial.maxSessions) playbackDiff.maxSessions = playbackForm.maxSessions
    if (playbackForm.maxRenditions !== playbackInitial.maxRenditions) playbackDiff.maxRenditions = playbackForm.maxRenditions
    if (playbackForm.wsGraceMs !== playbackInitial.wsGraceMs) playbackDiff.wsGraceMs = playbackForm.wsGraceMs
    if (playbackForm.wsAttachMs !== playbackInitial.wsAttachMs) playbackDiff.wsAttachMs = playbackForm.wsAttachMs
    if (playbackForm.forceEncoder !== playbackInitial.forceEncoder) {
      playbackDiff.forceEncoder = playbackForm.forceEncoder === '' ? null : playbackForm.forceEncoder
    }
    if (playbackForm.tonemapOperator !== playbackInitial.tonemapOperator) playbackDiff.tonemapOperator = playbackForm.tonemapOperator
    if (playbackForm.tonemapParam !== playbackInitial.tonemapParam) {
      playbackDiff.tonemapParam = playbackForm.tonemapParam === '' ? null : Number(playbackForm.tonemapParam)
    }
    if (playbackForm.tonemapDesat !== playbackInitial.tonemapDesat) {
      playbackDiff.tonemapDesat = playbackForm.tonemapDesat === '' ? null : Number(playbackForm.tonemapDesat)
    }
  }
  const canSavePlayback = Object.keys(playbackDiff).length > 0 && !playbackBusy

  async function handleSavePlayback() {
    if (!canSavePlayback) return
    setPlaybackBusy(true)
    setPlaybackError(null)
    try {
      await horizon.settings.patchServer(playbackDiff)
      setPlaybackInitial({ ...playbackForm! })
      onSave('Playback settings updated.')
    } catch {
      setPlaybackError('Failed to save settings. Please try again.')
    } finally {
      setPlaybackBusy(false)
    }
  }

  return (
    <>
      <p>Library</p>

      <div>
        <label htmlFor="settings-watched-pct">
          Watched threshold (%)
        </label>
        <input
          id="settings-watched-pct"
          type="number"
          min={1} max={100}
          value={form.watchedThresholdPct}
          onChange={e => set('watchedThresholdPct', Number(e.target.value))}
        />
      </div>

      <div>
        <label htmlFor="settings-cron-hour">
          Nightly scan hour (0–23 local time)
        </label>
        <input
          id="settings-cron-hour"
          type="number"
          min={0} max={23}
          value={form.scanCronHour}
          onChange={e => set('scanCronHour', Number(e.target.value))}
        />
      </div>

      <div>
        <label htmlFor="settings-concurrency">
          Scan concurrency
        </label>
        <input
          id="settings-concurrency"
          type="number"
          min={1} max={32}
          value={form.scanConcurrency}
          onChange={e => set('scanConcurrency', Number(e.target.value))}
        />
      </div>

      <div>
        <div>
          <label htmlFor="settings-watch-fs">
            Enable filesystem watcher
          </label>
          <input
            id="settings-watch-fs"
            type="checkbox"
            checked={form.watchFs}
            onChange={e => set('watchFs', e.target.checked)}
          />
        </div>
      </div>

      <div>
        <label htmlFor="settings-debounce">
          Watcher debounce (ms)
        </label>
        <input
          id="settings-debounce"
          type="number"
          min={100} max={60000}
          value={form.watchDebounceMs}
          onChange={e => set('watchDebounceMs', Number(e.target.value))}
        />
      </div>

      <p>Metadata</p>

      <div>
        <label>TMDB Token</label>
        <div>
          <span>
            {tmdbStatus === 'set' ? 'Set' : 'Not set'}
          </span>
          {!showTokenInput && (
            <button
              type="button"
              onClick={() => { setShowTokenInput(true); setPendingToken('') }}
            >
              {tmdbStatus === 'set' ? 'Replace' : 'Add token'}
            </button>
          )}
        </div>
        {showTokenInput && (
          <div>
            <input
              id="settings-tmdb-token"
              type="password"
              placeholder="Paste new token or leave blank to clear"
              value={pendingToken}
              onChange={e => setPendingToken(e.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => { setShowTokenInput(false); setPendingToken('') }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div>
        <label htmlFor="settings-batch-size">
          Metadata batch size
        </label>
        <input
          id="settings-batch-size"
          type="number"
          min={1} max={500}
          value={metaForm.metadataBatchSize}
          onChange={e => setMeta('metadataBatchSize', Number(e.target.value))}
        />
      </div>

      <div>
        <label htmlFor="settings-max-age-movie">
          Movie metadata max age (days)
        </label>
        <input
          id="settings-max-age-movie"
          type="number"
          min={1}
          value={metaForm.metadataMaxAgeMovieDays}
          onChange={e => setMeta('metadataMaxAgeMovieDays', Number(e.target.value))}
        />
      </div>

      <div>
        <label htmlFor="settings-max-age-show">
          Show metadata max age (days)
        </label>
        <input
          id="settings-max-age-show"
          type="number"
          min={1}
          value={metaForm.metadataMaxAgeShowDays}
          onChange={e => setMeta('metadataMaxAgeShowDays', Number(e.target.value))}
        />
      </div>

      <div>
        <label htmlFor="settings-max-age-episode">
          Episode metadata max age (days)
        </label>
        <input
          id="settings-max-age-episode"
          type="number"
          min={1}
          value={metaForm.metadataMaxAgeEpDays}
          onChange={e => setMeta('metadataMaxAgeEpDays', Number(e.target.value))}
        />
      </div>

      {error && <p>{error}</p>}

      <div>
        <button
          disabled={!canSave}
          onClick={handleSave}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* ---- Playback subsection ---------------------------------------- */}
      {playbackForm && (
        <>
          <p>Playback</p>

          <div>
            <label htmlFor="settings-max-sessions">
              Max concurrent sessions
            </label>
            <input
              id="settings-max-sessions"
              type="number"
              min={1} max={64}
              value={playbackForm.maxSessions}
              onChange={e => setPlayback('maxSessions', Number(e.target.value))}
            />
          </div>

          <div>
            <label htmlFor="settings-max-renditions">
              Max renditions (ABR ladder size)
            </label>
            <input
              id="settings-max-renditions"
              type="number"
              min={1} max={8}
              value={playbackForm.maxRenditions}
              onChange={e => setPlayback('maxRenditions', Number(e.target.value))}
            />
          </div>

          <div>
            <label htmlFor="settings-ws-grace">
              WS grace period (ms)
            </label>
            <input
              id="settings-ws-grace"
              type="number"
              min={0}
              value={playbackForm.wsGraceMs}
              onChange={e => setPlayback('wsGraceMs', Number(e.target.value))}
            />
          </div>

          <div>
            <label htmlFor="settings-ws-attach">
              WS attach timeout (ms)
            </label>
            <input
              id="settings-ws-attach"
              type="number"
              min={0}
              value={playbackForm.wsAttachMs}
              onChange={e => setPlayback('wsAttachMs', Number(e.target.value))}
            />
          </div>

          <div>
            <label htmlFor="settings-force-encoder">
              Force encoder{detectedEncoder ? ` (current: ${detectedEncoder})` : ''}
            </label>
            <input
              id="settings-force-encoder"
              type="text"
              placeholder="e.g. h264_videotoolbox (leave empty for auto-detect)"
              value={playbackForm.forceEncoder}
              onChange={e => setPlayback('forceEncoder', e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="settings-tonemap-op">
              Tone-map operator
            </label>
            <select
              id="settings-tonemap-op"
              value={playbackForm.tonemapOperator}
              onChange={e => setPlayback('tonemapOperator', e.target.value)}
            >
              {TONEMAP_OPERATORS.map(op => (
                <option key={op} value={op}>{op}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="settings-tonemap-param">
              Tone-map param (leave empty for operator default)
            </label>
            <input
              id="settings-tonemap-param"
              type="number"
              placeholder="operator default"
              value={playbackForm.tonemapParam}
              onChange={e => setPlayback('tonemapParam', e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="settings-tonemap-desat">
              Tone-map desat (leave empty for operator default)
            </label>
            <input
              id="settings-tonemap-desat"
              type="number"
              placeholder="operator default"
              value={playbackForm.tonemapDesat}
              onChange={e => setPlayback('tonemapDesat', e.target.value)}
            />
          </div>

          {playbackError && <p>{playbackError}</p>}

          <div>
            <button
              disabled={!canSavePlayback}
              onClick={handleSavePlayback}
            >
              {playbackBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </>
  )
}
