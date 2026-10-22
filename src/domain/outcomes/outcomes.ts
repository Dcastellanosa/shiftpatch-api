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
  | 'agency_inactive'
  | 'branch_inactive'
  | 'eligibility_inactive'
  | 'credential_missing'
  | 'credential_revoked'
  | 'credential_expired'
  | 'schedule_conflict'

/** Outcomes of the atomic `create_shift` workflow. */
export type CreateOutcome =
  'created' | 'actor_not_allowed' | 'branch_not_found' | 'agency_inactive' | 'branch_inactive' | 'invalid_time_range'

/**
 * Outcomes of `cancel_shift_claim` (no-show or advance cancellation; reopens
 * the shift). `reason_not_allowed`: the assigned nurse may only cancel in
 * advance; a no-show is the agency's (or an admin's) call.
 */
export type CancelOutcome =
  'cancelled' | 'actor_not_allowed' | 'reason_not_allowed' | 'invalid_reason' | 'shift_not_found' | 'shift_not_claimed'

/** Outcomes of `upsert_nurse_credential`. */
export type CredentialOutcome = 'recorded' | 'not_a_nurse' | 'credential_type_not_found'

export interface CredentialCommandResult {
  outcome: CredentialOutcome
  credentialId: string | null
}

/** What a shift command returns: its outcome plus the ids it touched. */
export interface CommandResult<Outcome extends string> {
  outcome: Outcome
  shiftId: string | null
  eventId: string | null
}

/** What `cancel_shift_claim` returns: the outcome plus who held the shift. */
export interface CancelCommandResult {
  outcome: CancelOutcome
  shiftId: string | null
  eventId: string | null
  previousNurseId: string | null
  /** Public id of the previous nurse (the agency may no longer see that profile). */
  previousNurseSlug: string | null
}

/** What an admin command returns: its outcome plus the id of the entity it touched. */
export interface AdminCommandResult<Outcome extends string> {
  outcome: Outcome
  entityId: string | null
}

export type CreateAgencyOutcome = 'created' | 'actor_not_allowed' | 'name_taken'
export type UpdateAgencyOutcome = 'updated' | 'actor_not_allowed' | 'agency_not_found' | 'name_taken'
export type CreateBranchOutcome =
  'created' | 'actor_not_allowed' | 'agency_not_found' | 'agency_inactive' | 'name_taken'
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

/** Outcomes of `set_branch_eligibility`. */
export type SetEligibilityOutcome =
  'updated' | 'actor_not_allowed' | 'branch_not_found' | 'nurse_not_found' | 'agency_inactive' | 'branch_inactive'

/** `delete_agency`: only agencies whose branches never had a shift can be removed. */
export type DeleteAgencyOutcome = 'deleted' | 'actor_not_allowed' | 'agency_not_found' | 'agency_has_shifts'

/** `delete_user`: only accounts without shifts or recorded actions can be removed, and never one's own. */
export type DeleteUserOutcome = 'deleted' | 'actor_not_allowed' | 'user_not_found' | 'self_delete' | 'user_has_history'
