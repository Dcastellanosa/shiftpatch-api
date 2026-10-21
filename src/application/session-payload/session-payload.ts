import type { AuthUser, Profile } from '../../domain/viewer/viewer.js'
import type { AppRole } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

/**
 * The only user shape this API returns to clients. Ids are public ids: a
 * nurse or admin is identified by their profile slug (`nurse-1`), an agency
 * user by the agency they manage (`agency-a`), as the contract reads.
 */
export interface SessionUser {
  id: string
  name: string | null
  email: string | null
  role: AppRole | null
  /** Public id of the first active agency (agency users). Prefer `agencyIds`. */
  agencyId: string | null
  /** Public ids of every agency the user manages through an active membership. */
  agencyIds: string[]
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
  const id = profile ? (profile.role === 'agency' ? (profile.agencySlug ?? profile.slug) : profile.slug) : user.id
  return {
    user: {
      id,
      name: profile?.fullName ?? null,
      email: user.email,
      role: profile?.role ?? null,
      agencyId: profile?.agencySlug ?? null,
      agencyIds: profile?.agencySlugs ?? [],
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
