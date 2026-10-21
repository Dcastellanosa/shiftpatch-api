import type { Viewer } from '../../domain/viewer/viewer.js'
import type { Shift, ShiftFilters } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

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
