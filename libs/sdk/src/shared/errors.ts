/**
 * Single source of truth for every error `code` the server can emit on the
 * wire (via `errorReply`/`sendNotFound`/… or `throw Object.assign(new Error(),
 * { code })`). Both the server and the SDK reference this object so a new code
 * cannot be introduced on one side without the other seeing it.
 *
 * Values are stable kebab-case strings — they are part of the API contract.
 */
export const ErrorCodes = {
  ACCOUNT_LOCKED: 'account-locked',
  AUDIO_TRACK_INVALID: 'audio-track-invalid',
  CALLER_FORBIDDEN: 'caller-forbidden',
  FETCH_FAILED: 'fetch-failed',
  FFMPEG_SPAWN_FAILED: 'ffmpeg-spawn-failed',
  IMAGE_NOT_FOUND: 'image-not-found',
  INVALID_CREDENTIALS: 'invalid-credentials',
  INVALID_INPUT: 'invalid-input',
  INVALID_PATH: 'invalid-path',
  INVALID_RECONNECT_TOKEN: 'invalid-reconnect-token',
  INVALID_SIZE: 'invalid-size',
  MAX_SESSIONS: 'max-sessions',
  MEDIA_NOT_FOUND: 'media-not-found',
  NAME_TAKEN: 'name-taken',
  NO_USER: 'no-user',
  NOT_FOUND: 'not-found',
  NOT_READY: 'not-ready',
  OWNER_EXISTS: 'owner-exists',
  OWNER_PROTECTED: 'owner-protected',
  PAIRING_EXPIRED: 'pairing-expired',
  PAIRING_NOT_FOUND: 'pairing-not-found',
  PASSWORD_REQUIRED: 'password-required',
  PROGRESS_NOT_FOUND: 'progress-not-found',
  RATE_LIMITED: 'rate-limited',
  ROLE_IMMUTABLE: 'role-immutable',
  SEEK_RESTART_FAILED: 'seek-restart-failed',
  SESSION_NOT_FOUND: 'session-not-found',
  TMDB_DISABLED: 'tmdb-disabled',
  TRANSCODE_FAILED: 'transcode-failed',
  UNAUTHORIZED: 'unauthorized',
  UNKNOWN_SCENARIO: 'unknown-scenario',
  USER_MISMATCH: 'user-mismatch',
  USER_NOT_FOUND: 'user-not-found',
  WEAK_PASSWORD: 'weak-password',
} as const

/** Every server-emitted error code, derived from {@link ErrorCodes}. */
export type ServerErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * Codes the client/SDK raises locally (never sent by the server) — e.g. a
 * playback session timing out attaching, or a probe failing in the browser.
 */
export type ClientErrorCode =
  | 'session-attach-timeout' | 'capabilities-unsupported' | 'file-read-error'
  | 'probe-failed' | 'session-destroyed' | 'network-error'

export type HorizonErrorCode = ServerErrorCode | ClientErrorCode

export interface HorizonError {
  code: HorizonErrorCode
  message: string
  fatal: boolean
}

export interface HorizonWarning {
  code: string
  message: string
}
