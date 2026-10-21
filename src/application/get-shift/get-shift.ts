import type { Viewer } from '../../domain/identity/identity.js'
import type { Shift } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

export type GetShiftResult = { ok: true; shift: Shift } | { ok: false; outcome: 'shift_not_found' }

/** Returns one shift if it is visible to the viewer. */
export async function getShift({ store }: { store: DataStore }, viewer: Viewer, shiftId: string): Promise<GetShiftResult> {
  const shift = await store.getShift(viewer, shiftId)
  return shift ? { ok: true, shift } : { ok: false, outcome: 'shift_not_found' }
}
