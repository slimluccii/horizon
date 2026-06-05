import { useEffect, useReducer } from 'react'
import { activityReducer, initialActivityState, ACTIVITY_STREAM_PATH, parseActivityFrame } from '@horizon/sdk'

/** Subscribe to the server activity SSE stream. Returns the folded live state.
 *  `enabled` lets callers open the stream only while the panel is mounted. */
export function useActivityStream(enabled = true) {
  const [state, dispatch] = useReducer(activityReducer, initialActivityState)

  useEffect(() => {
    if (!enabled) return
    const es = new EventSource(ACTIVITY_STREAM_PATH, { withCredentials: true })
    es.onmessage = (e) => {
      const evt = parseActivityFrame(e.data)
      if (evt) dispatch(evt)   // drop malformed frames silently
    }
    // EventSource auto-reconnects on error; nothing to do here but keep it open.
    return () => es.close()
  }, [enabled])

  return state
}
