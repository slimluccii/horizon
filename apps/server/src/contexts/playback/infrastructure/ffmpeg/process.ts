import type { ChildProcess } from 'node:child_process'

// `proc.killed` only says a signal was sent (SIGSTOP included), not that the process died.
export function isRunning(proc: ChildProcess | undefined): proc is ChildProcess {
  return !!proc && proc.exitCode === null && proc.signalCode === null
}
