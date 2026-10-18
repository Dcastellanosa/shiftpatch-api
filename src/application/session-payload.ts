import type { AuthUser } from '../auth/auth-provider.js'
import type { SessionPayload } from '../auth/session-user.js'
import type { Profile } from '../data/data-store.js'

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
