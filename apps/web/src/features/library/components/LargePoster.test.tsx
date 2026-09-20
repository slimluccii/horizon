import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MediaItem } from '@horizon/sdk'
import LargePoster from './LargePoster'

const movie: MediaItem = {
  id: 'm1',
  kind: 'movie',
  parentId: null,
  title: 'Dune',
  year: 2021,
  season: null,
  episode: null,
  episodeEnd: null,
  durationSec: 9300,
  resolution: '3840x2160',
  videoCodec: 'hevc',
  videoBitrate: null,
  container: 'matroska',
  hdr: null,
  audioTracks: null,
  subtitleTracks: null,
  externalIds: {},
  metadata: null,
}

describe('LargePoster', () => {
  it('shows the runtime of a movie in minutes', () => {
    render(<LargePoster item={movie} showMeta />)
    expect(screen.getByRole('button', { name: 'Dune' })).toHaveTextContent('2021 · 155m')
  })

  it('shows no runtime when the duration is unknown', () => {
    render(<LargePoster item={{ ...movie, durationSec: null }} showMeta />)
    const tile = screen.getByRole('button', { name: 'Dune' })
    expect(tile).toHaveTextContent('2021')
    expect(tile).not.toHaveTextContent('NaN')
    expect(tile).not.toHaveTextContent('·')
  })
})
