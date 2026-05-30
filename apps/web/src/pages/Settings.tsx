import { useEffect, useState, useRef } from 'react'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import { SUPPORTED_LANGUAGES, isRoleChangedError } from '@horizon/sdk'
import type { Preferences, User, ServerSettings } from '@horizon/sdk'
import LargeTopNav from '../components/chrome/LargeTopNav.tsx'
import './Settings.css'

type Tab = 'Personal' | 'Server' | 'Profiles'

const PALETTE = ['#0089FF', '#E34989', '#1FA47C', '#F5C518', '#9D5CFF', '#FA6A3C']
function userColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

function ProfilesPanel({
  viewerRole,
  onRoleChanged,
}: {
  viewerRole: 'owner' | 'admin' | 'member'
  onRoleChanged: () => void
}) {
  const [rows, setRows] = useState<User[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    horizon.users.list().then(setRows)
  }, [])

  async function handleRoleChange(id: string, role: 'admin' | 'member') {
    setBusy(true)
    setErr(null)
    try {
      await horizon.users.update(id, { role })
      const updated = await horizon.users.list()
      setRows(updated)
    } catch (e) {
      if (isRoleChangedError(e)) {
        onRoleChanged()
        return
      }
      setErr((e as { message?: string }).message ?? 'Failed to update role')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="settings__section-title">Profiles</p>
      {rows.map(row => {
        const color = userColor(row.name)
        const initial = row.avatar ?? row.name.charAt(0).toUpperCase()
        return (
          <div key={row.id} className={`settings__profile-row${row.role === 'owner' ? ' settings__profile-row--owner' : ''}`}>
            <div className="settings__profile-avatar" style={{ background: color }}>{initial}</div>
            <span className="settings__profile-name">{row.name}</span>
            {row.role === 'owner' ? (
              <span className="settings__profile-role-label">Owner</span>
            ) : (
              <select
                className="settings__profile-role-select"
                value={row.role}
                disabled={busy}
                onChange={e => handleRoleChange(row.id, e.target.value as 'admin' | 'member')}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            )}
          </div>
        )
      })}
      {err && <p className="settings__profile-error">{err}</p>}
    </div>
  )
}

// ---- Server tab -------------------------------------------------------

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

function ServerPanel({ onSave }: { onSave: (msg: string) => void }) {
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
    }).catch(() => setError('Failed to load server settings.'))
  }, [])

  if (!form || !initialLib || !metaForm || !initialMeta) {
    return error
      ? <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error}</p>
      : <p className="settings__section-title">Loading…</p>
  }

  function set<K extends keyof LibraryForm>(key: K, value: LibraryForm[K]) {
    setForm(f => f ? { ...f, [key]: value } : f)
  }

  function setMeta<K extends keyof MetadataForm>(key: K, value: MetadataForm[K]) {
    setMetaForm(f => f ? { ...f, [key]: value } : f)
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

  return (
    <>
      <p className="settings__section-title">Library</p>

      <div className="settings__field">
        <label className="settings__label" htmlFor="settings-watched-pct">
          Watched threshold (%)
        </label>
        <input
          id="settings-watched-pct"
          type="number"
          className="settings__input"
          min={1} max={100}
          value={form.watchedThresholdPct}
          onChange={e => set('watchedThresholdPct', Number(e.target.value))}
        />
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="settings-cron-hour">
          Nightly scan hour (0–23 local time)
        </label>
        <input
          id="settings-cron-hour"
          type="number"
          className="settings__input"
          min={0} max={23}
          value={form.scanCronHour}
          onChange={e => set('scanCronHour', Number(e.target.value))}
        />
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="settings-concurrency">
          Scan concurrency
        </label>
        <input
          id="settings-concurrency"
          type="number"
          className="settings__input"
          min={1} max={32}
          value={form.scanConcurrency}
          onChange={e => set('scanConcurrency', Number(e.target.value))}
        />
      </div>

      <div className="settings__field">
        <div className="settings__toggle-row">
          <label className="settings__toggle-label" htmlFor="settings-watch-fs">
            Enable filesystem watcher
          </label>
          <input
            id="settings-watch-fs"
            type="checkbox"
            className="settings__toggle-input"
            checked={form.watchFs}
            onChange={e => set('watchFs', e.target.checked)}
          />
        </div>
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="settings-debounce">
          Watcher debounce (ms)
        </label>
        <input
          id="settings-debounce"
          type="number"
          className="settings__input"
          min={100} max={60000}
          value={form.watchDebounceMs}
          onChange={e => set('watchDebounceMs', Number(e.target.value))}
        />
      </div>

      <p className="settings__section-title">Metadata</p>

      <div className="settings__field">
        <label className="settings__label">TMDB Token</label>
        <div className="settings__token-row">
          <span className={`settings__token-status settings__token-status--${tmdbStatus}`}>
            {tmdbStatus === 'set' ? 'Set' : 'Not set'}
          </span>
          {!showTokenInput && (
            <button
              className="settings__token-replace"
              type="button"
              onClick={() => { setShowTokenInput(true); setPendingToken('') }}
            >
              {tmdbStatus === 'set' ? 'Replace' : 'Add token'}
            </button>
          )}
        </div>
        {showTokenInput && (
          <div className="settings__token-input-row">
            <input
              id="settings-tmdb-token"
              type="password"
              className="settings__input"
              placeholder="Paste new token or leave blank to clear"
              value={pendingToken}
              onChange={e => setPendingToken(e.target.value)}
              autoComplete="off"
            />
            <button
              className="settings__token-cancel"
              type="button"
              onClick={() => { setShowTokenInput(false); setPendingToken('') }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="settings-batch-size">
          Metadata batch size
        </label>
        <input
          id="settings-batch-size"
          type="number"
          className="settings__input"
          min={1} max={500}
          value={metaForm.metadataBatchSize}
          onChange={e => setMeta('metadataBatchSize', Number(e.target.value))}
        />
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="settings-max-age-movie">
          Movie metadata max age (days)
        </label>
        <input
          id="settings-max-age-movie"
          type="number"
          className="settings__input"
          min={1}
          value={metaForm.metadataMaxAgeMovieDays}
          onChange={e => setMeta('metadataMaxAgeMovieDays', Number(e.target.value))}
        />
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="settings-max-age-show">
          Show metadata max age (days)
        </label>
        <input
          id="settings-max-age-show"
          type="number"
          className="settings__input"
          min={1}
          value={metaForm.metadataMaxAgeShowDays}
          onChange={e => setMeta('metadataMaxAgeShowDays', Number(e.target.value))}
        />
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="settings-max-age-episode">
          Episode metadata max age (days)
        </label>
        <input
          id="settings-max-age-episode"
          type="number"
          className="settings__input"
          min={1}
          value={metaForm.metadataMaxAgeEpDays}
          onChange={e => setMeta('metadataMaxAgeEpDays', Number(e.target.value))}
        />
      </div>

      {error && <p style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '8px' }}>{error}</p>}

      <div className="settings__actions">
        <button
          className="settings__save"
          disabled={!canSave}
          onClick={handleSave}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  )
}

// ---- Personal tab helpers --------------------------------------------

const QUALITY_OPTIONS = ['auto', '1080p', '720p', '480p'] as const

const DEFAULT_FORM: Required<Preferences> = {
  theme: 'dark',
  audioLanguage: 'en',
  subtitleLanguage: 'en',
  subtitlesEnabled: false,
  preferredQuality: 'auto',
}

function mergeWithDefaults(prefs: Preferences): Required<Preferences> {
  return {
    theme: prefs.theme ?? DEFAULT_FORM.theme,
    audioLanguage: prefs.audioLanguage ?? DEFAULT_FORM.audioLanguage,
    subtitleLanguage: prefs.subtitleLanguage ?? DEFAULT_FORM.subtitleLanguage,
    subtitlesEnabled: prefs.subtitlesEnabled ?? DEFAULT_FORM.subtitlesEnabled,
    preferredQuality: prefs.preferredQuality ?? DEFAULT_FORM.preferredQuality,
  }
}

export default function Settings() {
  const { user, userId } = useActiveUser()

  const [activeTab, setActiveTab] = useState<Tab>('Personal')
  const [initial, setInitial] = useState<Required<Preferences>>(DEFAULT_FORM)
  const [form, setForm] = useState<Required<Preferences>>(DEFAULT_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!userId) return
    horizon.users.get(userId).then(u => {
      const merged = mergeWithDefaults(u.preferences)
      setInitial(merged)
      setForm(merged)
    })
  }, [userId])

  const viewerCanManage = user?.role === 'owner' || user?.role === 'admin'
  const tabs: Tab[] = viewerCanManage ? ['Personal', 'Server', 'Profiles'] : ['Personal']

  const diff = Object.fromEntries(
    Object.entries(form).filter(([k, v]) => v !== initial[k as keyof typeof initial])
  ) as Partial<Preferences>

  const canSave = Object.keys(diff).length > 0 && !busy

  async function handleSave() {
    if (!userId || !canSave) return
    setBusy(true)
    setError(null)
    try {
      const updated = await horizon.users.update(userId, { preferences: diff })
      const merged = mergeWithDefaults(updated.preferences)
      setInitial(merged)
      setForm(merged)
      if (diff.theme !== undefined) {
        document.documentElement.dataset.theme = diff.theme === 'light' ? 'light' : 'dark'
      }
    } catch {
      setError('Failed to save settings. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function set<K extends keyof Required<Preferences>>(key: K, value: Required<Preferences>[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function showToast(message: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }

  function handleRoleChanged() {
    setActiveTab('Personal')
    showToast('Your role changed.')
  }

  return (
    <div className="settings">
      <LargeTopNav />
      {toast && (
        <div className="settings__toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      <div className="settings__body">
        <div className="settings__tabs">
          {tabs.map(tab => (
            <button
              key={tab}
              className={`settings__tab ${activeTab === tab ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === 'Server' && (
          <ServerPanel onSave={showToast} />
        )}

        {activeTab === 'Profiles' && user && (
          <ProfilesPanel viewerRole={user.role} onRoleChanged={handleRoleChanged} />
        )}

        {activeTab === 'Personal' && (
          <>
            <p className="settings__section-title">Appearance</p>

            <div className="settings__field">
              <label className="settings__label" htmlFor="settings-theme">Theme</label>
              <select
                id="settings-theme"
                className="settings__select"
                value={form.theme}
                onChange={e => set('theme', e.target.value as 'dark' | 'light')}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>

            <p className="settings__section-title">Audio &amp; Subtitles</p>

            <div className="settings__field">
              <label className="settings__label" htmlFor="settings-audio-lang">Audio Language</label>
              <select
                id="settings-audio-lang"
                className="settings__select"
                value={form.audioLanguage}
                onChange={e => set('audioLanguage', e.target.value)}
              >
                {SUPPORTED_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            <div className="settings__field">
              <label className="settings__label" htmlFor="settings-sub-lang">Subtitle Language</label>
              <select
                id="settings-sub-lang"
                className="settings__select"
                value={form.subtitleLanguage}
                onChange={e => set('subtitleLanguage', e.target.value)}
              >
                {SUPPORTED_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            <div className="settings__field">
              <div className="settings__toggle-row">
                <label className="settings__toggle-label" htmlFor="settings-subtitles">
                  Subtitles Enabled
                </label>
                <input
                  id="settings-subtitles"
                  type="checkbox"
                  className="settings__toggle-input"
                  checked={form.subtitlesEnabled}
                  onChange={e => set('subtitlesEnabled', e.target.checked)}
                />
              </div>
            </div>

            <p className="settings__section-title">Playback</p>

            <div className="settings__field">
              <label className="settings__label" htmlFor="settings-quality">Preferred Quality</label>
              <select
                id="settings-quality"
                className="settings__select"
                value={form.preferredQuality}
                onChange={e => set('preferredQuality', e.target.value as Required<Preferences>['preferredQuality'])}
              >
                {QUALITY_OPTIONS.map(q => (
                  <option key={q} value={q}>{q === 'auto' ? 'Auto' : q}</option>
                ))}
              </select>
            </div>

            {error && <p style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '8px' }}>{error}</p>}

            <div className="settings__actions">
              <button
                className="settings__save"
                disabled={!canSave}
                onClick={handleSave}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
