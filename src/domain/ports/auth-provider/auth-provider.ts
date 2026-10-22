import type { AuthUser } from '../../viewer/viewer.js'

export interface AuthSession {
  accessToken: string
  refreshToken: string
  /** Access token lifetime in seconds. */
  expiresIn: number
  user: AuthUser
}

/**
 * Driven port: password sign-in and sign-out at the identity provider.
 * `signInWithPassword` resolves to `null` when the credentials are rejected,
 * and throws `AuthUnavailableError` or `AuthRateLimitedError` for conditions
 * the caller cannot fix. Token validation is the `TokenVerifier` port.
 */
export interface AuthProvider {
  signInWithPassword(email: string, password: string): Promise<AuthSession | null>
  /** Best-effort revocation of the session that owns `accessToken`. */
  signOut(accessToken: string): Promise<void>
}

export class AuthUnavailableError extends Error {
  constructor() {
    super('Authentication service unavailable')
    this.name = 'AuthUnavailableError'
  }
}

export class AuthRateLimitedError extends Error {
  constructor() {
    super('Too many authentication attempts')
    this.name = 'AuthRateLimitedError'
  }
}
