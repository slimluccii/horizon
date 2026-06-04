import { useEffect, useRef, useState } from 'react'
import './ActivityLogPanel.css'

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
    <div className="actlog">
      <div className="actlog__head">
        <span className={`actlog__dot ${stick ? 'is-live' : ''}`} />
        <span>{stick ? 'Live' : 'Paused (scroll to bottom to resume)'}</span>
        <span className="actlog__count">{lines.length} lines</span>
      </div>
      <div className="actlog__body" ref={boxRef} onScroll={onScroll}>
        {lines.length === 0
          ? <div className="actlog__empty">No activity yet.</div>
          : lines.map((l, i) => <div className="actlog__line" key={i}>{l}</div>)}
      </div>
    </div>
  )
}
