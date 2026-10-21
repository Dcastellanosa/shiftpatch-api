import type { AgencyBranch, CreateBranchInput } from '../../domain/agency/agency.js'
import type { CreateBranchOutcome } from '../../domain/outcomes/outcomes.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

/** `branch_not_found` covers a created branch that is not visible on re-read. */
export type CreateBranchFailure = Exclude<CreateBranchOutcome, 'created'> | 'branch_not_found'

export type CreateBranchResult = { ok: true; branch: AgencyBranch } | { ok: false; outcome: CreateBranchFailure }

/** Creates an active branch under an active agency and returns it as the viewer sees it. */
export async function createBranch(
  { store }: { store: DataStore },
  viewer: Viewer,
  agencyId: string,
  input: CreateBranchInput,
): Promise<CreateBranchResult> {
  const result = await store.createBranch(viewer.id, agencyId, input)
  if (result.outcome !== 'created') return { ok: false, outcome: result.outcome }
  const branch = await store.getAgencyBranch(viewer, agencyId, result.entityId!)
  if (!branch) return { ok: false, outcome: 'branch_not_found' }
  return { ok: true, branch }
}
