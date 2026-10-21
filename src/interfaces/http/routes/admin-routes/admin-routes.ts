import { Router, type RequestHandler } from 'express'
import { createAgency, type CreateAgencyFailure } from '../../../../application/create-agency/create-agency.js'
import { createBranch, type CreateBranchFailure } from '../../../../application/create-branch/create-branch.js'
import { deleteAgency, type DeleteAgencyFailure } from '../../../../application/delete-agency/delete-agency.js'
import { deleteUser, type DeleteUserFailure } from '../../../../application/delete-user/delete-user.js'
import { getAgency } from '../../../../application/get-agency/get-agency.js'
import { inviteUser, type InviteUserFailure } from '../../../../application/invite-user/invite-user.js'
import { listAgencies } from '../../../../application/list-agencies/list-agencies.js'
import { listUsers } from '../../../../application/list-users/list-users.js'
import { updateAgency, type UpdateAgencyFailure } from '../../../../application/update-agency/update-agency.js'
import { updateBranch, type UpdateBranchFailure } from '../../../../application/update-branch/update-branch.js'
import type {
  CreateAgencyInput,
  CreateBranchInput,
  UpdateAgencyInput,
  UpdateBranchInput,
} from '../../../../domain/agency/agency.js'
import type { InviteUserCommand } from '../../../../domain/admin/admin.js'
import type { AuthAdmin } from '../../../../domain/ports/auth-admin/auth-admin.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import { AppError } from '../../errors/errors.js'
import { authUnavailable } from '../../middleware/session/session.js'
import { parseInput, validateBody } from '../../middleware/validate/validate.js'
import { loadViewer, requireRole } from '../../middleware/viewer/viewer.js'
import {
  agencyBranchParams,
  agencyIdParams,
  createAgencyBody,
  createBranchBody,
  inviteUserBody,
  updateAgencyBody,
  updateBranchBody,
  userIdParams,
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

const DELETE_AGENCY_ERRORS: Record<DeleteAgencyFailure, () => AppError> = {
  actor_not_allowed: forbidden,
  agency_not_found: agencyNotFound,
  agency_has_shifts: () => new AppError(409, 'agency_has_shifts', 'This agency has shifts and cannot be deleted; deactivate it instead'),
}

const DELETE_USER_ERRORS: Record<DeleteUserFailure, () => AppError> = {
  actor_not_allowed: forbidden,
  user_not_found: () => new AppError(404, 'user_not_found', 'User not found'),
  self_delete: () => new AppError(409, 'cannot_delete_self', 'You cannot delete your own account'),
  user_has_history: () => new AppError(409, 'user_has_history', 'This user has shifts or recorded actions and cannot be deleted'),
}

const INVITE_ERRORS: Record<InviteUserFailure, () => AppError> = {
  email_exists: () => new AppError(409, 'email_exists', 'An account with this email already exists'),
  actor_not_allowed: forbidden,
  auth_user_not_found: authUnavailable,
  profile_exists: () => new AppError(409, 'email_exists', 'An account with this email already exists'),
  invalid_assignment: () => new AppError(422, 'invalid_assignment', 'The access assignment does not match the role'),
  agency_not_found: agencyNotFound,
  agency_inactive: () => new AppError(422, 'agency_inactive', 'This agency is inactive; activate it before assigning users'),
  branch_not_found: branchNotFound,
  branch_inactive: () => new AppError(422, 'branch_inactive', 'This branch is inactive; activate it before assigning nurses'),
  user_not_found: () => new AppError(404, 'user_not_found', 'User not found'),
}

/**
 * Global-admin routes for agencies and their branches, mounted under
 * `/admin`. Every route needs a cookie session and an admin profile; the
 * database commands re-check the actor's role.
 */
export interface AdminRouterDependencies {
  store: DataStore | null
  authAdmin: AuthAdmin | null
  setPasswordUrl: string
}

export function createAdminRouter(
  { store, authAdmin, setPasswordUrl }: AdminRouterDependencies,
  authenticate: RequestHandler[],
) {
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

  router.delete('/agencies/:agencyId', ...asAdmin, async (req, res) => {
    const { agencyId } = parseInput(agencyIdParams, req.params, 'params')
    const result = await deleteAgency({ store: store! }, req.viewer!, agencyId)
    if (!result.ok) throw DELETE_AGENCY_ERRORS[result.outcome]()
    res.status(204).end()
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

  router.get('/users', ...asAdmin, async (req, res) => {
    res.json({ users: await listUsers({ store: store! }, req.viewer!) })
  })

  router.post('/users', ...asAdmin, validateBody(inviteUserBody), async (req, res) => {
    if (!authAdmin) throw authUnavailable()
    const result = await inviteUser({ store: store!, auth: authAdmin }, req.viewer!, req.body as InviteUserCommand, setPasswordUrl)
    if (!result.ok) throw INVITE_ERRORS[result.outcome]()
    res.status(201).json({ user: result.user })
  })

  router.delete('/users/:userId', ...asAdmin, async (req, res) => {
    if (!authAdmin) throw authUnavailable()
    const { userId } = parseInput(userIdParams, req.params, 'params')
    const result = await deleteUser({ store: store!, auth: authAdmin }, req.viewer!, userId)
    if (!result.ok) throw DELETE_USER_ERRORS[result.outcome]()
    res.status(204).end()
  })

  return router
}
