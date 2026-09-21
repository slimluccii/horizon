import { useEffect, useState } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import { FolderBrowser, type LibraryTag } from '../../../shared/ui/FolderBrowser/FolderBrowser.tsx'

/**
 * Library folders subsection of the Server tab. Lists the configured movies /
 * shows roots, lets an owner/admin add folders via the confined FolderBrowser
 * (tagging each Movies or Shows) and remove existing ones. Roots persist via
 * PATCH /settings/server; the server validates each path is an existing directory.
 */
export default function LibraryFoldersPanel({ onSave }: { onSave: (msg: string) => void }) {
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
      <div>
        <label>{tag === 'movies' ? 'Movies folders' : 'Shows folders'}</label>
        {roots.length === 0 ? (
          <p>No folders added.</p>
        ) : (
          <ul>
            {roots.map(path => (
              <li key={path}>
                <span title={path}>{path}</span>
                <button
                  type="button"
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
      ? <p>{error}</p>
      : <p>Loading…</p>
  }

  return (
    <>
      <p>Library folders</p>

      {renderList(moviesRoots, 'movies')}
      {renderList(showsRoots, 'shows')}

      {showBrowser ? (
        <div>
          <FolderBrowser browse={path => horizon.library.browse(path)} onPick={handlePick} />
          <div>
            <button type="button" onClick={() => setShowBrowser(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowBrowser(true)}
          >
            Add folder
          </button>
        </div>
      )}

      {error && <p>{error}</p>}
    </>
  )
}
