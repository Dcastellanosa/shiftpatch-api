import type { DataStore, Viewer } from '../data/data-store.js'
import type { ShiftEvent } from '../shifts/contracts.js'

export type GetShiftHistoryFailure = 'shift_not_found'

export type GetShiftHistoryResult =
  | { ok: true; events: ShiftEvent[] }
  | { ok: false; outcome: GetShiftHistoryFailure }

/**
 * Returns a shift's event history. Nurses see history only for shifts
 * assigned to them; anyone else sees it for every shift visible to them.
 */
export async function getShiftHistory(
  { store }: { store: DataStore },
  viewer: Viewer,
  shiftId: string,
): Promise<GetShiftHistoryResult> {
  const shift = await store.getShift(viewer, shiftId)
  if (!shift || (viewer.role === 'nurse' && shift.assignedNurse?.id !== viewer.id)) {
    return { ok: false, outcome: 'shift_not_found' }
  }
  return { ok: true, events: await store.listShiftEvents(viewer, shiftId) }
}
