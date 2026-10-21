import type { Viewer } from '../../domain/viewer/viewer.js'
import type { ShiftEvent } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

export type GetShiftHistoryFailure = 'shift_not_found'

export type GetShiftHistoryResult = { ok: true; events: ShiftEvent[] } | { ok: false; outcome: GetShiftHistoryFailure }

/**
 * Returns a shift's event history. The marketplace shows every shift to
 * everyone, but history stays scoped: nurses see it only for shifts assigned
 * to them, agency users only for their own agencies' shifts, admins for all.
 * Out-of-scope shifts answer `shift_not_found`, never 403.
 */
export async function getShiftHistory(
  { store }: { store: DataStore },
  viewer: Viewer,
  shiftId: string,
): Promise<GetShiftHistoryResult> {
  const shift = await store.getShift(viewer, shiftId)
  const inScope =
    shift !== null &&
    (viewer.role === 'admin' ||
      (viewer.role === 'nurse' && shift.claimedBy === viewer.slug) ||
      (viewer.role === 'agency' && viewer.agencySlugs.includes(shift.agencyId)))
  if (!inScope) return { ok: false, outcome: 'shift_not_found' }
  return { ok: true, events: await store.listShiftEvents(viewer, shiftId) }
}
