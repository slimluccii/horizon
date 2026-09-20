import { tmdbImageUrl } from '@horizon/sdk'
import type { ContinueWatchingItem, MovieMetadata, EpisodeMetadata, ShowMetadataInfo } from '@horizon/sdk'

interface Props {
  item: ContinueWatchingItem
  onClick?: () => void
}

/** Card used on the Continue Watching rail. Shows backdrop or episode still,
 *  show/episode label, and watch progress. */
export default function LandscapeCard({ item, onClick }: Props) {
  const isEpisode = item.kind === 'episode'

  const episodeMeta = isEpisode ? (item.media.metadata as EpisodeMetadata | null) : null
  const showMeta = item.show?.metadata as ShowMetadataInfo | null | undefined
  const movieMeta = !isEpisode ? (item.media.metadata as MovieMetadata | null) : null

  const image =
    (isEpisode ? tmdbImageUrl(episodeMeta?.stillPath, 'w500') : null) ??
    tmdbImageUrl(showMeta?.backdropPath, 'w500') ??
    tmdbImageUrl(movieMeta?.backdropPath, 'w500') ??
    tmdbImageUrl(movieMeta?.posterPath, 'w342')

  const title = isEpisode ? (item.show?.title ?? item.media.title) : item.media.title
  const sublineParts: string[] = []
  if (isEpisode && item.media.season != null && item.media.episode != null) {
    sublineParts.push(`S${String(item.media.season).padStart(2, '0')}E${String(item.media.episode).padStart(2, '0')}`)
  }
  if (isEpisode) sublineParts.push(item.media.title)
  const remaining = Math.max(0, Math.round((item.durationMs - item.positionMs) / 60_000))
  sublineParts.push(`${remaining} min left`)

  const fraction = item.durationMs > 0 ? item.positionMs / item.durationMs : 0

  return (
    <button onClick={onClick} aria-label={title}>
      {image && <img src={image} alt="" width={300} height={169} loading="lazy" />}
      <span>{title}</span>
      <span>{sublineParts.join(' · ')}</span>
      <progress max={1} value={fraction} aria-label="Watch progress" />
    </button>
  )
}
