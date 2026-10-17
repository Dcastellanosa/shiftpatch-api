import { Router, type RequestHandler } from 'express'
import type { ClaimOutcome, CreateOutcome, DataStore } from '../data/data-store.js'
import { AppError } from '../http/errors.js'
import { parseInput, validateBody } from '../http/validate.js'
import { loadViewer, requireRole } from '../auth/viewer-middleware.js'
import {
  createShiftBody,
  listShiftsQuery,
  shiftIdParams,
  type CreateShiftInput,
  type Shift,
} from './contracts.js'

const shiftNotFound = () => new AppError(404, 'shift_not_found', 'Shift not found')

/** Maps each non-success claim outcome to a safe HTTP error. */
const CLAIM_ERRORS: Record<Exclude<ClaimOutcome, 'claimed'>, () => AppError> = {
  shift_not_found: shiftNotFound,
  not_a_nurse: () => new AppError(403, 'forbidden', 'Only nurses can claim shifts'),
  shift_not_open: () => new AppError(409, 'shift_not_open', 'This shift has already been claimed or is no longer open'),
  schedule_conflict: () =>
    new AppError(409, 'schedule_conflict', 'You already have a claimed shift that overlaps this one'),
  shift_started: () => new AppError(422, 'shift_started', 'This shift has already started'),
  eligibility_inactive: () =>
    new AppError(422, 'eligibility_inactive', 'You are not active at this branch, so you cannot claim its shifts'),
  credential_missing: () =>
    new AppError(422, 'credential_missing', 'A credential this branch requires is missing from your profile'),
  credential_expired: () =>
    new AppError(422, 'credential_expired', 'A credential this branch requires is expired or expires before the shift'),
  credential_revoked: () =>
    new AppError(422, 'credential_revoked', 'A credential this branch requires has been revoked'),
}

const CREATE_ERRORS: Record<Exclude<CreateOutcome, 'created'>, () => AppError> = {
  actor_not_allowed: () => new AppError(403, 'forbidden', 'You do not have permission to create shifts'),
  branch_not_found: () => new AppError(404, 'branch_not_found', 'Branch not found'),
  invalid_time_range: () => new AppError(400, 'validation_error', 'The shift must end after it starts'),
  shift_in_past: () => new AppError(422, 'shift_in_past', 'The shift must start in the future'),
}

/**
 * Shift, branch and "my shifts" routes. Every route requires a cookie session
 * (`authenticate`) and resolves the caller's role from the database.
 */
export function createShiftRouter(store: DataStore | null, authenticate: RequestHandler[]) {
  const router = Router()
  const withViewer = [...authenticate, loadViewer(store)]

  router.get('/branches', ...withViewer, async (req, res) => {
    res.json({ branches: await store!.listBranches(req.viewer!) })
  })

  router.get('/shifts', ...withViewer, async (req, res) => {
    const filters = parseInput(listShiftsQuery, req.query, 'query')
    if (filters.includeAssigned && req.viewer!.role !== 'nurse') {
      throw new AppError(400, 'validation_error', 'includeAssigned is only available to nurses')
    }
    res.json({ shifts: await store!.listShifts(req.viewer!, filters) })
  })

  router.post(
    '/shifts',
    ...withViewer,
    requireRole('agency', 'admin'),
    validateBody(createShiftBody),
    async (req, res) => {
      const viewer = req.viewer!
      const result = await store!.createShift(viewer.id, req.body as CreateShiftInput)
      if (result.outcome !== 'created') throw CREATE_ERRORS[result.outcome]()
      const shift = await store!.getShift(viewer, result.shiftId!)
      if (!shift) throw shiftNotFound()
      res.status(201).json({ shift })
    },
  )

  router.get('/shifts/:shiftId', ...withViewer, async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const shift = await store!.getShift(req.viewer!, shiftId)
    if (!shift) throw shiftNotFound()
    res.json({ shift })
  })

  router.post('/shifts/:shiftId/claim', ...withViewer, requireRole('nurse'), async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const viewer = req.viewer!
    // The database function locks the shift and performs every check and
    // write atomically; nothing is pre-checked here.
    const result = await store!.claimShift(viewer.id, shiftId)
    if (result.outcome !== 'claimed') throw CLAIM_ERRORS[result.outcome]()
    const shift = await store!.getShift(viewer, shiftId)
    if (!shift) throw shiftNotFound()
    res.json({ shift })
  })

  router.get('/shifts/:shiftId/events', ...withViewer, async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const viewer = req.viewer!
    const shift = await store!.getShift(viewer, shiftId)
    // Nurses see history only for shifts assigned to them.
    if (!shift || (viewer.role === 'nurse' && shift.assignedNurse?.id !== viewer.id)) {
      throw shiftNotFound()
    }
    res.json({ events: await store!.listShiftEvents(viewer, shiftId) })
  })

  router.get('/me/shifts', ...withViewer, requireRole('nurse'), async (req, res) => {
    const now = Date.now()
    const assigned = await store!.listAssignedShifts(req.viewer!)
    const upcoming: Shift[] = []
    const past: Shift[] = []
    for (const shift of assigned) {
      ;(new Date(shift.endsAt).getTime() > now ? upcoming : past).push(shift)
    }
    past.reverse()
    res.json({ upcoming, past })
  })

  return router
}
