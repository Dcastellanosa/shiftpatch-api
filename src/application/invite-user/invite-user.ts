import type { AdminUser, InviteUserCommand } from '../../domain/admin/admin.js'
import type { ProvisionOutcome } from '../../domain/outcomes/outcomes.js'
import type { AuthAdmin } from '../../domain/ports/auth-admin/auth-admin.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

export type InviteUserFailure = 'email_exists' | Exclude<ProvisionOutcome, 'provisioned'> | 'user_not_found'

export type InviteUserResult = { ok: true; user: AdminUser } | { ok: false; outcome: InviteUserFailure }

/**
 * Invites a user: creates the Auth account and sends the invitation, then
 * provisions the profile and its initial access in one database transaction.
 *
 * Invariant: a profile exists only if the Auth user exists and provisioning
 * succeeded. When provisioning fails after the invitation went out, the Auth
 * user is removed again (best effort). If that removal itself fails, the
 * leftover Auth user is inert: it has no profile, every business route
 * answers 403 profile_missing, it is never listed, and a repeated invitation
 * answers email_exists. Such an orphan is removed in the Supabase dashboard.
 */
export async function inviteUser(
  { store, auth }: { store: DataStore; auth: AuthAdmin },
  viewer: Viewer,
  command: InviteUserCommand,
  setPasswordUrl: string,
): Promise<InviteUserResult> {
  const invited = await auth.inviteUser(command.email, { fullName: command.fullName, redirectTo: setPasswordUrl })
  if (invited === 'email_exists') return { ok: false, outcome: 'email_exists' }

  const result = await store.provisionUser(viewer.id, invited.id, command)
  if (result.outcome !== 'provisioned') {
    // profile_exists means the provider re-sent an invitation to an account
    // that is already provisioned (not yet confirmed): nothing to undo.
    if (result.outcome !== 'profile_exists') await auth.deleteUser(invited.id).catch(() => undefined)
    return { ok: false, outcome: result.outcome }
  }

  const user = await store.getUser(viewer, invited.id)
  if (!user) return { ok: false, outcome: 'user_not_found' }
  return { ok: true, user }
}
