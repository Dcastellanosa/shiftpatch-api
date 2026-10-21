import type { Agency, UpdateAgencyInput } from '../../domain/agency/agency.js'
import type { UpdateAgencyOutcome } from '../../domain/outcomes/outcomes.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

export type UpdateAgencyFailure = Exclude<UpdateAgencyOutcome, 'updated'>

export type UpdateAgencyResult = { ok: true; agency: Agency } | { ok: false; outcome: UpdateAgencyFailure }

/** Renames, activates or deactivates an agency and returns it as the viewer sees it. */
export async function updateAgency(
  { store }: { store: DataStore },
  viewer: Viewer,
  agencyId: string,
  input: UpdateAgencyInput,
): Promise<UpdateAgencyResult> {
  const result = await store.updateAgency(viewer.id, agencyId, input)
  if (result.outcome !== 'updated') return { ok: false, outcome: result.outcome }
  const detail = await store.getAgency(viewer, agencyId)
  if (!detail) return { ok: false, outcome: 'agency_not_found' }
  return { ok: true, agency: detail.agency }
}
