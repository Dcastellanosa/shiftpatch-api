import type { AuthUser } from '../../domain/viewer/viewer.js'
import type { TokenVerifier } from '../../domain/ports/token-verifier/token-verifier.js'

export interface AuthenticatedSession {
  user: AuthUser
  accessToken: string
}

/**
 * Verifies the bearer access token and resolves the subject it proves.
 * There is no refresh path: an expired token is simply rejected and the
 * client signs in again.
 */
export async function authenticate(
  { verifier }: { verifier: TokenVerifier },
  accessToken: string,
): Promise<AuthenticatedSession | null> {
  const user = await verifier.verify(accessToken)
  return user ? { user, accessToken } : null
}
