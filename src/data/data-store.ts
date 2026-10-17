import type {
  AppRole,
  Branch,
  CreateShiftInput,
  Shift,
  ShiftEvent,
  ShiftFilters,
} from '../shifts/contracts.js'

/** Application profile for a verified Auth user. */
export interface Profile {
  id: string
  fullName: string
  role: AppRole
  /** Agency of the active membership (agency users only). */
  agencyId: string | null
}

/** The authenticated caller, resolved from the cookie session and the profiles table. */
export interface Viewer extends Profile {
  /** Caller's Supabase access token, used for RLS-scoped reads. Never returned to clients. */
  accessToken: string
}

export type ClaimOutcome =
  | 'claimed'
  | 'shift_not_found'
  | 'not_a_nurse'
  | 'shift_not_open'
  | 'shift_started'
  | 'eligibility_inactive'
  | 'credential_missing'
  | 'credential_revoked'
  | 'credential_expired'
  | 'schedule_conflict'

export type CreateOutcome =
  | 'created'
  | 'actor_not_allowed'
  | 'branch_not_found'
  | 'invalid_time_range'
  | 'shift_in_past'

export interface CommandResult<Outcome extends string> {
  outcome: Outcome
  shiftId: string | null
  eventId: string | null
}

/**
 * All business-data access. Reads run as the caller (RLS applies); the two
 * commands call service-role-only database functions that enforce the
 * workflow rules atomically.
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
