import type { PasswordLinkType } from '../../domain/admin/admin.js'
import type { AuthAdmin } from '../../domain/ports/auth-admin/auth-admin.js'
import type { AuthSession } from '../../domain/ports/auth-provider/auth-provider.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import { loadSessionPayload, type SessionPayload } from '../session-payload/session-payload.js'

export type CompletePasswordFailure = 'invalid_link' | 'weak_password'

export type CompletePasswordResult =
  | { ok: true; session: AuthSession; payload: SessionPayload }
  | { ok: false; outcome: CompletePasswordFailure }

/**
 * Finishes an invitation or a password recovery: exchanges the one-time link
 * hash and sets the password. A session is produced only when the password
 * update succeeded, so callers can issue cookies exactly then.
 */
export async function completePassword(
  { auth, store }: { auth: AuthAdmin; store: DataStore | null },
  tokenHash: string,
  type: PasswordLinkType,
  password: string,
): Promise<CompletePasswordResult> {
  const result = await auth.completePassword(tokenHash, type, password)
  if (typeof result === 'string') return { ok: false, outcome: result }
  return { ok: true, session: result, payload: await loadSessionPayload({ store }, result.user, result.accessToken) }
}
