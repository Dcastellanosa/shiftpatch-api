import type { AuthProvider, AuthSession } from './ports/auth-provider.js'
import type { DataStore } from './ports/data-store.js'
import { loadSessionPayload, type SessionPayload } from './session-payload.js'

export type SignInResult = { ok: true; session: AuthSession; payload: SessionPayload } | { ok: false }

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
  return { ok: true, session, payload: await loadSessionPayload({ store }, session.user, session.accessToken) }
}
