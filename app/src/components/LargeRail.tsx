import type { ReactNode } from 'react'
import './LargeRail.css'

interface Props {
  title: string
  /** Defaults: 48px left/right padding to match page gutters. Pass 0 for edge-to-edge. */
  padX?: number
  children: ReactNode
}

/** Horizontal scroll rail with a big Nunito title + fake "See all" trailing
 *  link. Used for Continue Watching, Recently Added, etc. */
export default function LargeRail({ title, padX = 48, children }: Props) {
  return (
    <section className="rail">
      <div className="rail__head" style={{ padding: `0 ${padX}px` }}>
        <h2 className="rail__title">{title}</h2>
      </div>
      <div className="rail__strip no-scrollbar" style={{ padding: `8px ${padX}px` }}>
        {children}
      </div>
    </section>
  )
}
