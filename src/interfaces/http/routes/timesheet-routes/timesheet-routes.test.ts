import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { Profile } from '../../../../domain/viewer/viewer.js'
import {
  ADMIN_PROFILE,
  AGENCY_PROFILE,
  BEARER,
  NURSE_PROFILE,
  NURSE_SLUG,
  buildSignedInApp,
  claimedShiftFixture,
  fakeDataStore,
} from '../../../../test-support/fakes.js'

const asProfile = (profile: Profile | null) => async () => profile

describe('GET /timesheets', () => {
  it('needs a bearer token', async () => {
    const res = await request(buildSignedInApp(fakeDataStore())).get('/timesheets')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required' })
  })

  it.each([NURSE_PROFILE, AGENCY_PROFILE, ADMIN_PROFILE])(
    'answers every $role with their timesheet rows',
    async (profile) => {
      const store = fakeDataStore({ getProfile: asProfile(profile), listShifts: async () => [claimedShiftFixture()] })
      const res = await request(buildSignedInApp(store)).get('/timesheets').set(BEARER)

      expect(res.status).toBe(200)
      expect(res.body.timesheets).toHaveLength(1)
      expect(Object.keys(res.body.timesheets[0]).sort()).toEqual(
        [
          'shiftId',
          'nurseId',
          'nurseName',
          'agencyId',
          'agencyName',
          'role',
          'date',
          'startTime',
          'endTime',
          'scheduledHours',
          'status',
        ].sort(),
      )
      expect(res.body.timesheets[0]).toMatchObject({ shiftId: 'shift-1', nurseId: NURSE_SLUG, scheduledHours: 8 })
      expect(['scheduled', 'worked']).toContain(res.body.timesheets[0].status)
    },
  )

  it('is served under /api too', async () => {
    const store = fakeDataStore({ getProfile: asProfile(ADMIN_PROFILE), listShifts: async () => [] })
    const res = await request(buildSignedInApp(store)).get('/api/timesheets').set(BEARER)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ timesheets: [] })
  })
})
