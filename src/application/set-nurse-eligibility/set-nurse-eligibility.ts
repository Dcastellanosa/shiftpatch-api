import type { EligibilityRecord } from '../../domain/admin/admin.js'
import type { SetEligibilityOutcome } from '../../domain/outcomes/outcomes.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

/** `eligibility_not_found` covers a row that is not visible on re-read. */
export type SetEligibilityFailure = Exclude<SetEligibilityOutcome, 'updated'> | 'eligibility_not_found'

export type SetEligibilityResult = { ok: true; eligibility: EligibilityRecord } | { ok: false; outcome: SetEligibilityFailure }

/**
 * Activates or suspends a nurse at a branch. The database enforces the
 * actor's scope: agency users reach only branches of their active
 * memberships and nurses already connected to those agencies; anything else
 * answers *_not_found, so ids are never confirmed across agencies.
 */
export async function setNurseEligibility(
  { store }: { store: DataStore },
  viewer: Viewer,
  nurseId: string,
  branchId: string,
  status: 'active' | 'suspended',
): Promise<SetEligibilityResult> {
  const result = await store.setBranchEligibility(viewer.id, nurseId, branchId, status)
  if (result.outcome !== 'updated') return { ok: false, outcome: result.outcome }
  const eligibility = await store.getEligibility(viewer, nurseId, branchId)
  if (!eligibility) return { ok: false, outcome: 'eligibility_not_found' }
  return { ok: true, eligibility }
}
