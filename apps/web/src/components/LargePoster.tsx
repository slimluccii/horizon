import { tmdbImageUrl } from '@horizon/sdk'
import type { MediaItem, ShowSummary, MovieMetadata, ShowMetadataInfo } from '@horizon/sdk'
import './LargePoster.css'

interface Props {
  item: MediaItem | ShowSummary
  width?: number
  showMeta?: boolean
  progress?: number   // 0..1; draws bottom progress bar
  onClick?: () => void
}

function isShow(item: MediaItem | ShowSummary): item is ShowSummary {
  return (item as ShowSummary).seasons !== undefined
}

/** 2:3 poster tile. Used in library grids + rails. Hover lifts + glows. */
export default function LargePoster({ item, width = 180, showMeta = false, progress, onClick }: Props) {
  const height = width * 1.5

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
    const mins = Math.round(item.duration / 60)
    subtitle = `${mins}m`
  }

  const poster = tmdbImageUrl(posterPath, 'w342')
  const title = item.title

  return (
    <button
      className="poster"
      style={{ width }}
      onClick={onClick}
      aria-label={title}
      data-testid={seriesBadge ? 'show-card' : 'movie-card'}
    >
      <div
        className="poster__art"
        style={{
          width, height,
          background: poster ? `url(${poster}) center/cover no-repeat, var(--surface)` : 'var(--surface)',
          borderRadius: Math.max(6, width * 0.05),
        }}
      >
        {seriesBadge && <div className="poster__badge">Series</div>}
        {!poster && <div className="poster__nopo">No poster</div>}
        {progress != null && progress > 0 && progress < 1 && (
          <div className="poster__progress">
            <div className="poster__progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>
      {showMeta && (
        <div className="poster__meta">
          <div className="poster__title">{title}</div>
          <div className="poster__sub">
            {year && <span>{year}</span>}
            {year && subtitle && <span className="poster__sep"> · </span>}
            {subtitle}
          </div>
        </div>
      )}
    </button>
  )
}
