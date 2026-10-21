import { createClient, isAuthApiError, type AuthError, type Session, type User } from '@supabase/supabase-js'
import {
  AuthRateLimitedError,
  AuthUnavailableError,
  type AuthProvider,
  type AuthSession,
} from '../../../domain/ports/auth-provider/auth-provider.js'
import type { AuthUser } from '../../../domain/viewer/viewer.js'

interface SupabaseAuthConfig {
  url: string
  publishableKey: string
}

export function createSupabaseAuthProvider(config: SupabaseAuthConfig): AuthProvider {
  // A fresh client per operation: nothing is persisted or auto-refreshed in
  // process memory, so one user's session can never leak into another request.
  const client = () =>
    createClient(config.url, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }).auth

  return {
    async signInWithPassword(email, password) {
      const { data, error } = await client().signInWithPassword({ email, password })
      if (error) return rejectOrThrow(error)
      return toAuthSession(data.session)
    },

    async getUser(accessToken) {
      const { data, error } = await client().getUser(accessToken)
      if (error) return rejectOrThrow(error)
      return toAuthUser(data.user)
    },

    async refreshSession(refreshToken) {
      const { data, error } = await client().refreshSession({ refresh_token: refreshToken })
      if (error) return rejectOrThrow(error)
      return data.session ? toAuthSession(data.session) : null
    },

    async signOut(accessToken) {
      // Revokes the session via the user's own JWT; no service-role key needed.
      // Failures are ignored: cookies are cleared by the caller regardless.
      await client()
        .admin.signOut(accessToken, 'local')
        .catch(() => undefined)
    },
  }
}

/**
 * Maps a Supabase auth error to `null` (credentials/token rejected) or a typed
 * error. The original error object is deliberately not propagated or logged.
 */
function rejectOrThrow(error: AuthError): null {
  if (error.status === 429) throw new AuthRateLimitedError()
  if (isAuthApiError(error) && error.status >= 400 && error.status < 500) return null
  throw new AuthUnavailableError()
}

function toAuthUser(user: User): AuthUser {
  return { id: user.id, email: user.email ?? null }
}

function toAuthSession(session: Session): AuthSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    user: toAuthUser(session.user),
  }
}
