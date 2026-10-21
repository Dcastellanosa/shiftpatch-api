import type { AuthUser } from '../../domain/identity/identity.js'
import type { AuthProvider, AuthSession } from '../../domain/ports/auth-provider/auth-provider.js'

export interface SessionTokens {
  accessToken?: string | undefined
  refreshToken?: string | undefined
}

export interface AuthenticatedSession {
  user: AuthUser
  accessToken: string
  /** Set when the access token was rejected and the refresh token minted a new session. */
  refreshed: AuthSession | null
}

/**
 * Validates the access token with the provider, falling back to the refresh
 * token. Resolves to `null` when neither yields a session.
 */
export async function authenticate(
  { auth }: { auth: AuthProvider },
  { accessToken, refreshToken }: SessionTokens,
): Promise<AuthenticatedSession | null> {
  if (accessToken) {
    const user = await auth.getUser(accessToken)
    if (user) return { user, accessToken, refreshed: null }
  }
  if (refreshToken) {
    const session = await auth.refreshSession(refreshToken)
    if (session) return { user: session.user, accessToken: session.accessToken, refreshed: session }
  }
  return null
}
