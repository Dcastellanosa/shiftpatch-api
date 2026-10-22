import type { RequestHandler } from 'express'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import { resolveViewer, type ResolveViewerFailure } from '../../../../application/resolve-viewer/resolve-viewer.js'
import type { AppRole } from '../../../../domain/shift/shift.js'
import { AppError, unauthenticated } from '../../errors/errors.js'

export const dataUnavailable = () => new AppError(503, 'Data service is not available')

const VIEWER_ERRORS: Record<ResolveViewerFailure, () => AppError> = {
  profile_missing: () => new AppError(403, 'Your account has not been set up for ShiftPatch yet'),
  membership_inactive: () => new AppError(403, 'Your agency membership is not active'),
}

/** Resolves `req.viewer` from the validated session (`req.auth`) and the caller's own profile row. */
export function loadViewer(store: DataStore | null): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) throw unauthenticated()
    if (!store) throw dataUnavailable()

    const result = await resolveViewer({ store }, req.auth.user, req.auth.accessToken)
    if (!result.ok) throw VIEWER_ERRORS[result.outcome]()
    req.viewer = result.viewer
    next()
  }
}

export function requireRole(...roles: AppRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.viewer) throw unauthenticated()
    if (!roles.includes(req.viewer.role)) {
      throw new AppError(403, 'You do not have permission to perform this action')
    }
    next()
  }
}
