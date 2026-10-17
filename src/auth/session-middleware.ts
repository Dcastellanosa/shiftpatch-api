import type { RequestHandler } from 'express'
import { AppError, unauthenticated } from '../http/errors.js'
import type { AuthProvider } from './auth-provider.js'
import {
  clearSessionCookies,
  readSessionCookies,
  setSessionCookies,
  type SessionCookieConfig,
} from './session-cookies.js'

export const authUnavailable = () =>
  new AppError(503, 'auth_unavailable', 'Authentication is not available')

/**
 * Resolves the cookie-backed session into `req.auth`.
 *
 * Identity comes only from server-managed cookies validated against Supabase.
 * User IDs, roles, agency IDs or tokens in the body, query or headers are
 * never consulted.
 */
export function resolveSession(
  provider: AuthProvider | null,
  cookieConfig: SessionCookieConfig,
): RequestHandler {
  return async (req, res, next) => {
    const { accessToken, refreshToken, malformed } = readSessionCookies(req, cookieConfig)

    if (!accessToken && !refreshToken) {
      if (malformed) clearSessionCookies(res, cookieConfig)
      return next()
    }
    if (!provider) throw authUnavailable()

    if (accessToken) {
      const user = await provider.getUser(accessToken)
      if (user) {
        req.auth = { user, accessToken }
        return next()
      }
    }

    if (refreshToken) {
      const session = await provider.refreshSession(refreshToken)
      if (session) {
        setSessionCookies(res, session, cookieConfig)
        req.auth = { user: session.user, accessToken: session.accessToken }
        return next()
      }
    }

    clearSessionCookies(res, cookieConfig)
    next()
  }
}

export const requireSession: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthenticated()
  next()
}
