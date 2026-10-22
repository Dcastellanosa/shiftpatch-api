import type { RequestHandler } from 'express'
import { AppError } from '../../errors/errors.js'

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Origin protection for browser traffic: unsafe requests from a browser must
 * come from an allowed frontend origin. Browsers always send `Origin` on
 * unsafe fetches; a browser request (identified by Sec-Fetch-* headers)
 * without one is rejected. Non-browser clients (curl, automated contract
 * checks) send neither header and are allowed through with their bearer token.
 */
export function requireTrustedOrigin(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (req, _res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next()

    const origin = req.get('origin')
    if (origin !== undefined) {
      if (allowedOrigins.has(origin)) return next()
      throw new AppError(403, 'Request origin is not allowed')
    }

    if (req.get('sec-fetch-site') !== undefined || req.get('sec-fetch-mode') !== undefined) {
      throw new AppError(403, 'Origin header is required')
    }

    next()
  }
}
