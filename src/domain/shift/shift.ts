/**
 * Staffing domain model. Plain types with no framework or I/O dependencies;
 * every timestamp is an ISO 8601 UTC string.
 */

export const APP_ROLES = ['admin', 'agency', 'nurse'] as const
export type AppRole = (typeof APP_ROLES)[number]

export const SHIFT_STATUSES = ['open', 'claimed', 'cancelled', 'completed', 'no_show'] as const
export type ShiftStatus = (typeof SHIFT_STATUSES)[number]

export const SHIFT_EVENT_TYPES = ['created', 'claimed', 'cancelled', 'completed', 'no_show'] as const
export type ShiftEventType = (typeof SHIFT_EVENT_TYPES)[number]

export interface Agency {
  id: string
  name: string
}

export interface Branch {
  id: string
  name: string
  address: string
  timezone: string
  agency: Agency
}

export interface Shift {
  id: string
  title: string
  startsAt: string
  endsAt: string
  status: ShiftStatus
  branch: Omit<Branch, 'agency'>
  agency: Agency
  assignedNurse: { id: string; fullName: string } | null
  createdAt: string
  updatedAt: string
}

export interface ShiftEvent {
  id: string
  eventType: ShiftEventType
  previousStatus: ShiftStatus | null
  newStatus: ShiftStatus
  reason: string | null
  occurredAt: string
  /** `fullName` is null when the caller may not see the actor's profile. */
  actor: { id: string; fullName: string | null }
}

export interface ShiftFilters {
  status?: ShiftStatus | undefined
  branchId?: string | undefined
  /** Shifts starting at or after this instant. */
  from?: string | undefined
  /** Shifts starting before this instant. */
  to?: string | undefined
  /** Nurse only: also include shifts assigned to the caller. */
  includeAssigned?: boolean | undefined
}

export interface CreateShiftInput {
  branchId: string
  title: string
  startsAt: string
  endsAt: string
}

/** Outcomes of the atomic `claim_shift` workflow. */
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

/** Outcomes of the atomic `create_shift` workflow. */
export type CreateOutcome = 'created' | 'actor_not_allowed' | 'branch_not_found' | 'invalid_time_range' | 'shift_in_past'
