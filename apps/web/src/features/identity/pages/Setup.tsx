import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../../../shared/ui/chrome/HorizonMark.tsx'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
import { FolderBrowser, type LibraryTag } from '../../../shared/ui/FolderBrowser/FolderBrowser.tsx'
import './Setup.css'

const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🚀', '🎮', '🎬', '🎨', '👤']

type StepId = 'owner' | 'folders' | 'tmdb' | 'finish'
const STEPS: StepId[] = ['owner', 'folders', 'tmdb', 'finish']

export default function Setup() {
  const navigate = useNavigate()
  const { refresh } = useActiveUser()

  const [step, setStep] = useState<StepId>('owner')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1 — owner
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [ownerCreated, setOwnerCreated] = useState(false)

  // Step 2 — library folders
  const [moviesRoots, setMoviesRoots] = useState<string[]>([])
  const [showsRoots, setShowsRoots] = useState<string[]>([])

  // Step 3 — TMDB token
  const [tmdbToken, setTmdbToken] = useState('')

  const stepIndex = STEPS.indexOf(step)

  function goTo(next: StepId) {
    setError(null)
    setStep(next)
  }

  // --- Step 1: create owner + set the owner password -----------------------
  // The owner profile is the household account that can never be removed; it
  // also gets the first password. We create the profile (allowlisted on an empty
  // DB) then immediately set its password via auth.setPassword, which issues the
  // session (httpOnly cookie + stored bearer) so the rest of the wizard runs
  // authenticated. No more X-Horizon-User header — identity rides the session.
  async function createOwner() {
    if (!name.trim()) {
      setError('Name required')
      return
    }
    if (password.length < 8) {
      setError('Use a password of at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await horizon.users.create({ name: name.trim(), avatar })
      // Set-password on a brand-new owner needs no old password; on success the
      // server re-issues a session, so subsequent owner/admin-gated calls (the
      // folder save + scan kick) are authenticated.
      await horizon.auth.setPassword({ newPassword: password })
      await refresh()
      setOwnerCreated(true)
      goTo('folders')
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'name-taken') setError('That name is already in use')
      else if (code === 'weak-password') setError('Use a stronger password (at least 8 characters)')
      else setError(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  // --- Step 2: library folders --------------------------------------------
  function addFolder(path: string, tag: LibraryTag) {
    setError(null)
    if (tag === 'movies') {
      setMoviesRoots(prev => (prev.includes(path) ? prev : [...prev, path]))
    } else {
      setShowsRoots(prev => (prev.includes(path) ? prev : [...prev, path]))
    }
  }

  function removeFolder(path: string, tag: LibraryTag) {
    if (tag === 'movies') {
      setMoviesRoots(prev => prev.filter(p => p !== path))
    } else {
      setShowsRoots(prev => prev.filter(p => p !== path))
    }
  }

  async function saveFoldersAndContinue() {
    setBusy(true)
    setError(null)
    try {
      await horizon.settings.patchServer({ moviesRoots, showsRoots })
      goTo('tmdb')
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  // --- Step 3: TMDB token --------------------------------------------------
  async function saveTokenAndContinue() {
    setBusy(true)
    setError(null)
    try {
      if (tmdbToken.trim()) {
        await horizon.settings.patchServer({ tmdbToken: tmdbToken.trim() })
      }
      goTo('finish')
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  // --- Step 4: finish ------------------------------------------------------
  async function finish() {
    setBusy(true)
    setError(null)
    try {
      // Only kick a scan if at least one folder was configured. The rescan
      // endpoint is owner/admin-gated; the owner's session cookie (set when the
      // password was created in step 1) rides the request via credentials.
      if (moviesRoots.length > 0 || showsRoots.length > 0) {
        await fetch('/api/library/rescan', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      }
    } catch {
      // A failed scan kick shouldn't block landing in the app; it can be
      // re-run from Settings.
    } finally {
      setBusy(false)
      navigate('/', { replace: true })
    }
  }

  const totalFolders = moviesRoots.length + showsRoots.length

  return (
    <div className="setup">
      <div className="setup__bg" />
      <div className="setup__content">
        <HorizonMark size={56} withText />

        <div className="setup__card">
          <div className="setup__steps" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span
                key={s}
                className={`setup__step-dot ${i === stepIndex ? 'is-active' : ''} ${i < stepIndex ? 'is-done' : ''}`}
              />
            ))}
          </div>

          {step === 'owner' && (
            <>
              <div className="eyebrow">First run · step 1 of 4</div>
              <h1 className="setup__title">Welcome to Horizon</h1>
              <p className="setup__subtitle">Create the owner profile and set its password.</p>
              <p className="setup__subtitle">
                You'll be the household owner — the account that can never be removed.
              </p>

              <label className="setup__field">
                <span className="setup__label">Name</span>
                <input
                  className="setup__input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  maxLength={40}
                  placeholder="Luuk"
                  autoFocus
                />
              </label>

              <div className="setup__field">
                <span className="setup__label">Avatar</span>
                <div className="setup__avatars">
                  {AVATARS.map(a => (
                    <button
                      key={a}
                      className={`setup__avatar ${avatar === a ? 'is-selected' : ''}`}
                      onClick={() => setAvatar(a === avatar ? null : a)}
                      type="button"
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>

              <label className="setup__field">
                <span className="setup__label">Password</span>
                <input
                  className="setup__input"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
              </label>

              <label className="setup__field">
                <span className="setup__label">Confirm password</span>
                <input
                  className="setup__input"
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  placeholder="Re-enter password"
                  autoComplete="new-password"
                  onKeyDown={e => e.key === 'Enter' && createOwner()}
                />
              </label>

              {error && <div className="setup__error">{error}</div>}

              <button
                className="setup__submit"
                disabled={busy || !name.trim() || !password || !confirm}
                onClick={createOwner}
              >
                {busy ? 'Creating…' : <>Continue <Icon name="chevron-right" size={14} color="#000" /></>}
              </button>
            </>
          )}

          {step === 'folders' && (
            <>
              <div className="eyebrow">First run · step 2 of 4</div>
              <h1 className="setup__title">Add your library</h1>
              <p className="setup__subtitle">
                Browse the mounted media and tag each folder as Movies or Shows. You can add more later in
                Settings.
              </p>

              <div className="setup__field">
                <FolderBrowser browse={path => horizon.library.browse(path)} onPick={addFolder} />
              </div>

              {totalFolders > 0 && (
                <div className="setup__field">
                  <span className="setup__label">Selected folders</span>
                  <ul className="setup__roots">
                    {moviesRoots.map(p => (
                      <li key={`m:${p}`} className="setup__root">
                        <span className="setup__root-kind">Movies</span>
                        <span className="setup__root-path" title={p}>{p}</span>
                        <button
                          type="button"
                          className="setup__root-remove"
                          aria-label={`Remove ${p}`}
                          onClick={() => removeFolder(p, 'movies')}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                    {showsRoots.map(p => (
                      <li key={`s:${p}`} className="setup__root">
                        <span className="setup__root-kind">Shows</span>
                        <span className="setup__root-path" title={p}>{p}</span>
                        <button
                          type="button"
                          className="setup__root-remove"
                          aria-label={`Remove ${p}`}
                          onClick={() => removeFolder(p, 'shows')}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {error && <div className="setup__error">{error}</div>}

              <button
                className="setup__submit"
                disabled={busy}
                onClick={saveFoldersAndContinue}
              >
                {busy ? 'Saving…' : <>Continue <Icon name="chevron-right" size={14} color="#000" /></>}
              </button>
              <button className="setup__skip" type="button" disabled={busy} onClick={() => goTo('tmdb')}>
                Skip — set up later
              </button>
            </>
          )}

          {step === 'tmdb' && (
            <>
              <div className="eyebrow">First run · step 3 of 4</div>
              <h1 className="setup__title">Artwork &amp; metadata</h1>
              <p className="setup__subtitle">
                Add a TMDB API read token to fetch posters, descriptions and cast. Optional — you can add it
                anytime in Settings.
              </p>

              <label className="setup__field">
                <span className="setup__label">TMDB token</span>
                <input
                  className="setup__input"
                  value={tmdbToken}
                  onChange={e => setTmdbToken(e.target.value)}
                  placeholder="eyJhbGciOiJ…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              {error && <div className="setup__error">{error}</div>}

              <button
                className="setup__submit"
                disabled={busy}
                onClick={saveTokenAndContinue}
              >
                {busy ? 'Saving…' : <>Continue <Icon name="chevron-right" size={14} color="#000" /></>}
              </button>
              <button className="setup__skip" type="button" disabled={busy} onClick={() => goTo('finish')}>
                Skip — no metadata
              </button>
            </>
          )}

          {step === 'finish' && (
            <>
              <div className="eyebrow">First run · step 4 of 4</div>
              <h1 className="setup__title">You're all set</h1>
              {totalFolders > 0 ? (
                <p className="setup__subtitle">
                  Horizon will scan {totalFolders} folder{totalFolders === 1 ? '' : 's'} now. Your library
                  fills in as titles are indexed.
                </p>
              ) : (
                <p className="setup__subtitle">
                  No library folders yet — you'll land in an empty library. Add folders anytime from Settings.
                </p>
              )}
              {!ownerCreated && (
                <p className="setup__subtitle">
                  You skipped creating a profile. You can create one from the profile picker.
                </p>
              )}

              {error && <div className="setup__error">{error}</div>}

              <button className="setup__submit" disabled={busy} onClick={finish}>
                {busy ? 'Finishing…' : <>Enter Horizon <Icon name="chevron-right" size={14} color="#000" /></>}
              </button>
            </>
          )}
        </div>

        <div className="setup__footer">horizon.local · self-hosted media</div>
      </div>
    </div>
  )
}
