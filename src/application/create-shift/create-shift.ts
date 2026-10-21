import { fromLocalDateTime } from '../../domain/local-time/local-time.js'
import type { Viewer } from '../../domain/viewer/viewer.js'
import type { CreateOutcome } from '../../domain/outcomes/outcomes.js'
import type { CreateShiftInput, Shift } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

/**
 * `branch_required`: the caller has several branches and named none.
 * `shift_not_found`: a created shift that is not visible on re-read.
 */
export type CreateShiftFailure = Exclude<CreateOutcome, 'created'> | 'branch_required' | 'shift_not_found'

export type CreateShiftResult = { ok: true; shift: Shift } | { ok: false; outcome: CreateShiftFailure }

const DAY_MS = 24 * 3_600_000

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10)
}

/**
 * Posts an open shift from the contract body (`role`, facility-local `date`,
 * `startTime`, `endTime`). The shift lands on the named branch, or on the
 * caller's single active branch when none is named. An end time at or before
 * the start time means the shift ends the next day.
 */
export async function createShift(
  { store }: { store: DataStore },
  viewer: Viewer,
  input: CreateShiftInput,
): Promise<CreateShiftResult> {
  const branches = await store.listBranches(viewer)
  const candidates = input.branchId
    ? branches.filter((b) => b.id === input.branchId)
    : branches.filter((b) => b.status === 'active')
  if (input.branchId && candidates.length === 0) return { ok: false, outcome: 'branch_not_found' }
  if (!input.branchId && candidates.length !== 1) return { ok: false, outcome: 'branch_required' }
  const branch = candidates[0]!

  const startsAt = fromLocalDateTime(input.date, input.startTime, branch.timezone)
  let endsAt = fromLocalDateTime(input.date, input.endTime, branch.timezone)
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    endsAt = fromLocalDateTime(addDays(input.date, 1), input.endTime, branch.timezone)
    if (Date.parse(endsAt) - Date.parse(startsAt) > DAY_MS) return { ok: false, outcome: 'invalid_time_range' }
  }

  const result = await store.createShift(viewer.id, { branchId: branch.id, title: input.role, startsAt, endsAt })
  if (result.outcome !== 'created') return { ok: false, outcome: result.outcome }
  const shift = await store.getShift(viewer, result.shiftId!)
  if (!shift) return { ok: false, outcome: 'shift_not_found' }
  return { ok: true, shift }
}
