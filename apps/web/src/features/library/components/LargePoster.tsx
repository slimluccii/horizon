import { tmdbImageUrl } from '@horizon/sdk'
import type { MediaItem, ShowSummary, MovieMetadata, ShowMetadataInfo } from '@horizon/sdk'
import { runtimeMinutes } from '../runtime.ts'

interface Props {
  item: MediaItem | ShowSummary
  showMeta?: boolean
  progress?: number   // 0..1; renders a progress element under the poster
  onClick?: () => void
}

function isShow(item: MediaItem | ShowSummary): item is ShowSummary {
  return (item as ShowSummary).seasons !== undefined
}

/** Poster tile. Used in library grids + rails. */
export default function LargePoster({ item, showMeta = false, progress, onClick }: Props) {
  let posterPath: string | null | undefined
  let year: number | string | undefined
  let subtitle: string | undefined
  const seriesBadge = isShow(item)

  if (isShow(item)) {
    const m = item.metadata as ShowMetadataInfo | undefined
    posterPath = m?.posterPath
    year = m?.firstAirDate?.slice(0, 4)
    const epCount = item.seasons.reduce((a, s) => a + s.episodeCount, 0)
    subtitle = `${item.seasons.length} season${item.seasons.length === 1 ? '' : 's'} · ${epCount} ep`
  } else {
    const m = item.metadata?.kind === 'movie' ? (item.metadata as MovieMetadata) : undefined
    posterPath = m?.posterPath
    year = item.year ?? m?.releaseDate?.slice(0, 4)
    const mins = runtimeMinutes(item)
    subtitle = mins === null ? undefined : `${mins}m`
  }

  const poster = tmdbImageUrl(posterPath, 'w342')
  const title = item.title

  return (
    <button
      onClick={onClick}
      aria-label={title}
      data-testid={seriesBadge ? 'show-card' : 'movie-card'}
    >
      {poster
        ? <img src={poster} alt="" width={180} height={270} loading="lazy" />
        : <span>No poster</span>}
      {seriesBadge && <span>Series</span>}
      {progress != null && progress > 0 && progress < 1 && (
        <progress max={1} value={progress} aria-label="Watch progress" />
      )}
      {showMeta && (
        <span>
          <span>{title}</span>
          <span>
            {year && <span>{year}</span>}
            {year && subtitle && <span> · </span>}
            {subtitle}
          </span>
        </span>
      )}
    </button>
  )
}
