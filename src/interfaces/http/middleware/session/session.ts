import type { RequestHandler } from 'express'
import { authenticate } from '../../../../application/authenticate/authenticate.js'
import type { TokenVerifier } from '../../../../domain/ports/token-verifier/token-verifier.js'
import { AppError, invalidToken, unauthenticated } from '../../errors/errors.js'
import { readBearer } from '../../bearer/bearer.js'

export const authUnavailable = () => new AppError(503, 'Authentication is not available')

/**
 * Resolves `req.auth` from `Authorization: Bearer <access token>`, the only
 * credential this API accepts. A missing header leaves the request anonymous
 * (`requireSession` then answers 401); a malformed or rejected token is a 401
 * on the spot. Nothing is ever read from cookies, the body or the query.
 */
export function resolveSession(verifier: TokenVerifier | null): RequestHandler {
  return async (req, _res, next) => {
    const bearer = readBearer(req)
    if (bearer.kind === 'missing') return next()
    if (bearer.kind === 'malformed') throw invalidToken()
    if (!verifier) throw authUnavailable()

    const session = await authenticate({ verifier }, bearer.token)
    if (!session) throw invalidToken()
    req.auth = { user: session.user, accessToken: session.accessToken }
    next()
  }
}

export const requireSession: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthenticated()
  next()
}
