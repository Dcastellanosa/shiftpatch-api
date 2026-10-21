import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { DataStoreError, DataUnavailableError } from '../../../../domain/ports/data-store/data-store.js'
import type { Profile } from '../../../../domain/viewer/viewer.js'
import type { ClaimOutcome } from '../../../../domain/outcomes/outcomes.js'
import type { Branch } from '../../../../domain/shift/shift.js'
import {
  agencyShiftsResponse,
  cancelResponse,
  myShiftsResponse,
  shiftEventsResponse,
  shiftListResponse,
  shiftResponse,
} from '../../schemas/shifts/shifts.js'
import {
  ADMIN_PROFILE,
  AGENCY_ID,
  AGENCY_PROFILE,
  ALLOWED_ORIGIN,
  BRANCH_ID,
  NURSE_PROFILE,
  NURSE_SLUG,
  SESSION,
  SESSION_COOKIE,
  SHIFT_ID,
  USER,
  buildApp,
  buildSignedInApp,
  claimedShiftFixture,
  fakeAuthProvider,
  fakeDataStore,
  shiftFixture,
} from '../../../../test-support/fakes.js'

const asProfile = (profile: Profile | null) => async () => profile

const get = (app: ReturnType<typeof buildApp>, path: string) => request(app).get(path).set('Cookie', SESSION_COOKIE)
const post = (app: ReturnType<typeof buildApp>, path: string, body?: object) =>
  request(app).post(path).set('Origin', ALLOWED_ORIGIN).set('Cookie', SESSION_COOKIE).send(body)

const MAIN_BRANCH: Branch = {
  id: BRANCH_ID,
  name: 'Main',
  address: 'Sunrise Health Staffing',
  timezone: 'UTC',
  status: 'active',
  agency: { id: AGENCY_ID, name: 'Sunrise Health Staffing' },
}

/** The contract's `POST /api/shifts` body. */
const VALID_BODY = { role: 'RN', date: '2026-10-05', startTime: '07:00', endTime: '19:00' }

describe('authentication and profile gate', () => {
  it.each([
    ['GET', '/shifts'],
    ['GET', `/shifts/${SHIFT_ID}`],
    ['GET', `/shifts/${SHIFT_ID}/events`],
    ['GET', '/me/shifts'],
    ['GET', '/branches'],
    ['GET', `/agencies/${AGENCY_ID}/shifts`],
    ['POST', '/shifts'],
    ['POST', `/shifts/${SHIFT_ID}/claim`],
    ['POST', `/shifts/${SHIFT_ID}/cancel`],
  ])('%s %s returns 401 without a session', async (method, path) => {
    const store = fakeDataStore()
    const app = buildApp(fakeAuthProvider(), 'test', store)
    const res =
      method === 'GET' ? await request(app).get(path) : await request(app).post(path).set('Origin', ALLOWED_ORIGIN)

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('unauthenticated')
    expect(store.getProfile).not.toHaveBeenCalled()
  })

  it('returns 403 profile_missing for a user without a profile', async () => {
    const store = fakeDataStore({ getProfile: asProfile(null) })
    const res = await get(buildSignedInApp(store), '/shifts')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('profile_missing')
  })

  it('returns 403 membership_inactive for an agency user without an active membership', async () => {
    const store = fakeDataStore({
      getProfile: asProfile({ ...AGENCY_PROFILE, agencyIds: [], agencySlugs: [], agencyId: null, agencySlug: null }),
    })
    const res = await get(buildSignedInApp(store), '/shifts')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('membership_inactive')
  })

  it('returns 503 when the data layer is not configured', async () => {
    const res = await get(buildSignedInApp(null), '/shifts')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('data_unavailable')
  })

  it('looks the profile up with the verified user id and the session token', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), listShifts: async () => [] })
    await get(buildSignedInApp(store), `/shifts?userId=someone-else&role=admin`)
    expect(store.getProfile).toHaveBeenCalledWith(SESSION.accessToken, USER.id)
    expect(store.listShifts.mock.calls[0]![0]).toMatchObject({ id: USER.id, role: 'nurse' })
  })
})

describe('GET /auth/me with a profile', () => {
  it('returns the public ids, name and role from the profile', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await get(buildSignedInApp(store), '/auth/me')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      user: {
        id: AGENCY_ID,
        name: AGENCY_PROFILE.fullName,
        email: USER.email,
        role: 'agency',
        agencyId: AGENCY_ID,
        agencyIds: [AGENCY_ID],
      },
    })
  })
})

describe('GET /shifts (the marketplace)', () => {
  it.each([NURSE_PROFILE, AGENCY_PROFILE, ADMIN_PROFILE])(
    'lists every shift in the contract shape for $role',
    async (profile) => {
      const store = fakeDataStore({
        getProfile: asProfile(profile),
        listShifts: async () => [shiftFixture(), claimedShiftFixture({ id: 'shift-2' })],
      })
      const res = await get(buildSignedInApp(store), '/shifts')

      expect(res.status).toBe(200)
      const { shifts } = shiftListResponse.parse(res.body)
      expect(shifts).toHaveLength(2)
      expect(shifts[0]).toMatchObject({
        id: SHIFT_ID,
        agencyId: AGENCY_ID,
        agencyName: 'Northwind Care Staffing',
        role: 'RN',
        date: '2030-01-10',
        startTime: '07:00',
        endTime: '15:00',
        status: 'open',
        claimedBy: null,
      })
      expect(shifts[1]).toMatchObject({ status: 'filled', claimedBy: NURSE_SLUG })
      expect(store.listShifts.mock.calls[0]![1]).toEqual({})
    },
  )

  it('passes validated filters to the store', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), listShifts: async () => [] })
    const res = await get(
      buildSignedInApp(store),
      `/shifts?status=filled&branchId=${BRANCH_ID}&agencyId=agency-b&from=2030-01-01T00:00:00Z&to=2030-02-01T00:00:00Z`,
    )
    expect(res.status).toBe(200)
    expect(store.listShifts.mock.calls[0]![1]).toEqual({
      status: 'filled',
      branchId: BRANCH_ID,
      agencyId: 'agency-b',
      from: '2030-01-01T00:00:00Z',
      to: '2030-02-01T00:00:00Z',
    })
  })

  it.each([
    ['unknown status', 'status=archived'],
    ['the database status word', 'status=claimed'],
    ['non-uuid branch', 'branchId=downtown'],
    ['malformed agency id', 'agencyId=Agency%20A'],
    ['non-ISO date', 'from=yesterday'],
    ['inverted range', 'from=2030-02-01T00:00:00Z&to=2030-01-01T00:00:00Z'],
  ])('returns 400 for %s', async (_label, query) => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE) })
    const res = await get(buildSignedInApp(store), `/shifts?${query}`)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_error')
    expect(store.listShifts).not.toHaveBeenCalled()
  })
})

describe('POST /shifts', () => {
  it('returns 403 for nurses without calling the store', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE) })
    const res = await post(buildSignedInApp(store), '/shifts', VALID_BODY)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('forbidden')
    expect(store.createShift).not.toHaveBeenCalled()
  })

  it.each([AGENCY_PROFILE, ADMIN_PROFILE])(
    'creates a shift as $role from the contract body and answers 201 with the bare shift',
    async (profile) => {
      const shift = shiftFixture({ date: '2026-10-05', startTime: '07:00', endTime: '19:00' })
      const store = fakeDataStore({
        getProfile: asProfile(profile),
        listBranches: async () => [MAIN_BRANCH],
        createShift: async () => ({ outcome: 'created', shiftId: SHIFT_ID, eventId: SHIFT_ID }),
        getShift: async () => shift,
      })
      const res = await post(buildSignedInApp(store), '/shifts', VALID_BODY)

      expect(res.status).toBe(201)
      expect(shiftResponse.parse(res.body)).toEqual(shift)
      expect(store.createShift).toHaveBeenCalledWith(USER.id, {
        branchId: BRANCH_ID,
        title: 'RN',
        startsAt: '2026-10-05T07:00:00.000Z',
        endsAt: '2026-10-05T19:00:00.000Z',
      })
    },
  )

  it.each([
    ['branch_not_found', 404],
    ['agency_inactive', 422],
    ['branch_inactive', 422],
    ['invalid_time_range', 400],
    ['actor_not_allowed', 403],
  ] as const)('maps %s to %i', async (outcome, status) => {
    const store = fakeDataStore({
      getProfile: asProfile(AGENCY_PROFILE),
      listBranches: async () => [MAIN_BRANCH],
      createShift: async () => ({ outcome, shiftId: null, eventId: null }),
    })
    const res = await post(buildSignedInApp(store), '/shifts', VALID_BODY)
    expect(res.status).toBe(status)
  })

  it('asks for a branch (400) when the caller has several and names none', async () => {
    const store = fakeDataStore({
      getProfile: asProfile(ADMIN_PROFILE),
      listBranches: async () => [
        MAIN_BRANCH,
        { ...MAIN_BRANCH, id: 'b1000000-0000-4000-8000-000000000002', name: 'North' },
      ],
    })
    const res = await post(buildSignedInApp(store), '/shifts', VALID_BODY)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Choose the branch this shift is for', code: 'validation_error' })
    expect(store.createShift).not.toHaveBeenCalled()
  })

  it.each([
    ['a blank role', { ...VALID_BODY, role: '   ' }],
    ['a malformed date', { ...VALID_BODY, date: '10/05/2026' }],
    ['an impossible date', { ...VALID_BODY, date: '2026-02-30' }],
    ['a malformed time', { ...VALID_BODY, startTime: '7am' }],
    ['a 24:00 time', { ...VALID_BODY, endTime: '24:00' }],
    ['a non-uuid branch', { ...VALID_BODY, branchId: 'downtown' }],
    ['an identity field', { ...VALID_BODY, createdById: 'attacker' }],
    [
      'the old body shape',
      { branchId: BRANCH_ID, title: 'x', startsAt: '2030-01-10T23:00:00Z', endsAt: '2030-01-11T07:00:00Z' },
    ],
  ])('returns 400 for %s', async (_label, body) => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await post(buildSignedInApp(store), '/shifts', body)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_error')
    expect(JSON.stringify(res.body)).not.toMatch(/attacker|7am/)
    expect(store.createShift).not.toHaveBeenCalled()
  })

  it('rejects a cross-site request before touching the store', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await request(buildSignedInApp(store))
      .post('/shifts')
      .set('Origin', 'https://evil.example')
      .set('Cookie', SESSION_COOKIE)
      .send(VALID_BODY)
    expect(res.status).toBe(403)
    expect(store.getProfile).not.toHaveBeenCalled()
  })
})

describe('GET /shifts/:shiftId', () => {
  it('returns 400 for a malformed id', async () => {
    const store = fakeDataStore({ getProfile: asProfile(ADMIN_PROFILE) })
    const res = await get(buildSignedInApp(store), '/shifts/Shift%201')
    expect(res.status).toBe(400)
  })

  it('returns 404 when the shift does not exist', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE), getShift: async () => null })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}`)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('shift_not_found')
  })

  it('returns the bare shift, looked up by its public id', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE), getShift: async () => shiftFixture() })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}`)
    expect(res.status).toBe(200)
    expect(shiftResponse.parse(res.body).id).toBe(SHIFT_ID)
    expect(store.getShift).toHaveBeenCalledWith(expect.anything(), SHIFT_ID)
  })
})

describe('POST /shifts/:shiftId/claim', () => {
  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('returns 403 for $role', async (profile) => {
    const store = fakeDataStore({ getProfile: asProfile(profile) })
    const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/claim`)
    expect(res.status).toBe(403)
    expect(store.claimShift).not.toHaveBeenCalled()
  })

  it('claims through the store with the session nurse id and returns the bare filled shift', async () => {
    const claimed = claimedShiftFixture()
    const store = fakeDataStore({
      getProfile: asProfile(NURSE_PROFILE),
      claimShift: async () => ({ outcome: 'claimed', shiftId: SHIFT_ID, eventId: SHIFT_ID }),
      getShift: async () => claimed,
    })
    const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/claim`, { nurseId: 'attacker' })

    expect(res.status).toBe(200)
    expect(shiftResponse.parse(res.body)).toEqual(claimed)
    expect(res.body).toMatchObject({ status: 'filled', claimedBy: NURSE_SLUG })
    expect(store.claimShift).toHaveBeenCalledWith(USER.id, SHIFT_ID)
  })

  it.each(['credential_expired', 'credential_missing', 'credential_revoked'] as const)(
    'answers 403 with the contract message for %s',
    async (outcome) => {
      const store = fakeDataStore({
        getProfile: asProfile(NURSE_PROFILE),
        claimShift: async () => ({ outcome, shiftId: SHIFT_ID, eventId: null }),
      })
      const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/claim`)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'Credential expired, cannot claim shift', code: outcome })
    },
  )

  it.each<[ClaimOutcome, number]>([
    ['shift_not_found', 404],
    ['shift_not_open', 409],
    ['schedule_conflict', 409],
    ['eligibility_inactive', 422],
    ['agency_inactive', 422],
    ['branch_inactive', 422],
    ['not_a_nurse', 403],
  ])('maps %s to %i with a safe error envelope', async (outcome, status) => {
    const store = fakeDataStore({
      getProfile: asProfile(NURSE_PROFILE),
      claimShift: async () => ({ outcome, shiftId: SHIFT_ID, eventId: null }),
    })
    const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/claim`)

    expect(res.status).toBe(status)
    expect(Object.keys(res.body).sort()).toEqual(['code', 'error'])
    expect(res.body).toEqual({ error: expect.any(String), code: expect.any(String) })
    if (status !== 403 && status !== 404) expect(res.body.code).toBe(outcome)
    expect(store.getShift).not.toHaveBeenCalled()
  })
})

describe('POST /shifts/:shiftId/cancel', () => {
  const cancelled = {
    outcome: 'cancelled' as const,
    shiftId: SHIFT_ID,
    eventId: 'f1000000-0000-4000-8000-000000000002',
    previousNurseId: '7c1e0d52-0000-4000-8000-000000000011',
    previousNurseSlug: NURSE_SLUG,
  }

  it.each([AGENCY_PROFILE, ADMIN_PROFILE, NURSE_PROFILE])(
    'reopens the shift as $role and reports who held it',
    async (profile) => {
      const reopened = shiftFixture()
      const store = fakeDataStore({
        getProfile: asProfile(profile),
        cancelClaim: async () => cancelled,
        getShift: async () => reopened,
      })
      const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/cancel`, { reason: 'no-show' })

      expect(res.status).toBe(200)
      expect(cancelResponse.parse(res.body)).toEqual({
        ...reopened,
        cancellation: { reason: 'no-show', previousNurseId: NURSE_SLUG },
      })
      expect(res.body).toMatchObject({ status: 'open', claimedBy: null })
      expect(store.cancelClaim).toHaveBeenCalledWith(USER.id, SHIFT_ID, 'no-show')
    },
  )

  it.each([
    ['shift_not_found', 404, 'shift_not_found'],
    ['shift_not_claimed', 409, 'shift_not_filled'],
    ['actor_not_allowed', 403, 'forbidden'],
    ['invalid_reason', 400, 'validation_error'],
  ] as const)('maps %s to %i %s', async (outcome, status, code) => {
    const store = fakeDataStore({
      getProfile: asProfile(AGENCY_PROFILE),
      cancelClaim: async () => ({
        outcome,
        shiftId: null,
        eventId: null,
        previousNurseId: null,
        previousNurseSlug: null,
      }),
    })
    const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/cancel`, { reason: 'advance' })
    expect(res.status).toBe(status)
    expect(res.body.code).toBe(code)
    expect(store.getShift).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing reason', {}],
    ['an unknown reason', { reason: 'late' }],
    ['an extra key', { reason: 'advance', nurseId: 'attacker' }],
  ])('rejects %s with 400 before touching the store', async (_label, body) => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/cancel`, body)
    expect(res.status).toBe(400)
    expect(store.cancelClaim).not.toHaveBeenCalled()
  })
})

describe('GET /shifts/:shiftId/events', () => {
  const event = {
    id: 'f1000000-0000-4000-8000-000000000001',
    eventType: 'created' as const,
    previousStatus: null,
    newStatus: 'open' as const,
    reason: null,
    occurredAt: '2029-12-01T00:00:00.000Z',
    actor: { id: USER.id, fullName: null },
  }

  it('returns 404 to a nurse for a shift not assigned to them', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), getShift: async () => shiftFixture() })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}/events`)
    expect(res.status).toBe(404)
    expect(store.listShiftEvents).not.toHaveBeenCalled()
  })

  it('returns history to the assigned nurse', async () => {
    const store = fakeDataStore({
      getProfile: asProfile(NURSE_PROFILE),
      getShift: async () => claimedShiftFixture(),
      listShiftEvents: async () => [event],
    })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}/events`)
    expect(res.status).toBe(200)
    expect(shiftEventsResponse.parse(res.body).events).toEqual([event])
  })

  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('returns history to $role when the shift is visible', async (profile) => {
    const store = fakeDataStore({
      getProfile: asProfile(profile),
      getShift: async () => shiftFixture(),
      listShiftEvents: async () => [event],
    })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}/events`)
    expect(res.status).toBe(200)
  })

  it('returns 404 when the shift does not exist', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE), getShift: async () => null })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}/events`)
    expect(res.status).toBe(404)
    expect(store.listShiftEvents).not.toHaveBeenCalled()
  })
})

describe('GET /me/shifts', () => {
  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('returns 403 for $role', async (profile) => {
    const store = fakeDataStore({ getProfile: asProfile(profile) })
    const res = await get(buildSignedInApp(store), '/me/shifts')
    expect(res.status).toBe(403)
  })

  it('splits assigned shifts into upcoming and past (most recent first)', async () => {
    const past1 = claimedShiftFixture({
      id: 'shift-11',
      startsAt: '2020-01-01T08:00:00.000Z',
      endsAt: '2020-01-01T16:00:00.000Z',
      status: 'completed',
    })
    const past2 = claimedShiftFixture({
      id: 'shift-12',
      startsAt: '2021-01-01T08:00:00.000Z',
      endsAt: '2021-01-01T16:00:00.000Z',
      status: 'completed',
    })
    const next = claimedShiftFixture({ id: 'shift-13' })
    const store = fakeDataStore({
      getProfile: asProfile(NURSE_PROFILE),
      listAssignedShifts: async () => [past1, past2, next],
    })
    const res = await get(buildSignedInApp(store), '/me/shifts')

    expect(res.status).toBe(200)
    const body = myShiftsResponse.parse(res.body)
    expect(body.upcoming.map((s) => s.id)).toEqual([next.id])
    expect(body.past.map((s) => s.id)).toEqual([past2.id, past1.id])
  })
})

describe('GET /agencies/:agencyId/shifts', () => {
  it('returns the agency’s shifts to its own agency user, wrapped with the agency id', async () => {
    const store = fakeDataStore({
      getProfile: asProfile(AGENCY_PROFILE),
      listShifts: async () => [shiftFixture(), claimedShiftFixture({ id: 'shift-2' })],
    })
    const res = await get(buildSignedInApp(store), `/agencies/${AGENCY_ID}/shifts`)
    expect(res.status).toBe(200)
    const body = agencyShiftsResponse.parse(res.body)
    expect(body.agencyId).toBe(AGENCY_ID)
    expect(body.shifts.map((s) => [s.id, s.status, s.claimedBy])).toEqual([
      ['shift-1', 'open', null],
      ['shift-2', 'filled', NURSE_SLUG],
    ])
    expect(store.listShifts.mock.calls[0]![1]).toEqual({ agencyId: AGENCY_ID })
  })

  it('lets an admin read any agency and forwards the filters', async () => {
    const store = fakeDataStore({ getProfile: asProfile(ADMIN_PROFILE), listShifts: async () => [] })
    const res = await get(buildSignedInApp(store), '/agencies/agency-b/shifts?status=open')
    expect(res.status).toBe(200)
    expect(store.listShifts.mock.calls[0]![1]).toEqual({ status: 'open', agencyId: 'agency-b' })
  })

  it('answers 403 for another agency and for nurses without touching the store', async () => {
    for (const profile of [AGENCY_PROFILE, NURSE_PROFILE]) {
      const store = fakeDataStore({ getProfile: asProfile(profile) })
      const res = await get(buildSignedInApp(store), '/agencies/agency-b/shifts')
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'Forbidden', code: 'forbidden' })
      expect(store.listShifts).not.toHaveBeenCalled()
    }
  })

  it('rejects a malformed agency id', async () => {
    const res = await get(
      buildSignedInApp(fakeDataStore({ getProfile: asProfile(ADMIN_PROFILE) })),
      '/agencies/Agency_A/shifts',
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /branches', () => {
  it('returns the branches visible to the caller with public agency ids', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE), listBranches: async () => [MAIN_BRANCH] })
    const res = await get(buildSignedInApp(store), '/branches')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ branches: [MAIN_BRANCH] })
  })
})

describe('data layer failures', () => {
  it('maps DataStoreError to a generic 500 without internals', async () => {
    const store = fakeDataStore({
      getProfile: asProfile(ADMIN_PROFILE),
      listShifts: async () => {
        throw new DataStoreError('list shifts failed (42501)')
      },
    })
    const res = await get(buildSignedInApp(store), '/shifts')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Internal server error', code: 'internal_error' })
  })

  it('maps DataUnavailableError to 503', async () => {
    const store = fakeDataStore({
      getProfile: asProfile(NURSE_PROFILE),
      claimShift: async () => {
        throw new DataUnavailableError()
      },
    })
    const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/claim`)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('data_unavailable')
  })
})
