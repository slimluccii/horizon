import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import type { MediaItem } from '@horizon/sdk'
import LargeTopNav from '../../../shared/ui/chrome/LargeTopNav.tsx'

const DEBOUNCE_MS = 250
const MIN_QUERY_LENGTH = 2

/** Library search. Query lives in the URL (?q=) so results are linkable and
 *  survive back-navigation. */
export default function Search() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const initialQuery = params.get('q') ?? ''
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<MediaItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (q.length < MIN_QUERY_LENGTH) {
      setResults([])
      setSearched(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      setParams(q ? { q } : {}, { replace: true })
      horizon.library.search(q)
        .then(items => { if (!cancelled) { setResults(items); setSearched(true) } })
        .catch(() => { if (!cancelled) { setResults([]); setSearched(true) } })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, setParams])

  function open(item: MediaItem) {
    if (item.kind === 'show') navigate(`/show/${item.id}`)
    else navigate(`/play/${item.id}`)
  }

  function kindLabel(item: MediaItem): string {
    if (item.kind === 'show') return 'Series'
    if (item.kind === 'episode') {
      const se = item.season != null && item.episode != null
        ? ` S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`
        : ''
      return `Episode${se}`
    }
    return 'Movie'
  }

  return (
    <div>
      <LargeTopNav back="/" />
      <main>
        <h1>Search</h1>
        <form role="search" onSubmit={e => e.preventDefault()}>
          <label>
            Search the library
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Title…"
              autoFocus
            />
          </label>
        </form>

        {searching && <p role="status">Searching…</p>}
        {!searching && searched && results.length === 0 && (
          <p>No results for “{query.trim()}”.</p>
        )}

        <ul>
          {results.map(item => (
            <li key={item.id}>
              <button onClick={() => open(item)}>
                <span>{item.title}</span>
                {item.year && <span> ({item.year})</span>}
                <span> — {kindLabel(item)}</span>
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
