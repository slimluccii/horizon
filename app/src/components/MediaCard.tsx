import { useNavigate } from 'react-router-dom'
import type { MediaItem } from '@horizon/sdk'

interface Props { item: MediaItem; subtitle?: string }

export default function MediaCard({ item, subtitle }: Props) {
  const navigate = useNavigate()
  const [w, h] = (item.resolution ?? '').split('x')
  const res = parseInt(h) >= 2160 ? '4K' : parseInt(h) >= 1080 ? '1080p' : '720p'
  const hdrBadge = item.hdr?.dv ? 'DV' : item.hdr?.hdr10 ? 'HDR10' : null

  return (
    <div
      data-testid="movie-card"
      onClick={() => navigate(`/play/${item.id}`)}
      style={{
        cursor: 'pointer', background: '#1a1a1a', borderRadius: 8,
        padding: 16, display: 'flex', flexDirection: 'column', gap: 8,
        border: '1px solid #2a2a2a', transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = '#555')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a2a2a')}
    >
      <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.3 }}>
        {item.title}{item.year ? ` (${item.year})` : ''}
      </div>
      {subtitle && <div style={{ fontSize: 12, color: '#888' }}>{subtitle}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        <Badge>{res}</Badge>
        {hdrBadge && <Badge color="#8b5cf6">{hdrBadge}</Badge>}
        <Badge>{item.videoCodec?.toUpperCase()}</Badge>
        {item.audioTracks?.[0] && <Badge>{item.audioTracks[0].codec.toUpperCase()}</Badge>}
      </div>
    </div>
  )
}

function Badge({ children, color = '#333' }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      background: color, borderRadius: 4, padding: '2px 6px',
      fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
    }}>
      {children}
    </span>
  )
}
