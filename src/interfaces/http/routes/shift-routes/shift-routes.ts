import { Router, type RequestHandler } from 'express'
import { cancelClaim, type CancelClaimFailure } from '../../../../application/cancel-claim/cancel-claim.js'
import { claimShift, type ClaimShiftFailure } from '../../../../application/claim-shift/claim-shift.js'
import { createShift, type CreateShiftFailure } from '../../../../application/create-shift/create-shift.js'
import { getShift } from '../../../../application/get-shift/get-shift.js'
import { getShiftHistory } from '../../../../application/get-shift-history/get-shift-history.js'
import { listAgencyShifts } from '../../../../application/list-agency-shifts/list-agency-shifts.js'
import { listBranches } from '../../../../application/list-branches/list-branches.js'
import { listMyShifts } from '../../../../application/list-my-shifts/list-my-shifts.js'
import { listShifts } from '../../../../application/list-shifts/list-shifts.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import type { CreateShiftInput } from '../../../../domain/shift/shift.js'
import {
  agencyShiftsParams,
  cancelBody,
  createShiftBody,
  listShiftsQuery,
  shiftIdParams,
  toContractShift,
  type CancelBody,
} from '../../schemas/shifts/shifts.js'
import { AppError } from '../../errors/errors.js'
import { parseInput, validateBody } from '../../middleware/validate/validate.js'
import { loadViewer, requireRole } from '../../middleware/viewer/viewer.js'

const shiftNotFound = () => new AppError(404, 'Shift not found')
const agencyInactive = () => new AppError(422, 'This agency is inactive, so its branches cannot take shifts')
const branchInactive = () => new AppError(422, 'This branch is inactive, so it cannot take shifts')
/** The contract's wording for every credential failure on a claim. */
const credentialRejected = () => new AppError(403, 'Credential expired, cannot claim shift')

/** Maps each non-success claim outcome to a safe HTTP error. */
const CLAIM_ERRORS: Record<ClaimShiftFailure, () => AppError> = {
  shift_not_found: shiftNotFound,
  not_a_nurse: () => new AppError(403, 'Only nurses can claim shifts'),
  shift_not_open: () => new AppError(409, 'This shift has already been claimed or is no longer open'),
  schedule_conflict: () => new AppError(409, 'You already have a claimed shift that overlaps this one'),
  agency_inactive: agencyInactive,
  branch_inactive: branchInactive,
  eligibility_inactive: () => new AppError(422, 'You are not active at this branch, so you cannot claim its shifts'),
  credential_missing: credentialRejected,
  credential_expired: credentialRejected,
  credential_revoked: credentialRejected,
}

const CREATE_ERRORS: Record<CreateShiftFailure, () => AppError> = {
  shift_not_found: shiftNotFound,
  actor_not_allowed: () => new AppError(403, 'You do not have permission to create shifts'),
  branch_not_found: () => new AppError(404, 'Branch not found'),
  branch_required: () => new AppError(400, 'Choose the branch this shift is for'),
  agency_inactive: agencyInactive,
  branch_inactive: branchInactive,
  invalid_time_range: () => new AppError(400, 'The shift must end after it starts'),
}

const CANCEL_ERRORS: Record<CancelClaimFailure, () => AppError> = {
  shift_not_found: shiftNotFound,
  actor_not_allowed: () => new AppError(403, 'Forbidden'),
  invalid_reason: () => new AppError(400, 'reason must be "no-show" or "advance"'),
  shift_not_claimed: () => new AppError(409, 'Shift is not filled'),
}

/**
 * Shift, branch and "my shifts" routes. Every route requires a session
 * (`authenticate`) and resolves the caller's role from the database. Single
 * shifts are returned bare; lists are wrapped, as the trial contract reads.
 */
export function createShiftRouter(store: DataStore | null, authenticate: RequestHandler[]) {
  const router = Router()
  const withViewer = [...authenticate, loadViewer(store)]

  router.get('/branches', ...withViewer, async (req, res) => {
    res.json({ branches: await listBranches({ store: store! }, req.viewer!) })
  })

  router.get('/shifts', ...withViewer, async (req, res) => {
    const filters = parseInput(listShiftsQuery, req.query, 'query')
    res.json({ shifts: (await listShifts({ store: store! }, req.viewer!, filters)).map(toContractShift) })
  })

  router.post(
    '/shifts',
    ...withViewer,
    requireRole('agency', 'admin'),
    validateBody(createShiftBody),
    async (req, res) => {
      const result = await createShift({ store: store! }, req.viewer!, req.body as CreateShiftInput)
      if (!result.ok) throw CREATE_ERRORS[result.outcome]()
      res.status(201).json(toContractShift(result.shift))
    },
  )

  router.get('/shifts/:shiftId', ...withViewer, async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const result = await getShift({ store: store! }, req.viewer!, shiftId)
    if (!result.ok) throw shiftNotFound()
    res.json(toContractShift(result.shift))
  })

  router.post('/shifts/:shiftId/claim', ...withViewer, requireRole('nurse'), async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const result = await claimShift({ store: store! }, req.viewer!, shiftId)
    if (!result.ok) throw CLAIM_ERRORS[result.outcome]()
    res.json(toContractShift(result.shift))
  })

  router.post('/shifts/:shiftId/cancel', ...withViewer, validateBody(cancelBody), async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const { reason } = req.body as CancelBody
    const result = await cancelClaim({ store: store! }, req.viewer!, shiftId, reason)
    if (!result.ok) throw CANCEL_ERRORS[result.outcome]()
    res.json({ ...toContractShift(result.shift), cancellation: result.cancellation })
  })

  router.get('/shifts/:shiftId/events', ...withViewer, async (req, res) => {
    const { shiftId } = parseInput(shiftIdParams, req.params, 'params')
    const result = await getShiftHistory({ store: store! }, req.viewer!, shiftId)
    if (!result.ok) throw shiftNotFound()
    res.json({ events: result.events })
  })

  router.get('/me/shifts', ...withViewer, requireRole('nurse'), async (req, res) => {
    const { upcoming, past } = await listMyShifts({ store: store! }, req.viewer!, Date.now())
    res.json({ upcoming: upcoming.map(toContractShift), past: past.map(toContractShift) })
  })

  router.get('/agencies/:agencyId/shifts', ...withViewer, async (req, res) => {
    const { agencyId } = parseInput(agencyShiftsParams, req.params, 'params')
    const filters = parseInput(listShiftsQuery, req.query, 'query')
    const result = await listAgencyShifts({ store: store! }, req.viewer!, agencyId, filters)
    if (!result.ok) throw new AppError(403, 'Forbidden')
    res.json({ agencyId: result.agencyId, shifts: result.shifts.map(toContractShift) })
  })

  return router
}
