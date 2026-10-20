import type { AuthUser } from '../../identity/identity.js'

export interface AuthSession {
  accessToken: string
  refreshToken: string
  /** Access token lifetime in seconds. */
  expiresIn: number
  user: AuthUser
}

/**
 * Driven port: server-side authentication operations. Methods resolve to
 * `null` when the provider rejects the credentials or token, and throw
 * `AuthUnavailableError` or `AuthRateLimitedError` for conditions the caller
 * cannot fix.
 */
export interface AuthProvider {
  signInWithPassword(email: string, password: string): Promise<AuthSession | null>
  getUser(accessToken: string): Promise<AuthUser | null>
  refreshSession(refreshToken: string): Promise<AuthSession | null>
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
