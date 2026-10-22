import type { Viewer } from '../../domain/viewer/viewer.js'
import type { CancelOutcome } from '../../domain/outcomes/outcomes.js'
import type { CancelReason, Shift, ShiftCancellation } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

export type CancelClaimFailure = Exclude<CancelOutcome, 'cancelled'>

export type CancelClaimResult =
  { ok: true; shift: Shift; cancellation: ShiftCancellation } | { ok: false; outcome: CancelClaimFailure }

/**
 * No-show or advance cancellation of a claimed shift. Authorization: an admin
 * may cancel any claimed shift; an agency user the shifts of their agencies;
 * the assigned nurse their own shift, and only in advance. The database
 * command enforces the same rules atomically, releases the claim, reopens
 * the shift and records the event; the nurse/no-show rule is also settled
 * here so the request never reaches the database.
 */
export async function cancelClaim(
  { store }: { store: DataStore },
  viewer: Viewer,
  shiftId: string,
  reason: CancelReason,
): Promise<CancelClaimResult> {
  if (viewer.role === 'nurse' && reason !== 'advance') return { ok: false, outcome: 'reason_not_allowed' }
  const result = await store.cancelClaim(viewer.id, shiftId, reason)
  if (result.outcome !== 'cancelled') return { ok: false, outcome: result.outcome }
  const shift = await store.getShift(viewer, shiftId)
  if (!shift) return { ok: false, outcome: 'shift_not_found' }
  return { ok: true, shift, cancellation: { reason, previousNurseId: result.previousNurseSlug ?? '' } }
}
