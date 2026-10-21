import { describe, expect, it } from 'vitest'
import { listAgencyShifts } from './list-agency-shifts.js'
import {
  ADMIN_PROFILE,
  AGENCY_ID,
  AGENCY_PROFILE,
  NURSE_PROFILE,
  fakeDataStore,
  shiftFixture,
  viewerFor,
} from '../../test-support/fakes.js'

describe('listAgencyShifts', () => {
  it('lets an agency user read the agency they manage, scoped by its public id', async () => {
    const viewer = viewerFor(AGENCY_PROFILE)
    const shifts = [shiftFixture()]
    const store = fakeDataStore({ listShifts: async () => shifts })

    await expect(listAgencyShifts({ store }, viewer, AGENCY_ID, { status: 'open' })).resolves.toEqual({
      ok: true,
      agencyId: AGENCY_ID,
      shifts,
    })
    expect(store.listShifts).toHaveBeenCalledWith(viewer, { status: 'open', agencyId: AGENCY_ID })
  })

  it('lets an admin read any agency', async () => {
    const store = fakeDataStore({ listShifts: async () => [] })
    await expect(listAgencyShifts({ store }, viewerFor(ADMIN_PROFILE), 'agency-b')).resolves.toEqual({
      ok: true,
      agencyId: 'agency-b',
      shifts: [],
    })
    expect(store.listShifts).toHaveBeenCalledWith(expect.anything(), { agencyId: 'agency-b' })
  })

  it('refuses another agency and nurses without touching the store', async () => {
    const store = fakeDataStore()
    await expect(listAgencyShifts({ store }, viewerFor(AGENCY_PROFILE), 'agency-b')).resolves.toEqual({
      ok: false,
      outcome: 'forbidden',
    })
    await expect(listAgencyShifts({ store }, viewerFor(NURSE_PROFILE), AGENCY_ID)).resolves.toEqual({
      ok: false,
      outcome: 'forbidden',
    })
    expect(store.listShifts).not.toHaveBeenCalled()
  })
})
