import { tmdbImageUrl } from '@horizon/sdk'
import type { CollectionSummary } from '@horizon/sdk'
import './LargePoster.css'

interface Props {
  collection: CollectionSummary
  width?: number
  onClick?: () => void
}

/** Collection tile for the Movies grid. Reuses poster styling; stacked look +
 *  "N films" badge mark it as a set rather than a single film. */
export default function CollectionPoster({ collection, width = 180, onClick }: Props) {
  const height = width * 1.5
  // Fall back to the first member's poster if the collection has none.
  const member = collection.movies[0]
  const memberMeta = member?.metadata?.kind === 'movie' ? member.metadata : undefined
  const poster = tmdbImageUrl(collection.posterPath ?? memberMeta?.posterPath, 'w342')
  const count = collection.movies.length

  return (
    <button
      className="poster"
      style={{ width }}
      onClick={onClick}
      aria-label={collection.name}
      data-testid="collection-card"
    >
      <div
        className="poster__art"
        style={{
          width, height,
          background: poster ? `url(${poster}) center/cover no-repeat, var(--surface)` : 'var(--surface)',
          borderRadius: Math.max(6, width * 0.05),
        }}
      >
        <div className="poster__badge">{count} films</div>
        {!poster && <div className="poster__nopo">No poster</div>}
      </div>
      <div className="poster__meta">
        <div className="poster__title">{collection.name}</div>
        <div className="poster__sub"><span>Collection</span></div>
      </div>
    </button>
  )
}
