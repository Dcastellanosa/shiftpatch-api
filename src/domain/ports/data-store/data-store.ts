import type { Profile, Viewer } from '../../viewer/viewer.js'
import type {
  AdminUser,
  AuditEvent,
  EligibilityRecord,
  InviteUserCommand,
  NurseEligibility,
} from '../../admin/admin.js'
import type {
  Agency,
  AgencyBranch,
  AgencyDetail,
  CreateAgencyInput,
  CreateBranchInput,
  UpdateAgencyInput,
  UpdateBranchInput,
} from '../../agency/agency.js'
import type { NurseCredential } from '../../credential/credential.js'
import type {
  AdminCommandResult,
  CancelCommandResult,
  ClaimOutcome,
  CredentialCommandResult,
  CommandResult,
  CreateAgencyOutcome,
  DeleteAgencyOutcome,
  DeleteUserOutcome,
  CreateBranchOutcome,
  CreateOutcome,
  ProvisionOutcome,
  SetEligibilityOutcome,
  UpdateAgencyOutcome,
  UpdateBranchOutcome,
} from '../../outcomes/outcomes.js'
import type { Branch, CancelReason, CreateShiftCommand, Shift, ShiftEvent, ShiftFilters } from '../../shift/shift.js'

/**
 * Driven port: all business-data access. Every id crossing this port is a
 * public id (slug) except branch ids, which are UUIDs. Reads run as the caller
 * (RLS applies); commands call service-role-only database functions that
 * enforce the workflow rules atomically.
 */
export interface DataStore {
  getProfile(accessToken: string, userId: string): Promise<Profile | null>
  /** Every shift the marketplace shows (all agencies), narrowed by the filters. */
  listShifts(viewer: Viewer, filters: ShiftFilters): Promise<Shift[]>
  getShift(viewer: Viewer, shiftId: string): Promise<Shift | null>
  listAssignedShifts(viewer: Viewer): Promise<Shift[]>
  listShiftEvents(viewer: Viewer, shiftId: string): Promise<ShiftEvent[]>
  listBranches(viewer: Viewer): Promise<Branch[]>
  createShift(actorId: string, command: CreateShiftCommand): Promise<CommandResult<CreateOutcome>>
  claimShift(nurseId: string, shiftId: string): Promise<CommandResult<ClaimOutcome>>
  cancelClaim(actorId: string, shiftId: string, reason: CancelReason): Promise<CancelCommandResult>

  // Agency administration. Reads run as the viewer (RLS applies); commands
  // call the service-role-only admin functions.
  listAgencies(viewer: Viewer): Promise<Agency[]>
  getAgency(viewer: Viewer, agencyId: string): Promise<AgencyDetail | null>
  getAgencyBranch(viewer: Viewer, agencyId: string, branchId: string): Promise<AgencyBranch | null>
  createAgency(actorId: string, input: CreateAgencyInput): Promise<AdminCommandResult<CreateAgencyOutcome>>
  updateAgency(
    actorId: string,
    agencyId: string,
    input: UpdateAgencyInput,
  ): Promise<AdminCommandResult<UpdateAgencyOutcome>>
  /** Removes an agency with its branches, memberships and eligibility records; refused once any shift exists. */
  deleteAgency(actorId: string, agencyId: string): Promise<AdminCommandResult<DeleteAgencyOutcome>>
  createBranch(
    actorId: string,
    agencyId: string,
    input: CreateBranchInput,
  ): Promise<AdminCommandResult<CreateBranchOutcome>>
  updateBranch(
    actorId: string,
    branchId: string,
    input: UpdateBranchInput,
  ): Promise<AdminCommandResult<UpdateBranchOutcome>>

  // User administration. Listing runs as the viewer (the database rejects
  // non-admins); provisioning calls the service-role-only command.
  listUsers(viewer: Viewer): Promise<AdminUser[]>
  getUser(viewer: Viewer, userId: string): Promise<AdminUser | null>
  /** `authUserId` is the Auth user's UUID (the account was just created); the result's entityId is the same UUID. */
  provisionUser(
    actorId: string,
    authUserId: string,
    command: InviteUserCommand,
  ): Promise<AdminCommandResult<ProvisionOutcome>>
  /** Removes the profile and its access records (not the Auth account); the result's entityId is the Auth user's UUID. */
  deleteUser(actorId: string, userId: string): Promise<AdminCommandResult<DeleteUserOutcome>>

  // Nurse eligibility. Reads run as the viewer (RLS limits agency users to
  // their branches); the command re-checks the actor's scope.
  listAgencyNurses(viewer: Viewer): Promise<NurseEligibility[]>
  getEligibility(viewer: Viewer, nurseId: string, branchId: string): Promise<EligibilityRecord | null>
  setBranchEligibility(
    actorId: string,
    nurseId: string,
    branchId: string,
    status: 'active' | 'suspended',
  ): Promise<AdminCommandResult<SetEligibilityOutcome>>

  // Nurse credentials. The listing runs as the viewer (RLS: own rows, or an
  // admin); the upsert calls the service-role-only command.
  listNurseCredentials(viewer: Viewer): Promise<NurseCredential[]>
  /** `nurseId` is the nurse's Auth UUID (the viewer's own id). One row per nurse and credential type. */
  upsertNurseCredential(nurseId: string, input: UpsertCredentialInput): Promise<CredentialCommandResult>

  /** The unified audit log, read as the viewer: the database refuses anyone but an admin. */
  listAuditEvents(viewer: Viewer): Promise<AuditEvent[]>
}

export interface UpsertCredentialInput {
  credentialTypeCode: string
  expiresAt: string
  filePath: string
  originalName: string
  contentType: string
  sizeBytes: number
}

/** A data-layer failure. The message is safe to log; it never contains row data or tokens. */
export class DataStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataStoreError'
  }
}

/** The data layer is not configured (missing Supabase or service-role settings). */
export class DataUnavailableError extends Error {
  constructor() {
    super('Data service unavailable')
    this.name = 'DataUnavailableError'
  }
}
