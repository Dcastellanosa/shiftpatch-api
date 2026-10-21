import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { DataStoreError, DataUnavailableError } from '../../../../domain/ports/data-store/data-store.js'
import type { Profile } from '../../../../domain/viewer/viewer.js'
import type { ClaimOutcome } from '../../../../domain/outcomes/outcomes.js'
import type { Shift } from '../../../../domain/shift/shift.js'
import {
  myShiftsResponse,
  shiftEventsResponse,
  shiftListResponse,
  shiftResponse,
} from '../../schemas/shifts/shifts.js'
import {
  ADMIN_PROFILE,
  AGENCY_PROFILE,
  ALLOWED_ORIGIN,
  NURSE_PROFILE,
  SESSION,
  SESSION_COOKIE,
  USER,
  buildApp,
  buildSignedInApp,
  fakeAuthProvider,
  fakeDataStore,
} from '../../../../test-support/fakes.js'

const SHIFT_ID = 'e1000000-0000-4000-8000-0000000000aa'
const BRANCH_ID = 'b1000000-0000-4000-8000-000000000001'

function shift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: SHIFT_ID,
    title: 'Med-Surg RN — Day',
    startsAt: '2030-01-10T12:00:00.000Z',
    endsAt: '2030-01-10T20:00:00.000Z',
    status: 'open',
    branch: { id: BRANCH_ID, name: 'Downtown Clinic', address: '120 Main Street', timezone: 'America/New_York', status: 'active' },
    agency: { id: 'a1000000-0000-4000-8000-000000000001', name: 'Northwind Care Staffing' },
    assignedNurse: null,
    createdAt: '2029-12-01T00:00:00.000Z',
    updatedAt: '2029-12-01T00:00:00.000Z',
    ...overrides,
  }
}

const asProfile = (profile: Profile | null) => async () => profile

const get = (app: ReturnType<typeof buildApp>, path: string) => request(app).get(path).set('Cookie', SESSION_COOKIE)
const post = (app: ReturnType<typeof buildApp>, path: string, body?: object) =>
  request(app).post(path).set('Origin', ALLOWED_ORIGIN).set('Cookie', SESSION_COOKIE).send(body)

const VALID_BODY = {
  branchId: BRANCH_ID,
  title: '  ICU RN — Night  ',
  startsAt: '2030-01-10T23:00:00Z',
  endsAt: '2030-01-11T07:00:00Z',
}

describe('authentication and profile gate', () => {
  it.each([
    ['GET', '/shifts'],
    ['GET', `/shifts/${SHIFT_ID}`],
    ['GET', `/shifts/${SHIFT_ID}/events`],
    ['GET', '/me/shifts'],
    ['GET', '/branches'],
    ['POST', '/shifts'],
    ['POST', `/shifts/${SHIFT_ID}/claim`],
  ])('%s %s returns 401 without a session', async (method, path) => {
    const store = fakeDataStore()
    const app = buildApp(fakeAuthProvider(), 'test', store)
    const res =
      method === 'GET' ? await request(app).get(path) : await request(app).post(path).set('Origin', ALLOWED_ORIGIN)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthenticated')
    expect(store.getProfile).not.toHaveBeenCalled()
  })

  it('returns 403 profile_missing for a user without a profile', async () => {
    const store = fakeDataStore({ getProfile: asProfile(null) })
    const res = await get(buildSignedInApp(store), '/shifts')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('profile_missing')
  })

  it('returns 403 membership_inactive for an agency user without an active membership', async () => {
    const store = fakeDataStore({ getProfile: asProfile({ ...AGENCY_PROFILE, agencyIds: [], agencyId: null }) })
    const res = await get(buildSignedInApp(store), '/shifts')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('membership_inactive')
  })

  it('returns 503 when the data layer is not configured', async () => {
    const res = await get(buildSignedInApp(null), '/shifts')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('data_unavailable')
  })

  it('looks the profile up with the verified user id and the session token', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), listShifts: async () => [] })
    await get(buildSignedInApp(store), `/shifts?userId=someone-else&role=admin`)
    expect(store.getProfile).toHaveBeenCalledWith(SESSION.accessToken, USER.id)
    expect(store.listShifts.mock.calls[0]![0]).toMatchObject({ id: USER.id, role: 'nurse' })
  })
})

describe('GET /auth/me with a profile', () => {
  it('returns role, full name and agency from the profile', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await get(buildSignedInApp(store), '/auth/me')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      user: {
        id: USER.id,
        email: USER.email,
        fullName: AGENCY_PROFILE.fullName,
        role: 'agency',
        agencyId: AGENCY_PROFILE.agencyId,
        agencyIds: AGENCY_PROFILE.agencyIds,
      },
    })
  })
})

describe('GET /shifts', () => {
  it.each([NURSE_PROFILE, AGENCY_PROFILE, ADMIN_PROFILE])('lists shifts for role $role', async (profile) => {
    const store = fakeDataStore({ getProfile: asProfile(profile), listShifts: async () => [shift()] })
    const res = await get(buildSignedInApp(store), '/shifts')

    expect(res.status).toBe(200)
    expect(shiftListResponse.parse(res.body).shifts).toHaveLength(1)
    expect(store.listShifts.mock.calls[0]![0]).toMatchObject({ role: profile.role })
  })

  it('passes validated filters to the store', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), listShifts: async () => [] })
    const res = await get(
      buildSignedInApp(store),
      `/shifts?status=open&branchId=${BRANCH_ID}&from=2030-01-01T00:00:00Z&to=2030-02-01T00:00:00Z&includeAssigned=true`,
    )
    expect(res.status).toBe(200)
    expect(store.listShifts.mock.calls[0]![1]).toEqual({
      status: 'open',
      branchId: BRANCH_ID,
      from: '2030-01-01T00:00:00Z',
      to: '2030-02-01T00:00:00Z',
      includeAssigned: true,
    })
  })

  it.each([
    ['unknown status', 'status=archived'],
    ['non-uuid branch', 'branchId=downtown'],
    ['non-ISO date', 'from=yesterday'],
    ['inverted range', 'from=2030-02-01T00:00:00Z&to=2030-01-01T00:00:00Z'],
    ['non-boolean flag', 'includeAssigned=yes'],
  ])('returns 400 for %s', async (_label, query) => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE) })
    const res = await get(buildSignedInApp(store), `/shifts?${query}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
    expect(store.listShifts).not.toHaveBeenCalled()
  })

  it('rejects includeAssigned for non-nurses', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await get(buildSignedInApp(store), '/shifts?includeAssigned=true')
    expect(res.status).toBe(400)
  })
})

describe('POST /shifts', () => {
  it('returns 403 for nurses without calling the store', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE) })
    const res = await post(buildSignedInApp(store), '/shifts', VALID_BODY)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(store.createShift).not.toHaveBeenCalled()
  })

  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('creates a shift as $role using the session identity', async (profile) => {
    const store = fakeDataStore({
      getProfile: asProfile(profile),
      createShift: async () => ({ outcome: 'created', shiftId: SHIFT_ID, eventId: SHIFT_ID }),
      getShift: async () => shift(),
    })
    const res = await post(buildSignedInApp(store), '/shifts', { ...VALID_BODY, createdById: 'attacker' })

    expect(res.status).toBe(201)
    expect(shiftResponse.parse(res.body).shift.id).toBe(SHIFT_ID)
    expect(store.createShift).toHaveBeenCalledWith(USER.id, {
      branchId: BRANCH_ID,
      title: 'ICU RN — Night',
      startsAt: VALID_BODY.startsAt,
      endsAt: VALID_BODY.endsAt,
    })
  })

  it.each([
    ['branch_not_found', 404],
    ['agency_inactive', 422],
    ['branch_inactive', 422],
    ['shift_in_past', 422],
    ['actor_not_allowed', 403],
  ] as const)('maps %s to %i', async (outcome, status) => {
    const store = fakeDataStore({
      getProfile: asProfile(AGENCY_PROFILE),
      createShift: async () => ({ outcome, shiftId: null, eventId: null }),
    })
    const res = await post(buildSignedInApp(store), '/shifts', VALID_BODY)
    expect(res.status).toBe(status)
  })

  it.each([
    ['missing title', { ...VALID_BODY, title: '   ' }],
    ['ends before start', { ...VALID_BODY, endsAt: '2030-01-10T22:00:00Z' }],
    ['longer than 24 hours', { ...VALID_BODY, endsAt: '2030-01-12T00:00:00Z' }],
    ['non-uuid branch', { ...VALID_BODY, branchId: 'downtown' }],
    ['timestamp without zone', { ...VALID_BODY, startsAt: '2030-01-10T23:00:00' }],
  ])('returns 400 for %s', async (_label, body) => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await post(buildSignedInApp(store), '/shifts', body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
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
    const res = await get(buildSignedInApp(store), '/shifts/not-a-uuid')
    expect(res.status).toBe(400)
  })

  it('returns 404 when the shift is not visible to the caller', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE), getShift: async () => null })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('shift_not_found')
  })

  it('returns the shift', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE), getShift: async () => shift() })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}`)
    expect(res.status).toBe(200)
    expect(shiftResponse.parse(res.body).shift.id).toBe(SHIFT_ID)
  })
})

describe('POST /shifts/:shiftId/claim', () => {
  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('returns 403 for $role', async (profile) => {
    const store = fakeDataStore({ getProfile: asProfile(profile) })
    const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/claim`)
    expect(res.status).toBe(403)
    expect(store.claimShift).not.toHaveBeenCalled()
  })

  it('claims through the store with the session nurse id and returns the shift', async () => {
    const claimed = shift({ status: 'claimed', assignedNurse: { id: USER.id, fullName: 'Ava Thompson' } })
    const store = fakeDataStore({
      getProfile: asProfile(NURSE_PROFILE),
      claimShift: async () => ({ outcome: 'claimed', shiftId: SHIFT_ID, eventId: SHIFT_ID }),
      getShift: async () => claimed,
    })
    const res = await post(buildSignedInApp(store), `/shifts/${SHIFT_ID}/claim`, { nurseId: 'attacker' })

    expect(res.status).toBe(200)
    expect(shiftResponse.parse(res.body).shift).toEqual(claimed)
    expect(store.claimShift).toHaveBeenCalledWith(USER.id, SHIFT_ID)
  })

  it.each<[ClaimOutcome, number]>([
    ['shift_not_found', 404],
    ['shift_not_open', 409],
    ['schedule_conflict', 409],
    ['eligibility_inactive', 422],
    ['credential_missing', 422],
    ['credential_expired', 422],
    ['credential_revoked', 422],
    ['shift_started', 422],
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
    expect(Object.keys(res.body)).toEqual(['error'])
    expect(res.body.error).toEqual({ code: expect.any(String), message: expect.any(String) })
    if (status !== 403 && status !== 404) expect(res.body.error.code).toBe(outcome)
    expect(store.getShift).not.toHaveBeenCalled()
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
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), getShift: async () => shift() })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}/events`)
    expect(res.status).toBe(404)
    expect(store.listShiftEvents).not.toHaveBeenCalled()
  })

  it('returns history to the assigned nurse', async () => {
    const store = fakeDataStore({
      getProfile: asProfile(NURSE_PROFILE),
      getShift: async () => shift({ status: 'claimed', assignedNurse: { id: USER.id, fullName: 'Ava' } }),
      listShiftEvents: async () => [event],
    })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}/events`)
    expect(res.status).toBe(200)
    expect(shiftEventsResponse.parse(res.body).events).toEqual([event])
  })

  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('returns history to $role when the shift is visible', async (profile) => {
    const store = fakeDataStore({
      getProfile: asProfile(profile),
      getShift: async () => shift(),
      listShiftEvents: async () => [event],
    })
    const res = await get(buildSignedInApp(store), `/shifts/${SHIFT_ID}/events`)
    expect(res.status).toBe(200)
  })

  it('returns 404 to an agency user for another agency shift', async () => {
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
    const past1 = shift({ id: 'e1000000-0000-4000-8000-000000000001', startsAt: '2020-01-01T08:00:00.000Z', endsAt: '2020-01-01T16:00:00.000Z', status: 'completed' })
    const past2 = shift({ id: 'e1000000-0000-4000-8000-000000000002', startsAt: '2021-01-01T08:00:00.000Z', endsAt: '2021-01-01T16:00:00.000Z', status: 'completed' })
    const next = shift({ id: 'e1000000-0000-4000-8000-000000000003', status: 'claimed' })
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

describe('GET /branches', () => {
  it('returns the branches visible to the caller', async () => {
    const branch = {
      id: BRANCH_ID,
      name: 'Downtown Clinic',
      address: '120 Main Street',
      timezone: 'America/New_York',
      status: 'active' as const,
      agency: { id: AGENCY_PROFILE.agencyId!, name: 'Northwind Care Staffing' },
    }
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE), listBranches: async () => [branch] })
    const res = await get(buildSignedInApp(store), '/branches')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ branches: [branch] })
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
    expect(res.body).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } })
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
    expect(res.body.error.code).toBe('data_unavailable')
  })
})
