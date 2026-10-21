import type { EntityStatus } from '../agency/agency.js'

/**
 * Staffing domain model. Plain types with no framework or I/O dependencies.
 *
 * Public identifiers are slugs (`agency-a`, `nurse-1`, `shift-1`), never
 * database UUIDs. Shift times are stored as UTC instants; `date`, `startTime`
 * and `endTime` are the facility-local wall clock in the branch's time zone,
 * which is what the contract exposes.
 */

export const APP_ROLES = ['admin', 'agency', 'nurse'] as const
export type AppRole = (typeof APP_ROLES)[number]

/** `filled` is the contract's word for a claimed shift. */
export const SHIFT_STATUSES = ['open', 'filled', 'cancelled', 'completed', 'no_show'] as const
export type ShiftStatus = (typeof SHIFT_STATUSES)[number]

export const SHIFT_EVENT_TYPES = ['created', 'claimed', 'cancelled', 'completed', 'no_show'] as const
export type ShiftEventType = (typeof SHIFT_EVENT_TYPES)[number]

export const CANCEL_REASONS = ['no-show', 'advance'] as const
export type CancelReason = (typeof CANCEL_REASONS)[number]

export interface Agency {
  /** Public id (slug). */
  id: string
  name: string
}

export interface Branch {
  id: string
  name: string
  address: string
  timezone: string
  status: EntityStatus
  agency: Agency
}

export interface Shift {
  /** Public id (slug), e.g. `shift-1`. */
  id: string
  /** Public id of the agency, e.g. `agency-a`. */
  agencyId: string
  agencyName: string
  /** The role the shift is for (RN, LPN, ...). */
  role: string
  /** Facility-local date of the start, YYYY-MM-DD. */
  date: string
  /** Facility-local HH:MM. `endTime` at or before `startTime` means the next day. */
  startTime: string
  endTime: string
  status: ShiftStatus
  /** Public id of the assigned nurse, or null while open. */
  claimedBy: string | null
  claimedByName: string | null
  branch: Omit<Branch, 'agency'>
  /** ISO UTC instants. */
  startsAt: string
  endsAt: string
  createdAt: string
  updatedAt: string
}

export interface ShiftCancellation {
  reason: CancelReason
  /** Public id of the nurse who held the shift. */
  previousNurseId: string
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
  /** Public agency id. */
  agencyId?: string | undefined
  /** Shifts starting at or after this instant. */
  from?: string | undefined
  /** Shifts starting before this instant. */
  to?: string | undefined
}

/** What an agency posts: the contract body. `branchId` is optional when the agency has one active branch. */
export interface CreateShiftInput {
  role: string
  date: string
  startTime: string
  endTime: string
  branchId?: string | undefined
}

/** What the database command receives once the branch and the instants are resolved. */
export interface CreateShiftCommand {
  branchId: string
  title: string
  startsAt: string
  endsAt: string
}
