import type { ReactNode } from 'react'

interface Props {
  title: string
  children: ReactNode
}

/** Horizontal rail with a title. Used for Continue Watching, Recently Added, etc. */
export default function LargeRail({ title, children }: Props) {
  return (
    <section>
      <h2>{title}</h2>
      <ul>
        {children}
      </ul>
    </section>
  )
}
