import type { Profile, Viewer } from '../../viewer/viewer.js'
import type {
  Agency,
  AgencyBranch,
  AgencyDetail,
  CreateAgencyInput,
  CreateBranchInput,
  UpdateAgencyInput,
  UpdateBranchInput,
} from '../../agency/agency.js'
import type {
  AdminCommandResult,
  ClaimOutcome,
  CommandResult,
  CreateAgencyOutcome,
  CreateBranchOutcome,
  CreateOutcome,
  UpdateAgencyOutcome,
  UpdateBranchOutcome,
} from '../../outcomes/outcomes.js'
import type {
  Branch,
  CreateShiftInput,
  Shift,
  ShiftEvent,
  ShiftFilters,
} from '../../shift/shift.js'

/**
 * Driven port: all business-data access. Reads run as the caller (RLS
 * applies); the two commands call service-role-only database functions that
 * enforce the workflow rules atomically.
 */
export interface DataStore {
  getProfile(accessToken: string, userId: string): Promise<Profile | null>
  listShifts(viewer: Viewer, filters: ShiftFilters): Promise<Shift[]>
  getShift(viewer: Viewer, shiftId: string): Promise<Shift | null>
  listAssignedShifts(viewer: Viewer): Promise<Shift[]>
  listShiftEvents(viewer: Viewer, shiftId: string): Promise<ShiftEvent[]>
  listBranches(viewer: Viewer): Promise<Branch[]>
  createShift(actorId: string, input: CreateShiftInput): Promise<CommandResult<CreateOutcome>>
  claimShift(nurseId: string, shiftId: string): Promise<CommandResult<ClaimOutcome>>

  // Agency administration. Reads run as the viewer (RLS applies); commands
  // call the service-role-only admin functions.
  listAgencies(viewer: Viewer): Promise<Agency[]>
  getAgency(viewer: Viewer, agencyId: string): Promise<AgencyDetail | null>
  getAgencyBranch(viewer: Viewer, agencyId: string, branchId: string): Promise<AgencyBranch | null>
  createAgency(actorId: string, input: CreateAgencyInput): Promise<AdminCommandResult<CreateAgencyOutcome>>
  updateAgency(actorId: string, agencyId: string, input: UpdateAgencyInput): Promise<AdminCommandResult<UpdateAgencyOutcome>>
  createBranch(actorId: string, agencyId: string, input: CreateBranchInput): Promise<AdminCommandResult<CreateBranchOutcome>>
  updateBranch(actorId: string, branchId: string, input: UpdateBranchInput): Promise<AdminCommandResult<UpdateBranchOutcome>>
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
