import { describe, expect, it } from 'vitest'
import {
  ADMIN_PROFILE,
  AGENCY_ID,
  AGENCY_PROFILE,
  NURSE_PROFILE,
  NURSE_SLUG,
  claimedShiftFixture,
  fakeDataStore,
  shiftFixture,
  viewerFor,
} from '../../test-support/fakes.js'
import { listTimesheets } from './list-timesheets.js'

const NOW = new Date('2030-01-10T18:00:00.000Z')

// Day shift at agency-a, 07:00–15:00 local (12:00–20:00Z): still running at NOW.
const mine = claimedShiftFixture({ id: 'shift-1' })
// Finished yesterday: 8 h worked.
const worked = claimedShiftFixture({
  id: 'shift-2',
  date: '2030-01-09',
  startsAt: '2030-01-09T12:00:00.000Z',
  endsAt: '2030-01-09T20:00:00.000Z',
})
// Overnight shift held by another nurse at agency-b: 19:00–07:00 local = 12 h from the instants.
const theirs = claimedShiftFixture({
  id: 'shift-3',
  agencyId: 'agency-b',
  agencyName: 'Metro Care Partners',
  claimedBy: 'nurse-2',
  claimedByName: 'James Cook',
  date: '2030-01-11',
  startTime: '19:00',
  endTime: '07:00',
  startsAt: '2030-01-12T00:00:00.000Z',
  endsAt: '2030-01-12T12:00:00.000Z',
})
const open = shiftFixture({ id: 'shift-4' })

describe('listTimesheets', () => {
  it('derives a row per filled shift with scheduled hours and a worked/scheduled status', async () => {
    const store = fakeDataStore({ listShifts: async () => [mine, worked, theirs, open] })
    const rows = await listTimesheets({ store }, viewerFor(ADMIN_PROFILE), NOW)

    expect(rows).toEqual([
      {
        shiftId: 'shift-1',
        nurseId: NURSE_SLUG,
        nurseName: NURSE_PROFILE.fullName,
        agencyId: AGENCY_ID,
        agencyName: mine.agencyName,
        role: 'RN',
        date: '2030-01-10',
        startTime: '07:00',
        endTime: '15:00',
        scheduledHours: 8,
        status: 'scheduled',
      },
      expect.objectContaining({ shiftId: 'shift-2', scheduledHours: 8, status: 'worked' }),
      expect.objectContaining({ shiftId: 'shift-3', nurseId: 'nurse-2', scheduledHours: 12, status: 'scheduled' }),
    ])
    // Only filled shifts are asked for.
    expect(store.listShifts).toHaveBeenCalledWith(viewerFor(ADMIN_PROFILE), { status: 'claimed' })
  })

  it('shows a nurse only their own shifts', async () => {
    const store = fakeDataStore({ listShifts: async () => [mine, worked, theirs] })
    const rows = await listTimesheets({ store }, viewerFor(NURSE_PROFILE), NOW)
    expect(rows.map((r) => r.shiftId)).toEqual(['shift-1', 'shift-2'])
  })

  it('shows an agency user only the shifts of their agencies', async () => {
    const store = fakeDataStore({ listShifts: async () => [mine, theirs] })
    const rows = await listTimesheets({ store }, viewerFor(AGENCY_PROFILE), NOW)
    expect(rows.map((r) => r.shiftId)).toEqual(['shift-1'])
  })

  it('rounds partial hours to two decimals', async () => {
    const short = claimedShiftFixture({ id: 'shift-5', endsAt: '2030-01-10T12:20:00.000Z' })
    const store = fakeDataStore({ listShifts: async () => [short] })
    const [row] = await listTimesheets({ store }, viewerFor(ADMIN_PROFILE), NOW)
    expect(row!.scheduledHours).toBe(0.33)
  })
})
