/**
 * TranscodeError — raised at the spawn-error boundary in the
 * PlaybackOrchestrator. Carries a stable `code` plus the tail of ffmpeg's
 * stderr (when available) so the failure can be diagnosed post-mortem from
 * a single log line. Routes already inspect `.code` on thrown errors, so this
 * stays backward compatible.
 *
 * See CONTEXT.md → PlaybackOrchestrator / Session.
 */
export class TranscodeError extends Error {
  constructor(
    public code: string,
    message: string,
    public stderrTail: string = '',
  ) {
    super(message)
    this.name = 'TranscodeError'
  }
}
