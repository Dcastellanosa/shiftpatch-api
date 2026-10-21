import type { Viewer } from '../../domain/viewer/viewer.js'
import type { Shift, ShiftFilters } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

export type ListAgencyShiftsFailure = 'forbidden'

export type ListAgencyShiftsResult =
  | { ok: true; agencyId: string; shifts: Shift[] }
  | { ok: false; outcome: ListAgencyShiftsFailure }

/**
 * One agency's posted shifts. Admins may read any agency, agency users only
 * the agencies they actively manage; nurses use the marketplace instead.
 */
export async function listAgencyShifts(
  { store }: { store: DataStore },
  viewer: Viewer,
  agencyId: string,
  filters: ShiftFilters = {},
): Promise<ListAgencyShiftsResult> {
  if (viewer.role === 'nurse') return { ok: false, outcome: 'forbidden' }
  if (viewer.role === 'agency' && !viewer.agencySlugs.includes(agencyId)) return { ok: false, outcome: 'forbidden' }
  return { ok: true, agencyId, shifts: await store.listShifts(viewer, { ...filters, agencyId }) }
}
