import type { ClaimOutcome, DataStore, Viewer } from '../data/data-store.js'
import type { Shift } from '../shifts/contracts.js'

export type ClaimShiftFailure = Exclude<ClaimOutcome, 'claimed'>

export type ClaimShiftResult = { ok: true; shift: Shift } | { ok: false; outcome: ClaimShiftFailure }

/**
 * Claims a shift for the viewer and returns the updated shift.
 *
 * The database function locks the shift and performs every check and write
 * atomically; nothing is pre-checked here.
 */
export async function claimShift(
  { store }: { store: DataStore },
  viewer: Viewer,
  shiftId: string,
): Promise<ClaimShiftResult> {
  const result = await store.claimShift(viewer.id, shiftId)
  if (result.outcome !== 'claimed') return { ok: false, outcome: result.outcome }
  const shift = await store.getShift(viewer, shiftId)
  if (!shift) return { ok: false, outcome: 'shift_not_found' }
  return { ok: true, shift }
}
