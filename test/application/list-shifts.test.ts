import { describe, expect, it } from 'vitest'
import { listShifts } from '../../src/application/list-shifts.js'
import type { ShiftFilters } from '../../src/shifts/contracts.js'
import { ADMIN_PROFILE, AGENCY_PROFILE, NURSE_PROFILE, fakeDataStore, shiftFixture, viewerFor } from '../helpers.js'

const WITH_ASSIGNED: ShiftFilters = { includeAssigned: true }
const WITHOUT_ASSIGNED: ShiftFilters = { status: 'open', includeAssigned: false }

describe('listShifts', () => {
  it('lets a nurse include their assigned shifts', async () => {
    const nurse = viewerFor(NURSE_PROFILE)
    const shifts = [shiftFixture()]
    const store = fakeDataStore({ listShifts: async () => shifts })

    const result = await listShifts({ store }, nurse, WITH_ASSIGNED)

    expect(result).toEqual({ ok: true, shifts })
    expect(store.listShifts).toHaveBeenCalledWith(nurse, WITH_ASSIGNED)
  })

  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('rejects includeAssigned for $role without touching the store', async (profile) => {
    const store = fakeDataStore()

    const result = await listShifts({ store }, viewerFor(profile), WITH_ASSIGNED)

    expect(result).toEqual({ ok: false, outcome: 'include_assigned_nurse_only' })
    expect(store.listShifts).not.toHaveBeenCalled()
  })

  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('lists for $role when includeAssigned is off', async (profile) => {
    const viewer = viewerFor(profile)
    const store = fakeDataStore({ listShifts: async () => [] })

    const result = await listShifts({ store }, viewer, WITHOUT_ASSIGNED)

    expect(result).toEqual({ ok: true, shifts: [] })
    expect(store.listShifts).toHaveBeenCalledWith(viewer, WITHOUT_ASSIGNED)
  })
})
