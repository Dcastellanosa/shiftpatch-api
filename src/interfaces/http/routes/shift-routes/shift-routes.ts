import { Router, type RequestHandler } from 'express'
import { claimShift, type ClaimShiftFailure } from '../../../../application/claim-shift/claim-shift.js'
import { createShift, type CreateShiftFailure } from '../../../../application/create-shift/create-shift.js'
import { getShift } from '../../../../application/get-shift/get-shift.js'
import { getShiftHistory } from '../../../../application/get-shift-history/get-shift-history.js'
import { listBranches } from '../../../../application/list-branches/list-branches.js'
import { listMyShifts } from '../../../../application/list-my-shifts/list-my-shifts.js'
import { listShifts } from '../../../../application/list-shifts/list-shifts.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import type { CreateShiftInput } from '../../../../domain/shift/shift.js'
import { createShiftBody, listShiftsQuery, shiftIdParams } from '../../schemas/shifts/shifts.js'
import { AppError } from '../../errors/errors.js'
import { parseInput, validateBody } from '../../middleware/validate/validate.js'
import { loadViewer, requireRole } from '../../middleware/viewer/viewer.js'

const shiftNotFound = () => new AppError(404, 'shift_not_found', 'Shift not found')

/** Maps each non-success claim outcome to a safe HTTP error. */
const CLAIM_ERRORS: Record<ClaimShiftFailure, () => AppError> = {
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

const CREATE_ERRORS: Record<CreateShiftFailure, () => AppError> = {
  shift_not_found: shiftNotFound,
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
    res.json({ branches: await listBranches({ store: store! }, req.viewer!) })
  })

  router.get('/shifts', ...withViewer, async (req, res) => {
    const filters = parseInput(listShiftsQuery, req.query, 'query')
    const result = await listShifts({ store: store! }, req.viewer!, filters)
    if (!result.ok) throw new AppError(400, 'validation_error', 'includeAssigned is only available to nurses')
    res.json({ shifts: result.shifts })
  })

  router.post(
    '/shifts',
    ...withViewer,
    requireRole('agency', 'admin'),
    validateBody(createShiftBody),
    async (req, res) => {
      const result = await createShift({ store: store! }, req.viewer!, req.body as CreateShiftInput)
      if (!result.ok) throw CREATE_ERRORS[result.outcome]()
      res.status(201).json({ shift: result.shift })
    },
  )

  router.get('/shifts/:shiftId', ...withViewer, async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const result = await getShift({ store: store! }, req.viewer!, shiftId)
    if (!result.ok) throw shiftNotFound()
    res.json({ shift: result.shift })
  })

  router.post('/shifts/:shiftId/claim', ...withViewer, requireRole('nurse'), async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const result = await claimShift({ store: store! }, req.viewer!, shiftId)
    if (!result.ok) throw CLAIM_ERRORS[result.outcome]()
    res.json({ shift: result.shift })
  })

  router.get('/shifts/:shiftId/events', ...withViewer, async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const result = await getShiftHistory({ store: store! }, req.viewer!, shiftId)
    if (!result.ok) throw shiftNotFound()
    res.json({ events: result.events })
  })

  router.get('/me/shifts', ...withViewer, requireRole('nurse'), async (req, res) => {
    res.json(await listMyShifts({ store: store! }, req.viewer!, Date.now()))
  })

  return router
}
