interface Props {
  size?: number
  withText?: boolean
}

/** Logo: accent-blue rounded square with a white L glyph. Pulled from Figma's
 *  Plex-Luuk frame — serves as the Horizon brand across every surface. */
export default function HorizonMark({ size = 40, withText = false }: Props) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.22,
          background: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 10px 40px var(--accent-glow)',
        }}
      >
        <svg viewBox="0 0 100 100" width={size * 0.6} height={size * 0.6} aria-hidden>
          <path d="M 22 18 L 22 82 L 78 82 L 78 66 L 38 66 L 38 18 Z" fill="#fff" />
        </svg>
      </div>
      {withText && (
        <span
          style={{
            fontWeight: 800,
            fontSize: size * 0.5,
            letterSpacing: '-0.02em',
            color: 'var(--text)',
          }}
        >
          Horizon
        </span>
      )}
    </div>
  )
}
