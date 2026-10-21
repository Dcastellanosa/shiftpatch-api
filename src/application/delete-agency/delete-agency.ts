import type { DeleteAgencyOutcome } from '../../domain/outcomes/outcomes.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

export type DeleteAgencyFailure = Exclude<DeleteAgencyOutcome, 'deleted'>

export type DeleteAgencyResult = { ok: true } | { ok: false; outcome: DeleteAgencyFailure }

/**
 * Removes an agency that never had a shift, with its branches, memberships
 * and eligibility records. Agencies with shift history keep their audit trail
 * and must be deactivated instead; the database refuses the deletion.
 */
export async function deleteAgency(
  { store }: { store: DataStore },
  viewer: Viewer,
  agencyId: string,
): Promise<DeleteAgencyResult> {
  const result = await store.deleteAgency(viewer.id, agencyId)
  return result.outcome === 'deleted' ? { ok: true } : { ok: false, outcome: result.outcome }
}
