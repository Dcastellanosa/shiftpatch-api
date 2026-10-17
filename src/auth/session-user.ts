import type { Profile } from '../data/data-store.js'
import type { AppRole } from '../shifts/contracts.js'
import type { AuthUser } from './auth-provider.js'

export type UserRole = AppRole

/** The only user shape this API returns to clients. Never contains tokens. */
export interface SessionUser {
  id: string
  email: string | null
  fullName: string | null
  role: UserRole | null
  agencyId: string | null
}

export interface SessionPayload {
  user: SessionUser
}

/**
 * Profile fields come from the `profiles` table keyed by the verified
 * `user.id`. A signed-in user without a provisioned profile gets nulls and
 * no access to business routes.
 */
export function toSessionPayload(user: AuthUser, profile: Profile | null): SessionPayload {
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: profile?.fullName ?? null,
      role: profile?.role ?? null,
      agencyId: profile?.agencyId ?? null,
    },
  }
}
