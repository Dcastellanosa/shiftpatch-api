/**
 * Outcomes of the atomic database commands. Plain string unions: the database
 * function decides, the API only maps each outcome to a response.
 */

/** Outcomes of the atomic `claim_shift` workflow. */
export type ClaimOutcome =
  | 'claimed'
  | 'shift_not_found'
  | 'not_a_nurse'
  | 'shift_not_open'
  | 'shift_started'
  | 'agency_inactive'
  | 'branch_inactive'
  | 'eligibility_inactive'
  | 'credential_missing'
  | 'credential_revoked'
  | 'credential_expired'
  | 'schedule_conflict'

/** Outcomes of the atomic `create_shift` workflow. */
export type CreateOutcome =
  | 'created'
  | 'actor_not_allowed'
  | 'branch_not_found'
  | 'agency_inactive'
  | 'branch_inactive'
  | 'invalid_time_range'
  | 'shift_in_past'

/** What a shift command returns: its outcome plus the ids it touched. */
export interface CommandResult<Outcome extends string> {
  outcome: Outcome
  shiftId: string | null
  eventId: string | null
}

/** What an admin command returns: its outcome plus the id of the entity it touched. */
export interface AdminCommandResult<Outcome extends string> {
  outcome: Outcome
  entityId: string | null
}

export type CreateAgencyOutcome = 'created' | 'actor_not_allowed' | 'name_taken'
export type UpdateAgencyOutcome = 'updated' | 'actor_not_allowed' | 'agency_not_found' | 'name_taken'
export type CreateBranchOutcome = 'created' | 'actor_not_allowed' | 'agency_not_found' | 'agency_inactive' | 'name_taken'
export type UpdateBranchOutcome = 'updated' | 'actor_not_allowed' | 'branch_not_found' | 'name_taken'

/** Outcomes of `provision_user` (run after the Auth user exists). */
export type ProvisionOutcome =
  | 'provisioned'
  | 'actor_not_allowed'
  | 'auth_user_not_found'
  | 'profile_exists'
  | 'invalid_assignment'
  | 'agency_not_found'
  | 'agency_inactive'
  | 'branch_not_found'
  | 'branch_inactive'
