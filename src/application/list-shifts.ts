import type { DataStore, Viewer } from '../data/data-store.js'
import type { Shift, ShiftFilters } from '../shifts/contracts.js'

export type ListShiftsFailure = 'include_assigned_nurse_only'

export type ListShiftsResult = { ok: true; shifts: Shift[] } | { ok: false; outcome: ListShiftsFailure }

/** Lists the shifts visible to the viewer. `includeAssigned` is only available to nurses. */
export async function listShifts(
  { store }: { store: DataStore },
  viewer: Viewer,
  filters: ShiftFilters,
): Promise<ListShiftsResult> {
  if (filters.includeAssigned && viewer.role !== 'nurse') {
    return { ok: false, outcome: 'include_assigned_nurse_only' }
  }
  return { ok: true, shifts: await store.listShifts(viewer, filters) }
}
