import type { Preferences } from './preferences.ts'

export interface User {
  id: string
  name: string
  avatar: string | null
  preferences: Preferences
  role: 'owner' | 'admin' | 'member'
  /** Whether this user has a password set. False until first-set (e.g. the
   *  migrated owner before completing the forced set-password step). */
  hasPassword: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Result of a successful `auth.login` (and the self-service branch of
 * `auth.setPassword` / `auth.pairPoll`). The server sets the httpOnly
 * `hz_session` cookie for the web AND returns the raw token once for native
 * clients to persist and send as `Authorization: Bearer`.
 */
export interface AuthSession {
  token: string
  user: User
  /** True for the head of a household with more than one profile, who may set this device up for everyone. */
  canShareDevice?: boolean
}

export type DeviceMode = 'personal' | 'shared'

export interface ProfileSummary {
  id: string
  name: string
  avatar: string | null
}

/** What this device is, as the server sees it. */
export interface DeviceSession {
  /** Who logged in on this device. */
  principal: User
  /** The profile that is being used right now; the principal unless another one was picked. */
  profile: User
  /** The role this session really has. A shared device is always `member`. */
  role: User['role']
  shared: boolean
  /** True when the person who logged in may set this device up for their whole household. */
  canShare: boolean
  /** Every profile that can be picked on this device. */
  profiles: ProfileSummary[]
}

/** Result of `auth.setPassword`: a self-change re-issues a session (token +
 *  user), while an owner/admin reset of another user returns neither. */
export type SetPasswordResult = AuthSession | Record<string, never>

/** Result of `auth.pairStart`: the short-lived code the TV displays + its
 *  absolute expiry (epoch ms). */
export interface PairStartResult {
  code: string
  expiresAt: number
}

/** Result of `auth.pairPoll`: `pending` until the code is approved, then the
 *  issued session exactly once. */
export type PairPollResult = { status: 'pending' } | AuthSession
