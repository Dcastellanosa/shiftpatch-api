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
  /** Full name from the profile; falls back to the email, then the id, so it is never empty. */
  name: string
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

/** The contract's login payload: exactly `{ id, name, role }`. */
export interface SignInUser {
  id: string
  name: string
  role: AppRole | null
}

export interface SignInPayload {
  user: SignInUser
}

const publicId = (user: AuthUser, profile: Profile | null) =>
  profile ? (profile.role === 'agency' ? (profile.agencySlug ?? profile.slug) : profile.slug) : user.id

const displayName = (user: AuthUser, profile: Profile | null, id: string) => profile?.fullName ?? user.email ?? id

export function toSignInPayload(user: AuthUser, profile: Profile | null): SignInPayload {
  const id = publicId(user, profile)
  return { user: { id, name: displayName(user, profile, id), role: profile?.role ?? null } }
}

export async function loadSignInPayload(
  { store }: { store: DataStore | null },
  user: AuthUser,
  accessToken: string,
): Promise<SignInPayload> {
  return toSignInPayload(user, store ? await store.getProfile(accessToken, user.id) : null)
}

/**
 * Profile fields come from the `profiles` table keyed by the verified
 * `user.id`. A signed-in user without a provisioned profile gets nulls and
 * no access to business routes.
 */
export function toSessionPayload(user: AuthUser, profile: Profile | null): SessionPayload {
  const id = publicId(user, profile)
  return {
    user: {
      id,
      name: displayName(user, profile, id),
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
