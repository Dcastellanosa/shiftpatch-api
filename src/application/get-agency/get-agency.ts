import type { AgencyDetail } from '../../domain/agency/agency.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

export type GetAgencyResult = { ok: true; detail: AgencyDetail } | { ok: false; outcome: 'agency_not_found' }

/** One agency with its branches, or `agency_not_found` when it is not visible to the viewer. */
export async function getAgency(
  { store }: { store: DataStore },
  viewer: Viewer,
  agencyId: string,
): Promise<GetAgencyResult> {
  const detail = await store.getAgency(viewer, agencyId)
  return detail ? { ok: true, detail } : { ok: false, outcome: 'agency_not_found' }
}
