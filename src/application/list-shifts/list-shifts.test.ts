import { describe, expect, it } from 'vitest'
import { listShifts } from './list-shifts.js'
import type { ShiftFilters } from '../../domain/shift/shift.js'
import { ADMIN_PROFILE, AGENCY_PROFILE, NURSE_PROFILE, fakeDataStore, shiftFixture, viewerFor } from '../../test-support/fakes.js'

const FILTERS: ShiftFilters = { status: 'open', agencyId: 'agency-b' }

describe('listShifts', () => {
  it.each([NURSE_PROFILE, AGENCY_PROFILE, ADMIN_PROFILE])('lists the marketplace for $role with the given filters', async (profile) => {
    const viewer = viewerFor(profile)
    const shifts = [shiftFixture()]
    const store = fakeDataStore({ listShifts: async () => shifts })

    await expect(listShifts({ store }, viewer, FILTERS)).resolves.toEqual(shifts)
    expect(store.listShifts).toHaveBeenCalledWith(viewer, FILTERS)
  })
})
