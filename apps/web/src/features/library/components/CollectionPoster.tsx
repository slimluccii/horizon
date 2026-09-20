import { tmdbImageUrl } from '@horizon/sdk'
import type { CollectionSummary } from '@horizon/sdk'

interface Props {
  collection: CollectionSummary
  onClick?: () => void
}

/** Collection tile for the Movies grid. A "N films" badge marks it as a set
 *  rather than a single film. */
export default function CollectionPoster({ collection, onClick }: Props) {
  // Fall back to the first member's poster if the collection has none.
  const member = collection.movies[0]
  const memberMeta = member?.metadata?.kind === 'movie' ? member.metadata : undefined
  const poster = tmdbImageUrl(collection.posterPath ?? memberMeta?.posterPath, 'w342')
  const count = collection.movies.length

  return (
    <button
      onClick={onClick}
      aria-label={collection.name}
      data-testid="collection-card"
    >
      {poster
        ? <img src={poster} alt="" width={180} height={270} loading="lazy" />
        : <span>No poster</span>}
      <span>{count} films</span>
      <span>
        <span>{collection.name}</span>
        <span>Collection</span>
      </span>
    </button>
  )
}
