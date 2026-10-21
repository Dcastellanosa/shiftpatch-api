import type { AgencyBranch, UpdateBranchInput } from '../../domain/agency/agency.js'
import type { UpdateBranchOutcome } from '../../domain/outcomes/outcomes.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

export type UpdateBranchFailure = Exclude<UpdateBranchOutcome, 'updated'>

export type UpdateBranchResult = { ok: true; branch: AgencyBranch } | { ok: false; outcome: UpdateBranchFailure }

/**
 * Edits, activates or deactivates a branch addressed through its agency. A
 * branch that does not belong to `agencyId` answers `branch_not_found`
 * before any command runs, so ids are never confirmed across agencies.
 */
export async function updateBranch(
  { store }: { store: DataStore },
  viewer: Viewer,
  agencyId: string,
  branchId: string,
  input: UpdateBranchInput,
): Promise<UpdateBranchResult> {
  const existing = await store.getAgencyBranch(viewer, agencyId, branchId)
  if (!existing) return { ok: false, outcome: 'branch_not_found' }
  const result = await store.updateBranch(viewer.id, branchId, input)
  if (result.outcome !== 'updated') return { ok: false, outcome: result.outcome }
  const branch = await store.getAgencyBranch(viewer, agencyId, branchId)
  if (!branch) return { ok: false, outcome: 'branch_not_found' }
  return { ok: true, branch }
}
