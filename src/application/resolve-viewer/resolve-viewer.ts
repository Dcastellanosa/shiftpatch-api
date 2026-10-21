import type { AuthUser, Viewer } from '../../domain/identity/identity.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

export type ResolveViewerFailure = 'profile_missing' | 'membership_inactive'

export type ResolveViewerResult = { ok: true; viewer: Viewer } | { ok: false; outcome: ResolveViewerFailure }

/**
 * Builds the viewer from the verified user and the caller's own profile row.
 * Role and agency come only from the database, never from the request.
 */
export async function resolveViewer(
  { store }: { store: DataStore },
  user: AuthUser,
  accessToken: string,
): Promise<ResolveViewerResult> {
  const profile = await store.getProfile(accessToken, user.id)
  if (!profile) return { ok: false, outcome: 'profile_missing' }
  if (profile.role === 'agency' && !profile.agencyId) return { ok: false, outcome: 'membership_inactive' }
  return { ok: true, viewer: { ...profile, accessToken } }
}
