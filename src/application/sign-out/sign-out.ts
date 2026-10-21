import type { AuthProvider } from '../../domain/ports/auth-provider/auth-provider.js'

/** Best-effort revocation of the session that owns `accessToken`. */
export function signOut({ auth }: { auth: AuthProvider }, accessToken: string): Promise<void> {
  return auth.signOut(accessToken)
}
