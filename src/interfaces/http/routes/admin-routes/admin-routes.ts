import { Router, type RequestHandler } from 'express'
import { createAgency, type CreateAgencyFailure } from '../../../../application/create-agency/create-agency.js'
import { createBranch, type CreateBranchFailure } from '../../../../application/create-branch/create-branch.js'
import { getAgency } from '../../../../application/get-agency/get-agency.js'
import { listAgencies } from '../../../../application/list-agencies/list-agencies.js'
import { updateAgency, type UpdateAgencyFailure } from '../../../../application/update-agency/update-agency.js'
import { updateBranch, type UpdateBranchFailure } from '../../../../application/update-branch/update-branch.js'
import type {
  CreateAgencyInput,
  CreateBranchInput,
  UpdateAgencyInput,
  UpdateBranchInput,
} from '../../../../domain/agency/agency.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import { AppError } from '../../errors/errors.js'
import { parseInput, validateBody } from '../../middleware/validate/validate.js'
import { loadViewer, requireRole } from '../../middleware/viewer/viewer.js'
import {
  agencyBranchParams,
  agencyIdParams,
  createAgencyBody,
  createBranchBody,
  updateAgencyBody,
  updateBranchBody,
} from '../../schemas/admin/admin.js'

const forbidden = () => new AppError(403, 'forbidden', 'You do not have permission to manage agencies')
const agencyNotFound = () => new AppError(404, 'agency_not_found', 'Agency not found')
const branchNotFound = () => new AppError(404, 'branch_not_found', 'Branch not found')
const nameTaken = (what: string) => () => new AppError(409, 'name_taken', `${what} with this name already exists`)
const agencyInactive = () =>
  new AppError(422, 'agency_inactive', 'This agency is inactive; activate it before adding branches')

const CREATE_AGENCY_ERRORS: Record<CreateAgencyFailure, () => AppError> = {
  actor_not_allowed: forbidden,
  name_taken: nameTaken('An agency'),
  agency_not_found: agencyNotFound,
}

const UPDATE_AGENCY_ERRORS: Record<UpdateAgencyFailure, () => AppError> = {
  actor_not_allowed: forbidden,
  agency_not_found: agencyNotFound,
  name_taken: nameTaken('An agency'),
}

const CREATE_BRANCH_ERRORS: Record<CreateBranchFailure, () => AppError> = {
  actor_not_allowed: forbidden,
  agency_not_found: agencyNotFound,
  agency_inactive: agencyInactive,
  name_taken: nameTaken('A branch of this agency'),
  branch_not_found: branchNotFound,
}

const UPDATE_BRANCH_ERRORS: Record<UpdateBranchFailure, () => AppError> = {
  actor_not_allowed: forbidden,
  branch_not_found: branchNotFound,
  name_taken: nameTaken('A branch of this agency'),
}

/**
 * Global-admin routes for agencies and their branches, mounted under
 * `/admin`. Every route needs a cookie session and an admin profile; the
 * database commands re-check the actor's role.
 */
export function createAdminRouter(store: DataStore | null, authenticate: RequestHandler[]) {
  const router = Router()
  const asAdmin = [...authenticate, loadViewer(store), requireRole('admin')]

  router.get('/agencies', ...asAdmin, async (req, res) => {
    res.json({ agencies: await listAgencies({ store: store! }, req.viewer!) })
  })

  router.post('/agencies', ...asAdmin, validateBody(createAgencyBody), async (req, res) => {
    const result = await createAgency({ store: store! }, req.viewer!, req.body as CreateAgencyInput)
    if (!result.ok) throw CREATE_AGENCY_ERRORS[result.outcome]()
    res.status(201).json({ agency: result.agency })
  })

  router.get('/agencies/:agencyId', ...asAdmin, async (req, res) => {
    const { agencyId } = parseInput(agencyIdParams, req.params, 'params')
    const result = await getAgency({ store: store! }, req.viewer!, agencyId)
    if (!result.ok) throw agencyNotFound()
    res.json(result.detail)
  })

  router.patch('/agencies/:agencyId', ...asAdmin, validateBody(updateAgencyBody), async (req, res) => {
    const { agencyId } = parseInput(agencyIdParams, req.params, 'params')
    const result = await updateAgency({ store: store! }, req.viewer!, agencyId, req.body as UpdateAgencyInput)
    if (!result.ok) throw UPDATE_AGENCY_ERRORS[result.outcome]()
    res.json({ agency: result.agency })
  })

  router.post('/agencies/:agencyId/branches', ...asAdmin, validateBody(createBranchBody), async (req, res) => {
    const { agencyId } = parseInput(agencyIdParams, req.params, 'params')
    const result = await createBranch({ store: store! }, req.viewer!, agencyId, req.body as CreateBranchInput)
    if (!result.ok) throw CREATE_BRANCH_ERRORS[result.outcome]()
    res.status(201).json({ branch: result.branch })
  })

  router.patch(
    '/agencies/:agencyId/branches/:branchId',
    ...asAdmin,
    validateBody(updateBranchBody),
    async (req, res) => {
      const { agencyId, branchId } = parseInput(agencyBranchParams, req.params, 'params')
      const result = await updateBranch({ store: store! }, req.viewer!, agencyId, branchId, req.body as UpdateBranchInput)
      if (!result.ok) throw UPDATE_BRANCH_ERRORS[result.outcome]()
      res.json({ branch: result.branch })
    },
  )

  return router
}
