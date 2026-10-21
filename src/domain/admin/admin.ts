/**
 * User administration model: who exists, how they were invited, and what
 * access they hold. Plain types; timestamps are ISO 8601 UTC strings.
 */
import type { AppRole } from '../shift/shift.js'

export const ELIGIBILITY_STATUSES = ['pending', 'active', 'suspended'] as const
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number]

export const USER_STATUSES = ['invited', 'active'] as const
/** `invited` until the user has completed the invitation (confirmed the account). */
export type UserStatus = (typeof USER_STATUSES)[number]

export interface AdminUser {
  /** Public id (slug), e.g. `nurse-1`. */
  id: string
  email: string | null
  fullName: string
  role: AppRole
  status: UserStatus
  invitedAt: string | null
  lastSignInAt: string | null
  /** Agencies managed through an active membership (agency users); ids are public agency ids. */
  agencies: { id: string; name: string }[]
  /** Every eligibility row of a nurse, with its status. */
  eligibleBranches: { id: string; name: string; agency: { id: string; name: string }; status: EligibilityStatus }[]
}

/**
 * What an administrator asks for when inviting someone. The assignment
 * depends on the role: agency users get one or more agencies, nurses get one
 * branch (their agency access derives from it), admins get nothing else.
 */
export type InviteUserCommand = { email: string; fullName: string } & (
  | { role: 'admin' }
  /** Public agency ids. */
  | { role: 'agency'; agencyIds: string[] }
  /** Branch UUID. */
  | { role: 'nurse'; branchId: string }
)

export const PASSWORD_LINK_TYPES = ['invite', 'recovery'] as const
export type PasswordLinkType = (typeof PASSWORD_LINK_TYPES)[number]

/** One nurse connected to the viewer's agencies, with their status at each of those agencies' branches. Ids are public ids. */
export interface NurseEligibility {
  nurse: { id: string; fullName: string }
  branches: {
    branch: { id: string; name: string; agency: { id: string; name: string } }
    status: EligibilityStatus
    activatedAt: string | null
  }[]
}

/** One nurse-branch eligibility row. `nurseId` is the public id, `branchId` the branch UUID. */
export interface EligibilityRecord {
  nurseId: string
  branchId: string
  status: EligibilityStatus
  activatedAt: string | null
}
