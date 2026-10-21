import type { AuthUser, Profile } from '../../domain/identity/identity.js'
import type { AppRole } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

/** The only user shape this API returns to clients. Never contains tokens. */
export interface SessionUser {
  id: string
  email: string | null
  fullName: string | null
  role: AppRole | null
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

/**
 * Builds the payload from the caller's own profile row when the data layer
 * is configured; otherwise profile fields stay null.
 */
export async function loadSessionPayload(
  { store }: { store: DataStore | null },
  user: AuthUser,
  accessToken: string,
): Promise<SessionPayload> {
  return toSessionPayload(user, store ? await store.getProfile(accessToken, user.id) : null)
}
