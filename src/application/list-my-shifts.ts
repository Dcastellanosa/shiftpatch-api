import type { Viewer } from '../domain/identity.js'
import type { Shift } from '../domain/shift.js'
import type { DataStore } from './ports/data-store.js'

export interface MyShifts {
  upcoming: Shift[]
  past: Shift[]
}

/**
 * Splits the viewer's assigned shifts around `now` (epoch milliseconds).
 * Shifts that have not ended yet are upcoming, in the store's ascending
 * order; the rest are past, most recent first.
 */
export async function listMyShifts({ store }: { store: DataStore }, viewer: Viewer, now: number): Promise<MyShifts> {
  const assigned = await store.listAssignedShifts(viewer)
  const upcoming: Shift[] = []
  const past: Shift[] = []
  for (const shift of assigned) {
    ;(new Date(shift.endsAt).getTime() > now ? upcoming : past).push(shift)
  }
  past.reverse()
  return { upcoming, past }
}
