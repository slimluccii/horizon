import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import { SUPPORTED_LANGUAGES, isRoleChangedError } from '@horizon/sdk'
import type { Preferences, User, ServerSettings } from '@horizon/sdk'
import { FolderBrowser, type LibraryTag } from '../components/FolderBrowser/FolderBrowser.tsx'
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
  viewerId,
  viewerRole,
  onRoleChanged,
  onToast,
}: {
  viewerId: string
  viewerRole: 'owner' | 'admin' | 'member'
  onRoleChanged: () => void
  onToast: (msg: string) => void
}) {
  void viewerRole
  const [rows, setRows] = useState<User[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Which member's password is being reset (their id), and the pending value.
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [resetPw, setResetPw] = useState('')

  useEffect(() => {
    horizon.users.list().then(setRows)
  }, [])

  async function handleRoleChange(id: string, role: 'admin' | 'member') {
    setBusy(true)
    setErr(null)
    try {
      await horizon.users.update(id, { role })
      // Self-demote: the viewer just dropped their own role to member, losing
      // access to this tab. Detect it directly off the request rather than
      // waiting for a follow-up call to 403 — GET /users is unauthenticated
      // (profile picker), so it would NOT fail for a freshly-demoted member.
      if (id === viewerId && role === 'member') {
        onRoleChanged()
        return
      }
      const updated = await horizon.users.list()
      setRows(updated)
    } catch (e) {
      // Belt-and-suspenders: a privileged follow-up call that 403s (role changed
      // out from under the session) still routes the viewer back to Personal.
      if (isRoleChangedError(e)) {
        onRoleChanged()
        return
      }
      setErr((e as { message?: string }).message ?? 'Failed to update role')
    } finally {
      setBusy(false)
    }
  }

  // Owner/admin reset of another user — no old password required (the server
  // gates this on the caller's role). Invalidates that user's other sessions.
  async function handleResetPassword(id: string) {
    if (resetPw.length < 8) { setErr('Use at least 8 characters.'); return }
    setBusy(true)
    setErr(null)
    try {
      await horizon.auth.setPassword({ userId: id, newPassword: resetPw })
      setResetFor(null)
      setResetPw('')
      onToast('Password reset. The member must sign in again.')
      const updated = await horizon.users.list()
      setRows(updated)
    } catch (e) {
      setErr((e as { message?: string }).message ?? 'Failed to reset password')
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
        const isSelf = row.id === viewerId
        // Owner/admin may reset any non-owner, non-self member. The owner resets
        // their own password via the Personal → Security "Change password".
        const canReset = !isSelf && row.role !== 'owner'
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
            {canReset && (
              resetFor === row.id ? (
                <div className="settings__profile-reset">
                  <input
                    type="password"
                    className="settings__input"
                    placeholder="New password"
                    value={resetPw}
                    autoComplete="new-password"
                    onChange={e => setResetPw(e.target.value)}
                  />
                  <button className="settings__token-replace" disabled={busy} onClick={() => handleResetPassword(row.id)}>
                    Save
                  </button>
                  <button className="settings__token-cancel" disabled={busy} onClick={() => { setResetFor(null); setResetPw('') }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="settings__token-replace"
                  disabled={busy}
                  onClick={() => { setResetFor(row.id); setResetPw(''); setErr(null) }}
                >
                  Reset password
                </button>
              )
            )}
          </div>
        )
      })}
      {err && <p className="settings__profile-error">{err}</p>}
    </div>
  )
}

/**
 * Personal → Security: every user can change their own password (old + new) and
 * end sessions — "Sign out" (this device) and "Sign out everywhere" (all
 * sessions). Identity comes from the session, so there's no profile to clear
 * client-side beyond the hook's cached user.
 */
function SecurityPanel({
  onToast,
  onSignOut,
  logout,
  logoutAll,
}: {
  onToast: (msg: string) => void
  onSignOut: () => void
  logout: () => Promise<void>
  logoutAll: () => Promise<void>
}) {
  const [showChange, setShowChange] = useState(false)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function changePassword() {
    if (newPw.length < 8) { setErr('Use at least 8 characters.'); return }
    if (newPw !== confirmPw) { setErr('Passwords do not match.'); return }
    setBusy(true)
    setErr(null)
    try {
      await horizon.auth.setPassword({ oldPassword: oldPw, newPassword: newPw })
      setShowChange(false)
      setOldPw(''); setNewPw(''); setConfirmPw('')
      onToast('Password changed.')
    } catch (e) {
      const code = (e as { code?: string }).code
      setErr(code === 'invalid-credentials' ? 'Current password is incorrect.' : 'Could not change the password.')
    } finally {
      setBusy(false)
    }
  }

  async function doLogout(all: boolean) {
    setBusy(true)
    try {
      if (all) await logoutAll()
      else await logout()
      onSignOut()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="settings__section-title">Security</p>

      <div className="settings__field">
        <label className="settings__label">Password</label>
        {showChange ? (
          <div className="settings__token-input-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
            <input
              type="password"
              className="settings__input"
              placeholder="Current password"
              value={oldPw}
              autoComplete="current-password"
              onChange={e => setOldPw(e.target.value)}
            />
            <input
              type="password"
              className="settings__input"
              placeholder="New password"
              value={newPw}
              autoComplete="new-password"
              onChange={e => setNewPw(e.target.value)}
            />
            <input
              type="password"
              className="settings__input"
              placeholder="Confirm new password"
              value={confirmPw}
              autoComplete="new-password"
              onChange={e => setConfirmPw(e.target.value)}
            />
            <div className="settings__token-row">
              <button className="settings__token-replace" disabled={busy} onClick={changePassword}>
                {busy ? 'Saving…' : 'Save password'}
              </button>
              <button className="settings__token-cancel" disabled={busy} onClick={() => { setShowChange(false); setErr(null) }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="settings__token-replace" type="button" onClick={() => { setShowChange(true); setErr(null) }}>
            Change password
          </button>
        )}
      </div>

      <div className="settings__field">
        <label className="settings__label">Sessions</label>
        <div className="settings__token-row">
          <button className="settings__token-cancel" disabled={busy} onClick={() => doLogout(false)}>
            Sign out
          </button>
          <button className="settings__token-cancel" disabled={busy} onClick={() => doLogout(true)}>
            Sign out everywhere
          </button>
        </div>
      </div>

      {err && <p style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '8px' }}>{err}</p>}
    </>
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

/**
 * Library folders subsection of the Server tab. Lists the configured movies /
 * shows roots, lets an owner/admin add folders via the confined FolderBrowser
 * (tagging each Movies or Shows) and remove existing ones. Roots persist via
 * PATCH /settings/server; the server validates each path is an existing directory.
 */
function LibraryFoldersPanel({ onSave }: { onSave: (msg: string) => void }) {
  const [moviesRoots, setMoviesRoots] = useState<string[] | null>(null)
  const [showsRoots, setShowsRoots] = useState<string[] | null>(null)
  const [showBrowser, setShowBrowser] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    horizon.settings.getServer().then(s => {
      setMoviesRoots(s.moviesRoots)
      setShowsRoots(s.showsRoots)
    }).catch(() => setError('Failed to load library folders.'))
  }, [])

  async function persist(nextMovies: string[], nextShows: string[]) {
    setBusy(true)
    setError(null)
    try {
      await horizon.settings.patchServer({ moviesRoots: nextMovies, showsRoots: nextShows })
      setMoviesRoots(nextMovies)
      setShowsRoots(nextShows)
      onSave('Library folders updated.')
    } catch (e) {
      // Surface the server's reason (e.g. path is not an existing directory) when present.
      const msg = (e as { message?: string })?.message
      setError(msg && msg !== 'undefined' ? `Failed to save: ${msg}` : 'Failed to save library folders.')
    } finally {
      setBusy(false)
    }
  }

  function handlePick(path: string, tag: LibraryTag) {
    const movies = moviesRoots ?? []
    const shows = showsRoots ?? []
    const addMovie = tag === 'movies' && !movies.includes(path)
    const addShow = tag === 'shows' && !shows.includes(path)
    const nextMovies = addMovie ? [...movies, path] : movies
    const nextShows = addShow ? [...shows, path] : shows
    if (addMovie || addShow) void persist(nextMovies, nextShows)
    setShowBrowser(false)
  }

  function handleRemove(path: string, tag: LibraryTag) {
    const ok = window.confirm(
      `Remove this ${tag === 'movies' ? 'movies' : 'shows'} folder?\n\n${path}\n\nItems under it will be removed from your library on the next rescan.`,
    )
    if (!ok) return
    const movies = moviesRoots ?? []
    const shows = showsRoots ?? []
    void persist(
      tag === 'movies' ? movies.filter(p => p !== path) : movies,
      tag === 'shows' ? shows.filter(p => p !== path) : shows,
    )
  }

  function renderList(roots: string[], tag: LibraryTag) {
    return (
      <div className="settings__field">
        <label className="settings__label">{tag === 'movies' ? 'Movies folders' : 'Shows folders'}</label>
        {roots.length === 0 ? (
          <p className="settings__roots-empty">No folders added.</p>
        ) : (
          <ul className="settings__roots-list">
            {roots.map(path => (
              <li key={path} className="settings__roots-row">
                <span className="settings__roots-path" title={path}>{path}</span>
                <button
                  type="button"
                  className="settings__roots-remove"
                  disabled={busy}
                  onClick={() => handleRemove(path, tag)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  if (moviesRoots === null || showsRoots === null) {
    return error
      ? <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error}</p>
      : <p className="settings__section-title">Loading…</p>
  }

  return (
    <>
      <p className="settings__section-title">Library folders</p>

      {renderList(moviesRoots, 'movies')}
      {renderList(showsRoots, 'shows')}

      {showBrowser ? (
        <div className="settings__field">
          <FolderBrowser browse={path => horizon.library.browse(path)} onPick={handlePick} />
          <div className="settings__roots-browser-actions">
            <button type="button" className="settings__token-cancel" onClick={() => setShowBrowser(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="settings__field">
          <button
            type="button"
            className="settings__token-replace"
            disabled={busy}
            onClick={() => setShowBrowser(true)}
          >
            Add folder
          </button>
        </div>
      )}

      {error && <p style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '8px' }}>{error}</p>}
    </>
  )
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
      ? <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error}</p>
      : <p className="settings__section-title">Loading…</p>
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

      {/* ---- Playback subsection ---------------------------------------- */}
      {playbackForm && (
        <>
          <p className="settings__section-title">Playback</p>

          <div className="settings__field">
            <label className="settings__label" htmlFor="settings-max-sessions">
              Max concurrent sessions
            </label>
            <input
              id="settings-max-sessions"
              type="number"
              className="settings__input"
              min={1} max={64}
              value={playbackForm.maxSessions}
              onChange={e => setPlayback('maxSessions', Number(e.target.value))}
            />
          </div>

          <div className="settings__field">
            <label className="settings__label" htmlFor="settings-max-renditions">
              Max renditions (ABR ladder size)
            </label>
            <input
              id="settings-max-renditions"
              type="number"
              className="settings__input"
              min={1} max={8}
              value={playbackForm.maxRenditions}
              onChange={e => setPlayback('maxRenditions', Number(e.target.value))}
            />
          </div>

          <div className="settings__field">
            <label className="settings__label" htmlFor="settings-ws-grace">
              WS grace period (ms)
            </label>
            <input
              id="settings-ws-grace"
              type="number"
              className="settings__input"
              min={0}
              value={playbackForm.wsGraceMs}
              onChange={e => setPlayback('wsGraceMs', Number(e.target.value))}
            />
          </div>

          <div className="settings__field">
            <label className="settings__label" htmlFor="settings-ws-attach">
              WS attach timeout (ms)
            </label>
            <input
              id="settings-ws-attach"
              type="number"
              className="settings__input"
              min={0}
              value={playbackForm.wsAttachMs}
              onChange={e => setPlayback('wsAttachMs', Number(e.target.value))}
            />
          </div>

          <div className="settings__field">
            <label className="settings__label" htmlFor="settings-force-encoder">
              Force encoder{detectedEncoder ? ` (current: ${detectedEncoder})` : ''}
            </label>
            <input
              id="settings-force-encoder"
              type="text"
              className="settings__input"
              placeholder="e.g. h264_videotoolbox (leave empty for auto-detect)"
              value={playbackForm.forceEncoder}
              onChange={e => setPlayback('forceEncoder', e.target.value)}
            />
          </div>

          <div className="settings__field">
            <label className="settings__label" htmlFor="settings-tonemap-op">
              Tone-map operator
            </label>
            <select
              id="settings-tonemap-op"
              className="settings__select"
              value={playbackForm.tonemapOperator}
              onChange={e => setPlayback('tonemapOperator', e.target.value)}
            >
              {TONEMAP_OPERATORS.map(op => (
                <option key={op} value={op}>{op}</option>
              ))}
            </select>
          </div>

          <div className="settings__field">
            <label className="settings__label" htmlFor="settings-tonemap-param">
              Tone-map param (leave empty for operator default)
            </label>
            <input
              id="settings-tonemap-param"
              type="number"
              className="settings__input"
              placeholder="operator default"
              value={playbackForm.tonemapParam}
              onChange={e => setPlayback('tonemapParam', e.target.value)}
            />
          </div>

          <div className="settings__field">
            <label className="settings__label" htmlFor="settings-tonemap-desat">
              Tone-map desat (leave empty for operator default)
            </label>
            <input
              id="settings-tonemap-desat"
              type="number"
              className="settings__input"
              placeholder="operator default"
              value={playbackForm.tonemapDesat}
              onChange={e => setPlayback('tonemapDesat', e.target.value)}
            />
          </div>

          {playbackError && <p style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '8px' }}>{playbackError}</p>}

          <div className="settings__actions">
            <button
              className="settings__save"
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
  const navigate = useNavigate()
  const { user, userId, logout, logoutAll } = useActiveUser()

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
          <>
            <LibraryFoldersPanel onSave={showToast} />
            <ServerPanel onSave={showToast} />
          </>
        )}

        {activeTab === 'Profiles' && user && (
          <ProfilesPanel
            viewerId={user.id}
            viewerRole={user.role}
            onRoleChanged={handleRoleChanged}
            onToast={showToast}
          />
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

            <SecurityPanel
              onToast={showToast}
              onSignOut={() => navigate('/login', { replace: true })}
              logout={logout}
              logoutAll={logoutAll}
            />
          </>
        )}
      </div>
    </div>
  )
}
