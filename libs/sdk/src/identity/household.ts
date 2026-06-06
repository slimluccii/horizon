import type { User } from './user.ts'

/** A household with its members, as returned by GET /households/me. */
export interface HouseholdView {
  id: string
  name: string
  ownerUserId: string | null
  members: User[]
}

export type InviteKind = 'join' | 'new_household'

/** Result of POST /invites — a short-lived, single-use code. */
export interface InviteResult {
  code: string
  expiresAt: number
}
