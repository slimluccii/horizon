import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../components/chrome/HorizonMark.tsx'
import Icon from '../components/chrome/Icon.tsx'
import { FolderBrowser, type LibraryTag } from '../components/FolderBrowser/FolderBrowser.tsx'
import './Setup.css'

const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🚀', '🎮', '🎬', '🎨', '👤']

type StepId = 'owner' | 'folders' | 'tmdb' | 'finish'
const STEPS: StepId[] = ['owner', 'folders', 'tmdb', 'finish']

export default function Setup() {
  const navigate = useNavigate()
  const { setUserId } = useActiveUser()

  const [step, setStep] = useState<StepId>('owner')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1 — owner
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [ownerCreated, setOwnerCreated] = useState(false)
  const [ownerId, setOwnerId] = useState<string | null>(null)

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

  // --- Step 1: create owner ------------------------------------------------
  async function createOwner() {
    if (!name.trim()) {
      setError('Name required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const u = await horizon.users.create({ name: name.trim(), avatar })
      setUserId(u.id)
      setOwnerId(u.id)
      setOwnerCreated(true)
      goTo('folders')
    } catch (err) {
      const code = (err as { code?: string }).code
      setError(code === 'name-taken' ? 'That name is already in use' : String((err as Error).message))
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
      // endpoint is owner/admin-gated, so it carries the active-user header
      // identifying the freshly-created owner.
      if (moviesRoots.length > 0 || showsRoots.length > 0) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (ownerId) headers['X-Horizon-User'] = ownerId
        await fetch('/library/rescan', { method: 'POST', headers, body: JSON.stringify({}) })
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
              <p className="setup__subtitle">Create a profile to start watching.</p>
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

              {error && <div className="setup__error">{error}</div>}

              <button
                className="setup__submit"
                disabled={busy || !name.trim()}
                onClick={createOwner}
              >
                {busy ? 'Creating…' : <>Continue <Icon name="chevron-right" size={14} color="#000" /></>}
              </button>
              <button className="setup__skip" type="button" disabled={busy} onClick={() => goTo('folders')}>
                Skip for now
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
