import type { RequestHandler } from 'express'
import { AppError } from '../../errors/errors.js'

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * CSRF protection for cookie authentication: unsafe requests must come from an
 * allowed frontend origin. Browsers always send `Origin` on unsafe fetches;
 * a browser request (identified by Sec-Fetch-* headers) without one is
 * rejected. Non-browser clients without `Origin` cannot carry a victim's
 * cookies and are allowed through.
 */
export function requireTrustedOrigin(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (req, _res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next()

    const origin = req.get('origin')
    if (origin !== undefined) {
      if (allowedOrigins.has(origin)) return next()
      throw new AppError(403, 'invalid_origin', 'Request origin is not allowed')
    }

    if (req.get('sec-fetch-site') !== undefined || req.get('sec-fetch-mode') !== undefined) {
      throw new AppError(403, 'origin_required', 'Origin header is required')
    }

    next()
  }
}
