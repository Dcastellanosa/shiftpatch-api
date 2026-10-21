import type { RequestHandler } from 'express'
import { authenticate } from '../../../../application/authenticate/authenticate.js'
import type { AuthProvider } from '../../../../domain/ports/auth-provider/auth-provider.js'
import { AppError, unauthenticated } from '../../errors/errors.js'
import {
  clearSessionCookies,
  readBearerToken,
  readSessionCookies,
  setSessionCookies,
  type SessionCookieConfig,
} from '../../session-cookies/session-cookies.js'

export const authUnavailable = () => new AppError(503, 'auth_unavailable', 'Authentication is not available')

/**
 * Resolves the session into `req.auth` from one of two credentials:
 *
 * - `Authorization: Bearer <access token>` for API clients. Validated as is;
 *   never refreshed, and cookies are neither read nor written for it. A
 *   present but rejected header is a 401, not a fall-back to cookies.
 * - Otherwise the server-managed cookies, validated and refreshed as needed.
 *
 * User IDs, roles, agency IDs or tokens in the body or query are never consulted.
 */
export function resolveSession(provider: AuthProvider | null, cookieConfig: SessionCookieConfig): RequestHandler {
  return async (req, res, next) => {
    const bearer = readBearerToken(req)
    if (bearer.present) {
      if (!bearer.accessToken) return next()
      if (!provider) throw authUnavailable()
      const session = await authenticate({ auth: provider }, { accessToken: bearer.accessToken })
      if (session) req.auth = { user: session.user, accessToken: session.accessToken }
      return next()
    }

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
