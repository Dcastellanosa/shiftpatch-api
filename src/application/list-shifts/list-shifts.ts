import type { Viewer } from '../../domain/viewer/viewer.js'
import type { Shift, ShiftFilters } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

/** The marketplace: every shift across every agency, narrowed by the filters. */
export function listShifts({ store }: { store: DataStore }, viewer: Viewer, filters: ShiftFilters): Promise<Shift[]> {
  return store.listShifts(viewer, filters)
}
