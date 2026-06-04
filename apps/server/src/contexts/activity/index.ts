// Activity context — public surface.
// Live activity event bus + SSE stream adapter.
export { createActivityBus, type ActivityBus } from './infrastructure/bus.ts'
export { streamActivity, sseFrame, type SseSink, type CloseSignal, type StreamTimers } from './infrastructure/http/stream.ts'
