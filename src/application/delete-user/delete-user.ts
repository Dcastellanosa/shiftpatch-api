import type { DeleteUserOutcome } from '../../domain/outcomes/outcomes.js'
import type { AuthAdmin } from '../../domain/ports/auth-admin/auth-admin.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

export type DeleteUserFailure = Exclude<DeleteUserOutcome, 'deleted'>

export type DeleteUserResult = { ok: true } | { ok: false; outcome: DeleteUserFailure }

/**
 * Removes an account: first the profile and its access records through the
 * database command (which refuses users with shifts or recorded actions, and
 * self-deletion), then the Auth user. The Auth user is removed only after the
 * profile was ours and is gone, so an account of another application sharing
 * the Auth project can never be touched.
 */
export async function deleteUser(
  { store, auth }: { store: DataStore; auth: AuthAdmin },
  viewer: Viewer,
  userId: string,
): Promise<DeleteUserResult> {
  const result = await store.deleteUser(viewer.id, userId)
  if (result.outcome !== 'deleted') return { ok: false, outcome: result.outcome }
  // The command reports the Auth user's UUID; the public id is not an Auth id.
  await auth.deleteUser(result.entityId ?? userId)
  return { ok: true }
}
