import type { RequestHandler } from 'express'
import type { DataStore } from '../data/data-store.js'
import { AppError, unauthenticated } from '../http/errors.js'
import type { AppRole } from '../shifts/contracts.js'

export const dataUnavailable = () =>
  new AppError(503, 'data_unavailable', 'Data service is not available')

/**
 * Resolves `req.viewer` from the validated session (`req.auth`) and the
 * caller's own profile row. Role and agency come only from the database,
 * never from the request.
 */
export function loadViewer(store: DataStore | null): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) throw unauthenticated()
    if (!store) throw dataUnavailable()

    const profile = await store.getProfile(req.auth.accessToken, req.auth.user.id)
    if (!profile) {
      throw new AppError(403, 'profile_missing', 'Your account has not been set up for ShiftPatch yet')
    }
    if (profile.role === 'agency' && !profile.agencyId) {
      throw new AppError(403, 'membership_inactive', 'Your agency membership is not active')
    }
    req.viewer = { ...profile, accessToken: req.auth.accessToken }
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
