import { Router, type RequestHandler } from 'express'
import { listAgencyNurses } from '../../../../application/list-agency-nurses/list-agency-nurses.js'
import {
  setNurseEligibility,
  type SetEligibilityFailure,
} from '../../../../application/set-nurse-eligibility/set-nurse-eligibility.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import { AppError } from '../../errors/errors.js'
import { parseInput } from '../../middleware/validate/validate.js'
import { loadViewer, requireRole } from '../../middleware/viewer/viewer.js'
import { eligibilityParams } from '../../schemas/eligibility/eligibility.js'

const ELIGIBILITY_ERRORS: Record<SetEligibilityFailure, () => AppError> = {
  actor_not_allowed: () => new AppError(403, 'forbidden', 'You do not have permission to manage nurse eligibility'),
  branch_not_found: () => new AppError(404, 'branch_not_found', 'Branch not found'),
  nurse_not_found: () => new AppError(404, 'nurse_not_found', 'Nurse not found'),
  agency_inactive: () => new AppError(422, 'agency_inactive', 'This agency is inactive; eligibility cannot change'),
  branch_inactive: () => new AppError(422, 'branch_inactive', 'This branch is inactive; eligibility cannot change'),
  eligibility_not_found: () => new AppError(404, 'nurse_not_found', 'Nurse not found'),
}

/**
 * Nurse eligibility management. Agency users act only within agencies where
 * they hold an active membership; admins anywhere. Cross-agency targets are
 * 404, never 403, so nothing is revealed about other agencies' data.
 */
export function createEligibilityRouter(store: DataStore | null, authenticate: RequestHandler[]) {
  const router = Router()
  const withViewer = [...authenticate, loadViewer(store)]

  router.get('/agency/nurses', ...withViewer, requireRole('agency'), async (req, res) => {
    res.json({ nurses: await listAgencyNurses({ store: store! }, req.viewer!) })
  })

  const set = (status: 'active' | 'suspended'): RequestHandler => async (req, res) => {
    const { nurseId, branchId } = parseInput(eligibilityParams, req.params, 'params')
    const result = await setNurseEligibility({ store: store! }, req.viewer!, nurseId, branchId, status)
    if (!result.ok) throw ELIGIBILITY_ERRORS[result.outcome]()
    res.json({ eligibility: result.eligibility })
  }

  router.put('/nurses/:nurseId/eligibility/:branchId', ...withViewer, requireRole('agency', 'admin'), set('active'))
  router.delete('/nurses/:nurseId/eligibility/:branchId', ...withViewer, requireRole('agency', 'admin'), set('suspended'))

  return router
}
