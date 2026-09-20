import { useEffect, useRef, useState } from 'react'

/** Live raw activity log. Auto-scrolls to the bottom unless the user scrolls up. */
export default function ActivityLogPanel({ lines }: { lines: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)

  useEffect(() => {
    if (stick && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, stick])

  function onScroll() {
    const el = boxRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setStick(atBottom)
  }

  return (
    <section aria-label="Activity log">
      <p role="status">
        <span>{stick ? 'Live' : 'Paused (scroll to bottom to resume)'}</span>
        {' · '}
        <span>{lines.length} lines</span>
      </p>
      <div ref={boxRef} onScroll={onScroll}>
        {lines.length === 0
          ? <p>No activity yet.</p>
          : <ol>{lines.map((l, i) => <li key={i}>{l}</li>)}</ol>}
      </div>
    </section>
  )
}
