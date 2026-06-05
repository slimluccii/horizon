import { tmdbImageUrl } from '@horizon/sdk'
import type { ContinueWatchingItem, MovieMetadata, EpisodeMetadata, ShowMetadataInfo } from '@horizon/sdk'
import './LandscapeCard.css'

interface Props {
  item: ContinueWatchingItem
  width?: number
  onClick?: () => void
}

/** 16:9 card used on the Continue Watching rail. Shows backdrop or episode
 *  still + overlay gradient + progress bar + show/episode label. */
export default function LandscapeCard({ item, width = 300, onClick }: Props) {
  const height = width * 9 / 16
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

  return (
    <button className="lc" style={{ width }} onClick={onClick}>
      <div
        className="lc__art"
        style={{
          width, height,
          background: image ? `url(${image}) center/cover no-repeat, var(--surface)` : 'var(--surface)',
          borderRadius: Math.max(6, width * 0.018),
        }}
      >
        <div className="lc__gradient" />
        <div className="lc__info">
          <div className="lc__title">{title}</div>
          <div className="lc__sub">{sublineParts.join(' · ')}</div>
        </div>
        <div className="lc__progress">
          <div className="lc__progress-fill" style={{ width: `${item.percent}%` }} />
        </div>
      </div>
    </button>
  )
}
