import type { Viewer } from '../../domain/identity/identity.js'
import type { CreateOutcome, CreateShiftInput, Shift } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

/** `shift_not_found` covers a created shift that is not visible on re-read. */
export type CreateShiftFailure = Exclude<CreateOutcome, 'created'> | 'shift_not_found'

export type CreateShiftResult = { ok: true; shift: Shift } | { ok: false; outcome: CreateShiftFailure }

/** Creates a shift on behalf of the viewer and returns it as the viewer sees it. */
export async function createShift(
  { store }: { store: DataStore },
  viewer: Viewer,
  input: CreateShiftInput,
): Promise<CreateShiftResult> {
  const result = await store.createShift(viewer.id, input)
  if (result.outcome !== 'created') return { ok: false, outcome: result.outcome }
  const shift = await store.getShift(viewer, result.shiftId!)
  if (!shift) return { ok: false, outcome: 'shift_not_found' }
  return { ok: true, shift }
}
