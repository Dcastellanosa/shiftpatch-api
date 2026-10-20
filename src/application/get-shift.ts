import type { Viewer } from '../domain/identity.js'
import type { Shift } from '../domain/shift.js'
import type { DataStore } from './ports/data-store.js'

export type GetShiftResult = { ok: true; shift: Shift } | { ok: false; outcome: 'shift_not_found' }

/** Returns one shift if it is visible to the viewer. */
export async function getShift({ store }: { store: DataStore }, viewer: Viewer, shiftId: string): Promise<GetShiftResult> {
  const shift = await store.getShift(viewer, shiftId)
  return shift ? { ok: true, shift } : { ok: false, outcome: 'shift_not_found' }
}
