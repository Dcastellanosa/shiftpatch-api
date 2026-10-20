import type { RequestHandler } from 'express'
import type { DataStore } from '../../application/ports/data-store.js'
import { resolveViewer, type ResolveViewerFailure } from '../../application/resolve-viewer.js'
import type { AppRole } from '../../domain/shift.js'
import { AppError, unauthenticated } from './errors.js'

export const dataUnavailable = () =>
  new AppError(503, 'data_unavailable', 'Data service is not available')

const VIEWER_ERRORS: Record<ResolveViewerFailure, () => AppError> = {
  profile_missing: () => new AppError(403, 'profile_missing', 'Your account has not been set up for ShiftPatch yet'),
  membership_inactive: () => new AppError(403, 'membership_inactive', 'Your agency membership is not active'),
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
      throw new AppError(403, 'forbidden', 'You do not have permission to perform this action')
    }
    next()
  }
}
