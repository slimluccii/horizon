interface Props {
  name: IconName
  size?: number
  color?: string
}

export type IconName =
  | 'search' | 'x' | 'play' | 'pause' | 'plus' | 'check'
  | 'chevron-down' | 'chevron-right' | 'chevron-left' | 'back'
  | 'home' | 'grid' | 'user' | 'gear' | 'settings-slider'
  | 'volume' | 'cast' | 'subtitle' | 'skip-back' | 'skip-fwd'
  | 'plus-10' | 'minus-10' | 'fullscreen' | 'dot'
  | 'server' | 'tv' | 'film' | 'heart' | 'download' | 'share' | 'info'
  | 'shuffle' | 'library' | 'close' | 'audio'

/** Inline SVG icon library. Rebuilt from the Horizon design bundle so we don't
 *  ship an icon font. All strokes share 1.8 width + round caps for consistency. */
export default function Icon({ name, size = 16, color = '#fff' }: Props) {
  const s = { width: size, height: size, display: 'inline-block', flexShrink: 0 }
  const stroke = { stroke: color, strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

  switch (name) {
    case 'search':
      return <svg viewBox="0 0 16 16" style={s}><circle cx="7" cy="7" r="5.2" {...stroke} /><path d="M11 11 L14.5 14.5" {...stroke} /></svg>
    case 'x':
    case 'close':
      return <svg viewBox="0 0 16 16" style={s}><path d="M3 3 L13 13 M13 3 L3 13" {...stroke} /></svg>
    case 'play':
      return <svg viewBox="0 0 14 16" style={s}><path d="M1 1.7 v12.6 a1 1 0 0 0 1.5 .86 L13 8.86 a1 1 0 0 0 0 -1.72 L2.5 .84 A1 1 0 0 0 1 1.7 Z" fill={color} /></svg>
    case 'pause':
      return <svg viewBox="0 0 16 16" style={s}><rect x="3" y="2" width="3.5" height="12" rx="1" fill={color} /><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill={color} /></svg>
    case 'plus':
      return <svg viewBox="0 0 16 16" style={s}><path d="M8 2 v12 M2 8 h12" {...stroke} /></svg>
    case 'check':
      return <svg viewBox="0 0 16 16" style={s}><path d="M3 8.5 L6.5 12 L13 4.5" {...stroke} /></svg>
    case 'chevron-down':
      return <svg viewBox="0 0 16 16" style={s}><path d="M3.5 5.5 L8 10 L12.5 5.5" {...stroke} /></svg>
    case 'chevron-right':
      return <svg viewBox="0 0 16 16" style={s}><path d="M5.5 3.5 L10 8 L5.5 12.5" {...stroke} /></svg>
    case 'chevron-left':
      return <svg viewBox="0 0 16 16" style={s}><path d="M10.5 3.5 L6 8 L10.5 12.5" {...stroke} /></svg>
    case 'back':
      return <svg viewBox="0 0 16 16" style={s}><path d="M9.5 3 L4.5 8 L9.5 13" {...stroke} /></svg>
    case 'home':
      return <svg viewBox="0 0 16 16" style={s}><path d="M2 7.5 L8 2.5 L14 7.5 L14 13.5 h-3.5 v-4 h-3 v4 H2.5 Z" {...stroke} /></svg>
    case 'grid':
    case 'library':
      return <svg viewBox="0 0 16 16" style={s}><rect x="2" y="2" width="5" height="5" rx="0.5" {...stroke} /><rect x="9" y="2" width="5" height="5" rx="0.5" {...stroke} /><rect x="2" y="9" width="5" height="5" rx="0.5" {...stroke} /><rect x="9" y="9" width="5" height="5" rx="0.5" {...stroke} /></svg>
    case 'user':
      return <svg viewBox="0 0 16 16" style={s}><circle cx="8" cy="5.5" r="2.5" {...stroke} /><path d="M2.5 14 C 3 10.5 6 9.5 8 9.5 s 5 1 5.5 4.5" {...stroke} /></svg>
    case 'gear':
      return <svg viewBox="0 0 16 16" style={s}><circle cx="8" cy="8" r="2.2" {...stroke} /><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" {...stroke} /></svg>
    case 'settings-slider':
      return <svg viewBox="0 0 16 16" style={s}><path d="M2 4h9 M14 4h0.5 M2 8h2 M7 8h7.5 M2 12h10 M14 12h0.5" {...stroke} /><circle cx="12" cy="4" r="1.5" {...stroke} /><circle cx="5.5" cy="8" r="1.5" {...stroke} /><circle cx="13" cy="12" r="1.5" {...stroke} /></svg>
    case 'volume':
      return <svg viewBox="0 0 16 16" style={s}><path d="M1.5 6 v4 h2.5 L8 13 V3 L4 6 H1.5 Z" fill={color} /><path d="M10.5 5.5 C 12 6.5 12 9.5 10.5 10.5 M12.5 3.5 C 15.5 5.5 15.5 10.5 12.5 12.5" {...stroke} /></svg>
    case 'cast':
      return <svg viewBox="0 0 16 16" style={s}><path d="M1 3 h14 v9 h-5" {...stroke} /><path d="M1 7 a4 4 0 0 1 4 4 M1 10 a1.5 1.5 0 0 1 1.5 1.5" {...stroke} /><circle cx="1.5" cy="13" r="0.5" fill={color} /></svg>
    case 'subtitle':
      return <svg viewBox="0 0 16 16" style={s}><rect x="1.5" y="3" width="13" height="10" rx="1.5" {...stroke} /><path d="M4 8 h3 M9 8 h3 M4 11 h5 M10.5 11 h1.5" {...stroke} /></svg>
    case 'audio':
      return <svg viewBox="0 0 16 16" style={s}><path d="M1.5 6 v4 h2.5 L8 13 V3 L4 6 H1.5 Z" fill={color} /><path d="M10.5 5.5 C 12 6.5 12 9.5 10.5 10.5" {...stroke} /></svg>
    case 'skip-back':
      return <svg viewBox="0 0 16 16" style={s}><path d="M14 3 L6 8 L14 13 Z" fill={color} /><rect x="2" y="3" width="2" height="10" rx="0.5" fill={color} /></svg>
    case 'skip-fwd':
      return <svg viewBox="0 0 16 16" style={s}><path d="M2 3 L10 8 L2 13 Z" fill={color} /><rect x="12" y="3" width="2" height="10" rx="0.5" fill={color} /></svg>
    case 'fullscreen':
      return <svg viewBox="0 0 16 16" style={s}><path d="M2 5.5 V2.5 h3 M11 2.5 h3 v3 M14 10.5 v3 h-3 M5 13.5 H2 v-3" {...stroke} /></svg>
    case 'dot':
      return <svg viewBox="0 0 16 16" style={s}><circle cx="8" cy="8" r="2" fill={color} /></svg>
    case 'server':
      return <svg viewBox="0 0 16 16" style={s}><rect x="2" y="2.5" width="12" height="4" rx="1" {...stroke} /><rect x="2" y="9.5" width="12" height="4" rx="1" {...stroke} /><circle cx="5" cy="4.5" r="0.6" fill={color} /><circle cx="5" cy="11.5" r="0.6" fill={color} /></svg>
    case 'tv':
      return <svg viewBox="0 0 16 16" style={s}><rect x="1.5" y="3" width="13" height="9" rx="1" {...stroke} /><path d="M5.5 14.5 H10.5" {...stroke} /></svg>
    case 'film':
      return <svg viewBox="0 0 16 16" style={s}><rect x="2" y="2" width="12" height="12" rx="1" {...stroke} /><path d="M5 2 V14 M11 2 V14 M2 5 H5 M2 8 H5 M2 11 H5 M11 5 H14 M11 8 H14 M11 11 H14" {...stroke} /></svg>
    case 'heart':
      return <svg viewBox="0 0 16 16" style={s}><path d="M8 13.5 C 3 10 1.5 7 1.5 5 a 3 3 0 0 1 6.5 -1 a 3 3 0 0 1 6.5 1 C 14.5 7 13 10 8 13.5 Z" {...stroke} /></svg>
    case 'download':
      return <svg viewBox="0 0 16 16" style={s}><path d="M8 2 V10 M4 7 L8 11 L12 7 M2.5 13.5 H13.5" {...stroke} /></svg>
    case 'share':
      return <svg viewBox="0 0 16 16" style={s}><path d="M8 10 V2 M5 5 L8 2 L11 5 M2.5 9 V13 a1 1 0 0 0 1 1 h9 a1 1 0 0 0 1 -1 V9" {...stroke} /></svg>
    case 'info':
      return <svg viewBox="0 0 16 16" style={s}><circle cx="8" cy="8" r="6" {...stroke} /><path d="M8 7 V11.5 M8 4.8 V5.2" {...stroke} /></svg>
    case 'shuffle':
      return <svg viewBox="0 0 16 16" style={s}><path d="M1.5 4 h3 L12 12 h2.5 M1.5 12 h3 L7 9.5 M9 6.5 L12 4 h2.5 M12.5 2 L14.5 4 L12.5 6 M12.5 10 L14.5 12 L12.5 14" {...stroke} /></svg>
    default:
      return null
  }
}
