interface Props {
  size?: number
  withText?: boolean
}

/** Logo mark: the Horizon L glyph, optionally with the wordmark. */
export default function HorizonMark({ size = 40, withText = false }: Props) {
  return (
    <span>
      <svg viewBox="0 0 100 100" width={size * 0.6} height={size * 0.6} aria-hidden="true">
        <path d="M 22 18 L 22 82 L 78 82 L 78 66 L 38 66 L 38 18 Z" fill="currentColor" />
      </svg>
      {withText && <span>Horizon</span>}
    </span>
  )
}
