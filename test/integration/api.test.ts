import { beforeAll, describe, expect, it } from 'vitest'
import {
  myShiftsResponse,
  shiftEventsResponse,
  shiftListResponse,
  shiftResponse,
} from '../../src/interfaces/http/schemas/shifts/shifts.js'
import {
  AGENCIES,
  ALLOWED_ORIGIN,
  BRANCHES,
  SHIFTS,
  USERS,
  buildRealApp,
  signIn,
  windows,
} from './helpers.js'

type Agent = Awaited<ReturnType<typeof signIn>>

const app = buildRealApp()
const nextWindow = windows(600)
const agents = {} as Record<keyof typeof USERS, Agent>

const OPEN_HILLCREST = SHIFTS.find((s) => s.id === 'e1000000-0000-4000-8000-000000000004')!

beforeAll(async () => {
  for (const key of Object.keys(USERS) as (keyof typeof USERS)[]) {
    agents[key] = await signIn(app, USERS[key])
  }
})

async function createAs(agent: Agent, branchId: string, title = 'API fixture') {
  const res = await agent
    .post('/shifts')
    .set('Origin', ALLOWED_ORIGIN)
    .send({ branchId, title, ...nextWindow() })
  expect(res.status).toBe(201)
  return shiftResponse.parse(res.body).shift
}

const claimAs = (agent: Agent, shiftId: string) =>
  agent.post(`/shifts/${shiftId}/claim`).set('Origin', ALLOWED_ORIGIN).send()

describe('session payload', () => {
  it.each([
    ['admin', 'admin', null],
    ['northwindAgency', 'agency', AGENCIES.northwind.id],
    ['harborAgency', 'agency', AGENCIES.harbor.id],
    ['ava', 'nurse', null],
  ] as const)('%s gets role %s from the database', async (key, role, agencyId) => {
    const res = await agents[key].get('/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ id: USERS[key].id, role, agencyId, fullName: USERS[key].fullName })
    expect(JSON.stringify(res.body)).not.toMatch(/token/i)
  })
})

describe('the vertical slice: create → see → claim → status and history', () => {
  it('runs end to end across agency, nurse and admin', async () => {
    // 1. Agency creates an open shift for its branch.
    const created = await createAs(agents.northwindAgency, BRANCHES.downtown.id, 'Vertical slice shift')
    expect(created).toMatchObject({ status: 'open', assignedNurse: null, agency: { id: AGENCIES.northwind.id } })

    // 2. An eligible nurse sees it.
    const list = shiftListResponse.parse((await agents.ava.get('/shifts')).body)
    expect(list.shifts.map((s) => s.id)).toContain(created.id)

    // 3. The nurse claims it.
    const claimRes = await claimAs(agents.ava, created.id)
    expect(claimRes.status).toBe(200)
    expect(shiftResponse.parse(claimRes.body).shift).toMatchObject({
      status: 'claimed',
      assignedNurse: { id: USERS.ava.id, fullName: USERS.ava.fullName },
    })

    // It leaves the available list and appears in My Shifts.
    const after = shiftListResponse.parse((await agents.ava.get('/shifts')).body)
    expect(after.shifts.map((s) => s.id)).not.toContain(created.id)
    const mine = myShiftsResponse.parse((await agents.ava.get('/me/shifts')).body)
    expect(mine.upcoming.map((s) => s.id)).toContain(created.id)
    const withAssigned = shiftListResponse.parse((await agents.ava.get('/shifts?includeAssigned=true')).body)
    expect(withAssigned.shifts.map((s) => s.id)).toContain(created.id)

    // 4. A second claim is rejected.
    const again = await claimAs(agents.eli, created.id)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('shift_not_open')

    // 5. Agency and admin see the assigned nurse and the history.
    for (const agent of [agents.northwindAgency, agents.admin]) {
      const shift = shiftResponse.parse((await agent.get(`/shifts/${created.id}`)).body).shift
      expect(shift.status).toBe('claimed')
      expect(shift.assignedNurse).toEqual({ id: USERS.ava.id, fullName: USERS.ava.fullName })

      const history = shiftEventsResponse.parse((await agent.get(`/shifts/${created.id}/events`)).body).events
      expect(history.map((e) => [e.eventType, e.previousStatus, e.newStatus, e.actor.id])).toEqual([
        ['created', null, 'open', USERS.northwindAgency.id],
        ['claimed', 'open', 'claimed', USERS.ava.id],
      ])
    }

    // The assigned nurse sees the history too.
    const nurseHistory = await agents.ava.get(`/shifts/${created.id}/events`)
    expect(nurseHistory.status).toBe(200)
  })
})

describe('claim rule failures over HTTP', () => {
  it.each([
    ['ben', 'credential_expired', 422],
    ['cora', 'eligibility_inactive', 422],
    ['dev', 'credential_missing', 422],
  ] as const)('%s gets %s', async (nurse, code, status) => {
    const shift = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    const res = await claimAs(agents[nurse], shift.id)
    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error: { code, message: expect.any(String) } })

    const still = shiftResponse.parse((await agents.northwindAgency.get(`/shifts/${shift.id}`)).body).shift
    expect(still).toMatchObject({ status: 'open', assignedNurse: null })
  })

  it('returns 409 schedule_conflict for an overlapping shift', async () => {
    const window = nextWindow()
    const first = await agents.northwindAgency
      .post('/shifts')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ branchId: BRANCHES.downtown.id, title: 'First', ...window })
    const second = await agents.northwindAgency
      .post('/shifts')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ branchId: BRANCHES.riverside.id, title: 'Overlapping', ...window })

    expect((await claimAs(agents.ava, first.body.shift.id)).status).toBe(200)
    const res = await claimAs(agents.ava, second.body.shift.id)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('schedule_conflict')
  })

  it('lets exactly one of two simultaneous claims win', async () => {
    const shift = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    const results = await Promise.all([claimAs(agents.ava, shift.id), claimAs(agents.eli, shift.id)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])

    const history = shiftEventsResponse.parse((await agents.admin.get(`/shifts/${shift.id}/events`)).body).events
    expect(history.filter((e) => e.eventType === 'claimed')).toHaveLength(1)
  })
})

describe('role authorization', () => {
  it('nurses cannot create shifts', async () => {
    const res = await agents.ava
      .post('/shifts')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ branchId: BRANCHES.downtown.id, title: 'Nope', ...nextWindow() })
    expect(res.status).toBe(403)
  })

  it.each(['northwindAgency', 'admin'] as const)('%s cannot claim shifts', async (key) => {
    const shift = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    const res = await claimAs(agents[key], shift.id)
    expect(res.status).toBe(403)
  })

  it('admin can create shifts for any agency', async () => {
    const shift = await createAs(agents.admin, BRANCHES.hillcrest.id)
    expect(shift.agency.id).toBe(AGENCIES.harbor.id)
  })

  it('/me/shifts is nurse-only', async () => {
    expect((await agents.admin.get('/me/shifts')).status).toBe(403)
    expect((await agents.northwindAgency.get('/me/shifts')).status).toBe(403)
  })

  it('a nurse cannot read history for a shift not assigned to them', async () => {
    const shift = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    expect((await agents.ava.get(`/shifts/${shift.id}`)).status).toBe(200)
    expect((await agents.ava.get(`/shifts/${shift.id}/events`)).status).toBe(404)
  })
})

describe('agency isolation over HTTP', () => {
  it('each agency lists only its own shifts and branches', async () => {
    for (const [key, agencyId] of [
      ['northwindAgency', AGENCIES.northwind.id],
      ['harborAgency', AGENCIES.harbor.id],
    ] as const) {
      const shifts = shiftListResponse.parse((await agents[key].get('/shifts')).body).shifts
      expect(shifts.length).toBeGreaterThan(0)
      expect(shifts.every((s) => s.agency.id === agencyId)).toBe(true)

      const branches = (await agents[key].get('/branches')).body.branches as { agency: { id: string } }[]
      expect(branches.every((b) => b.agency.id === agencyId)).toBe(true)
    }
  })

  it('an agency cannot read, inspect or create in another agency', async () => {
    expect((await agents.northwindAgency.get(`/shifts/${OPEN_HILLCREST.id}`)).status).toBe(404)
    expect((await agents.northwindAgency.get(`/shifts/${OPEN_HILLCREST.id}/events`)).status).toBe(404)

    const res = await agents.northwindAgency
      .post('/shifts')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ branchId: BRANCHES.bayview.id, title: 'Cross-agency', ...nextWindow() })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('branch_not_found')
  })

  it('a branchId filter for another agency returns nothing', async () => {
    const res = await agents.northwindAgency.get(`/shifts?branchId=${BRANCHES.bayview.id}`)
    expect(res.status).toBe(200)
    expect(res.body.shifts).toEqual([])
  })

  it('admin lists shifts from every agency, inactive ones included, and can filter', async () => {
    const all = shiftListResponse.parse((await agents.admin.get('/shifts')).body).shifts
    expect(new Set(all.map((s) => s.agency.id))).toEqual(new Set(Object.values(AGENCIES).map((a) => a.id)))

    const claimed = shiftListResponse.parse((await agents.admin.get('/shifts?status=claimed')).body).shifts
    expect(claimed.length).toBeGreaterThan(0)
    expect(claimed.every((s) => s.status === 'claimed' && s.assignedNurse)).toBe(true)

    const bayview = shiftListResponse.parse((await agents.admin.get(`/shifts?branchId=${BRANCHES.bayview.id}`)).body)
    expect(bayview.shifts.every((s) => s.branch.id === BRANCHES.bayview.id)).toBe(true)
  })
})

describe('nurse listing', () => {
  it('shows only future open shifts from actively eligible branches', async () => {
    const shifts = shiftListResponse.parse((await agents.ava.get('/shifts')).body).shifts
    const eligible: string[] = [BRANCHES.downtown.id, BRANCHES.riverside.id, BRANCHES.bayview.id]
    expect(shifts.length).toBeGreaterThan(0)
    for (const shift of shifts) {
      expect(shift.status).toBe('open')
      expect(eligible).toContain(shift.branch.id)
      expect(Date.parse(shift.startsAt)).toBeGreaterThan(Date.now())
    }
  })

  it('shows nothing to a nurse without active eligibility', async () => {
    expect((await agents.cora.get('/shifts')).body).toEqual({ shifts: [] })
  })

  it('splits My Shifts into upcoming and past', async () => {
    const mine = myShiftsResponse.parse((await agents.ava.get('/me/shifts')).body)
    expect(mine.past.some((s) => s.status === 'completed')).toBe(true)
    expect(mine.upcoming.every((s) => Date.parse(s.endsAt) > Date.now())).toBe(true)
  })
})
