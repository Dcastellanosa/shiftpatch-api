import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Shift, Timesheet } from '../../domain/shift/shift.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

const HOUR_MS = 60 * 60 * 1000

/**
 * A read-only timesheet derived from filled shifts: who works where and
 * when, and the scheduled hours between the shift's instants. A nurse sees
 * their own shifts, an agency user the shifts of their agencies, an admin
 * everything. A shift that has ended counts as worked.
 */
export async function listTimesheets({ store }: { store: DataStore }, viewer: Viewer, now: Date): Promise<Timesheet[]> {
  const shifts = await store.listShifts(viewer, { status: 'claimed' })
  return shifts
    .filter((shift) => shift.status === 'claimed' && shift.claimedBy !== null && visibleTo(viewer, shift))
    .map((shift) => toTimesheet(shift, now))
}

function visibleTo(viewer: Viewer, shift: Shift): boolean {
  if (viewer.role === 'admin') return true
  if (viewer.role === 'agency') return viewer.agencySlugs.includes(shift.agencyId)
  return shift.claimedBy === viewer.slug
}

function toTimesheet(shift: Shift, now: Date): Timesheet {
  const hours = (Date.parse(shift.endsAt) - Date.parse(shift.startsAt)) / HOUR_MS
  return {
    shiftId: shift.id,
    nurseId: shift.claimedBy ?? '',
    nurseName: shift.claimedByName ?? '',
    agencyId: shift.agencyId,
    agencyName: shift.agencyName,
    role: shift.role,
    date: shift.date,
    startTime: shift.startTime,
    endTime: shift.endTime,
    scheduledHours: Math.round(hours * 100) / 100,
    status: Date.parse(shift.endsAt) <= now.getTime() ? 'worked' : 'scheduled',
  }
}
