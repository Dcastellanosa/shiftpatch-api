import { createClient, isAuthApiError, type AuthError, type Session } from '@supabase/supabase-js'
import type { PasswordLinkType } from '../../../domain/admin/admin.js'
import type { AuthAdmin } from '../../../domain/ports/auth-admin/auth-admin.js'
import {
  AuthRateLimitedError,
  AuthUnavailableError,
  type AuthSession,
} from '../../../domain/ports/auth-provider/auth-provider.js'

interface SupabaseAuthAdminConfig {
  url: string
  publishableKey: string
  /** Server-only. Needed for invitations and user removal. */
  serviceRoleKey: string
}

const CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const

/**
 * Supabase Auth admin operations. The service-role client is used only for
 * the admin API; one-time-link exchanges use a throw-away publishable-key
 * client whose in-memory session never outlives the call. Provider error
 * objects are mapped to typed outcomes and never propagated or logged.
 */
export function createSupabaseAuthAdmin(config: SupabaseAuthAdminConfig): AuthAdmin {
  const admin = () => createClient(config.url, config.serviceRoleKey, CLIENT_OPTIONS).auth.admin
  const userClient = () => createClient(config.url, config.publishableKey, CLIENT_OPTIONS).auth

  return {
    async inviteUser(email, { fullName, redirectTo }) {
      const { data, error } = await admin().inviteUserByEmail(email, { data: { full_name: fullName }, redirectTo })
      if (error) {
        if (isAuthApiError(error) && (error.code === 'email_exists' || error.status === 422)) return 'email_exists'
        throw mapError(error)
      }
      return { id: data.user.id }
    },

    async deleteUser(userId) {
      const { error } = await admin().deleteUser(userId)
      if (error) throw mapError(error)
    },

    async completePassword(tokenHash, type: PasswordLinkType, password) {
      const auth = userClient()
      const verified = await auth.verifyOtp({ token_hash: tokenHash, type })
      if (verified.error || !verified.data.session) {
        if (
          verified.error &&
          isAuthApiError(verified.error) &&
          verified.error.status < 500 &&
          verified.error.status !== 429
        ) {
          return 'invalid_link'
        }
        throw verified.error ? mapError(verified.error) : new AuthUnavailableError()
      }

      const updated = await auth.updateUser({ password })
      if (updated.error) {
        // The link was consumed and a session minted; revoke it before reporting.
        await auth.signOut({ scope: 'local' }).catch(() => undefined)
        if (isAuthApiError(updated.error) && (updated.error.code === 'weak_password' || updated.error.status === 422)) {
          return 'weak_password'
        }
        throw mapError(updated.error)
      }
      return toAuthSession(verified.data.session)
    },

    async sendRecovery(email, redirectTo) {
      const { error } = await userClient().resetPasswordForEmail(email, { redirectTo })
      if (error) {
        // Unknown addresses and similar rejections stay silent (no enumeration).
        if (isAuthApiError(error) && error.status < 500 && error.status !== 429) return
        throw mapError(error)
      }
    },
  }
}

function mapError(error: AuthError): Error {
  return error.status === 429 ? new AuthRateLimitedError() : new AuthUnavailableError()
}

function toAuthSession(session: Session): AuthSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    user: { id: session.user.id, email: session.user.email ?? null },
  }
}
