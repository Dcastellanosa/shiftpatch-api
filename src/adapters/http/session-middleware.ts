import type { RequestHandler } from 'express'
import { authenticate } from '../../application/authenticate.js'
import type { AuthProvider } from '../../application/ports/auth-provider.js'
import { AppError, unauthenticated } from './errors.js'
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
 * Identity comes only from server-managed cookies validated by the auth
 * provider. User IDs, roles, agency IDs or tokens in the body, query or
 * headers are never consulted.
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

    const session = await authenticate({ auth: provider }, { accessToken, refreshToken })
    if (!session) {
      clearSessionCookies(res, cookieConfig)
      return next()
    }
    if (session.refreshed) setSessionCookies(res, session.refreshed, cookieConfig)
    req.auth = { user: session.user, accessToken: session.accessToken }
    next()
  }
}

export const requireSession: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthenticated()
  next()
}
