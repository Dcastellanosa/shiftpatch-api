import type { Agency, CreateAgencyInput } from '../../domain/agency/agency.js'
import type { CreateAgencyOutcome } from '../../domain/outcomes/outcomes.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

/** `agency_not_found` covers a created agency that is not visible on re-read. */
export type CreateAgencyFailure = Exclude<CreateAgencyOutcome, 'created'> | 'agency_not_found'

export type CreateAgencyResult = { ok: true; agency: Agency } | { ok: false; outcome: CreateAgencyFailure }

/** Creates an active agency on behalf of the viewer and returns it as the viewer sees it. */
export async function createAgency(
  { store }: { store: DataStore },
  viewer: Viewer,
  input: CreateAgencyInput,
): Promise<CreateAgencyResult> {
  const result = await store.createAgency(viewer.id, input)
  if (result.outcome !== 'created') return { ok: false, outcome: result.outcome }
  const detail = await store.getAgency(viewer, result.entityId!)
  if (!detail) return { ok: false, outcome: 'agency_not_found' }
  return { ok: true, agency: detail.agency }
}
