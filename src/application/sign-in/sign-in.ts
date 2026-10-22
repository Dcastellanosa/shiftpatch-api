import type { AuthProvider, AuthSession } from '../../domain/ports/auth-provider/auth-provider.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import { loadSignInPayload, type SignInPayload } from '../session-payload/session-payload.js'

export type SignInResult = { ok: true; session: AuthSession; payload: SignInPayload } | { ok: false }

/**
 * Signs in with email and password. Every rejection (unknown email, wrong
 * password, unconfirmed account) yields the same failure.
 */
export async function signIn(
  { auth, store }: { auth: AuthProvider; store: DataStore | null },
  email: string,
  password: string,
): Promise<SignInResult> {
  const session = await auth.signInWithPassword(email, password)
  if (!session) return { ok: false }
  return { ok: true, session, payload: await loadSignInPayload({ store }, session.user, session.accessToken) }
}
