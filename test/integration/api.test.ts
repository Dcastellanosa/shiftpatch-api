import { beforeAll, describe, expect, it } from 'vitest'
import {
  agencyShiftsResponse,
  cancelResponse,
  myShiftsResponse,
  shiftEventsResponse,
  shiftListResponse,
  shiftResponse,
} from '../../src/interfaces/http/schemas/shifts/shifts.js'
import { AGENCIES, ALLOWED_ORIGIN, BRANCHES, SHIFTS, USERS, buildRealApp, signIn, windows } from './helpers.js'

type Agent = Awaited<ReturnType<typeof signIn>>

const app = buildRealApp()
const nextWindow = windows(600)
const agents = {} as Record<keyof typeof USERS, Agent>

const OPEN_HILLCREST = SHIFTS.find((s) => s.slug === 'shift-fixture-4')!

beforeAll(async () => {
  for (const key of Object.keys(USERS) as (keyof typeof USERS)[]) {
    agents[key] = await signIn(app, USERS[key])
  }
})

/** The contract body for a future window on `branchId` (facility-local in the branch zone; fixtures use US zones). */
function contractBody(branchId: string, role = 'RN', window = nextWindow()) {
  const timezone = Object.values(BRANCHES).find((b) => b.id === branchId)!.timezone
  const local = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(iso))
      .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {})
  const start = local(window.startsAt)
  const end = local(window.endsAt)
  return {
    role,
    date: `${start.year}-${start.month}-${start.day}`,
    startTime: `${start.hour}:${start.minute}`,
    endTime: `${end.hour}:${end.minute}`,
    branchId,
  }
}

async function createAs(agent: Agent, branchId: string, role = 'RN') {
  const res = await agent.post('/shifts').set('Origin', ALLOWED_ORIGIN).send(contractBody(branchId, role))
  expect(res.status).toBe(201)
  return shiftResponse.parse(res.body)
}

const claimAs = (agent: Agent, shiftId: string) =>
  agent.post(`/shifts/${shiftId}/claim`).set('Origin', ALLOWED_ORIGIN).send()
const cancelAs = (agent: Agent, shiftId: string, reason: string) =>
  agent.post(`/shifts/${shiftId}/cancel`).set('Origin', ALLOWED_ORIGIN).send({ reason })

describe('session payload', () => {
  it.each([
    ['admin', 'admin', USERS.admin.slug, null],
    ['northwindAgency', 'agency', AGENCIES.northwind.slug, AGENCIES.northwind.slug],
    ['harborAgency', 'agency', AGENCIES.harbor.slug, AGENCIES.harbor.slug],
    ['ava', 'nurse', USERS.ava.slug, null],
  ] as const)('%s gets role %s and public ids from the database', async (key, role, id, agencyId) => {
    const res = await agents[key].get('/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({
      id,
      name: USERS[key].fullName,
      email: USERS[key].email,
      role,
      agencyId,
      agencyIds: agencyId ? [agencyId] : [],
    })
    expect(JSON.stringify(res.body)).not.toMatch(/token/i)
    expect(JSON.stringify(res.body)).not.toContain(USERS[key].id)
  })

  it('returns the access token on login for API clients, and accepts it as a bearer under /api', async () => {
    const login = await agents.ava
      .post('/api/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: USERS.ava.email, password: (await import('vitest')).inject('seedPassword') })
    expect(login.status).toBe(200)
    expect(login.body.user).toMatchObject({ id: USERS.ava.slug, name: USERS.ava.fullName, role: 'nurse' })
    expect(typeof login.body.token).toBe('string')
    const res = await agents.admin.get('/api/shifts').set('Authorization', `Bearer ${login.body.token}`)
    expect(res.status).toBe(200)
    expect(shiftListResponse.parse(res.body).shifts.length).toBeGreaterThan(0)
  })
})

describe('the vertical slice: create → see → claim → status and history', () => {
  it('runs end to end across agency, nurse and admin', async () => {
    // 1. Agency creates an open shift for its branch (contract body).
    const created = await createAs(agents.northwindAgency, BRANCHES.downtown.id, 'Vertical slice RN')
    expect(created).toMatchObject({
      status: 'open',
      claimedBy: null,
      agencyId: AGENCIES.northwind.slug,
      agencyName: AGENCIES.northwind.name,
      role: 'Vertical slice RN',
    })
    expect(created.id).toMatch(/^shift-\d+$/)

    // 2. Every nurse sees it in the marketplace, eligible or not.
    for (const nurse of [agents.ava, agents.cora]) {
      const list = shiftListResponse.parse((await nurse.get('/shifts')).body)
      expect(list.shifts.map((s) => s.id)).toContain(created.id)
    }

    // 3. An eligible nurse claims it.
    const claimRes = await claimAs(agents.ava, created.id)
    expect(claimRes.status).toBe(200)
    expect(shiftResponse.parse(claimRes.body)).toMatchObject({
      id: created.id,
      status: 'filled',
      claimedBy: USERS.ava.slug,
      claimedByName: USERS.ava.fullName,
    })

    // It stays in the marketplace as filled and appears in My Shifts.
    const after = shiftListResponse.parse((await agents.ava.get('/shifts')).body)
    expect(after.shifts.find((s) => s.id === created.id)).toMatchObject({ status: 'filled', claimedBy: USERS.ava.slug })
    const mine = myShiftsResponse.parse((await agents.ava.get('/me/shifts')).body)
    expect(mine.upcoming.map((s) => s.id)).toContain(created.id)

    // 4. A second claim is rejected.
    const again = await claimAs(agents.eli, created.id)
    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: expect.any(String), code: 'shift_not_open' })

    // 5. Agency and admin see the assigned nurse and the history.
    for (const agent of [agents.northwindAgency, agents.admin]) {
      const shift = shiftResponse.parse((await agent.get(`/shifts/${created.id}`)).body)
      expect(shift).toMatchObject({ status: 'filled', claimedBy: USERS.ava.slug, claimedByName: USERS.ava.fullName })

      const history = shiftEventsResponse.parse((await agent.get(`/shifts/${created.id}/events`)).body).events
      expect(history.map((e) => [e.eventType, e.previousStatus, e.newStatus, e.actor.id])).toEqual([
        ['created', null, 'open', USERS.northwindAgency.id],
        ['claimed', 'open', 'filled', USERS.ava.id],
      ])
    }

    // The assigned nurse sees the history too.
    expect((await agents.ava.get(`/shifts/${created.id}/events`)).status).toBe(200)

    // 6. The agency reports a no-show: the shift reopens and the history says so.
    const cancelled = await cancelAs(agents.northwindAgency, created.id, 'no-show')
    expect(cancelled.status).toBe(200)
    expect(cancelResponse.parse(cancelled.body)).toMatchObject({
      id: created.id,
      status: 'open',
      claimedBy: null,
      cancellation: { reason: 'no-show', previousNurseId: USERS.ava.slug },
    })
    const events = shiftEventsResponse.parse((await agents.admin.get(`/shifts/${created.id}/events`)).body).events
    expect(events.at(-1)).toMatchObject({
      eventType: 'no_show',
      previousStatus: 'filled',
      newStatus: 'open',
      reason: 'no-show',
      actor: { id: USERS.northwindAgency.id },
    })

    // 7. Another nurse can take it now.
    expect((await claimAs(agents.eli, created.id)).status).toBe(200)
  })
})

describe('claim rule failures over HTTP', () => {
  it.each([
    ['ben', 'credential_expired', 403, 'Credential expired, cannot claim shift'],
    ['dev', 'credential_missing', 403, 'Credential expired, cannot claim shift'],
    ['cora', 'eligibility_inactive', 422, expect.any(String)],
  ] as const)('%s gets %s', async (nurse, code, status, message) => {
    const shift = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    const res = await claimAs(agents[nurse], shift.id)
    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error: message, code })

    const still = shiftResponse.parse((await agents.northwindAgency.get(`/shifts/${shift.id}`)).body)
    expect(still).toMatchObject({ status: 'open', claimedBy: null })
  })

  it('returns 409 schedule_conflict for an overlapping shift', async () => {
    const window = nextWindow()
    const first = await agents.northwindAgency
      .post('/shifts')
      .set('Origin', ALLOWED_ORIGIN)
      .send(contractBody(BRANCHES.downtown.id, 'First', window))
    const second = await agents.northwindAgency
      .post('/shifts')
      .set('Origin', ALLOWED_ORIGIN)
      .send(contractBody(BRANCHES.riverside.id, 'Overlapping', window))
    expect([first.status, second.status]).toEqual([201, 201])

    expect((await claimAs(agents.ava, first.body.id)).status).toBe(200)
    const res = await claimAs(agents.ava, second.body.id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('schedule_conflict')
  })

  it('lets exactly one of two simultaneous claims win', async () => {
    const shift = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    const results = await Promise.all([claimAs(agents.ava, shift.id), claimAs(agents.eli, shift.id)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])

    const history = shiftEventsResponse.parse((await agents.admin.get(`/shifts/${shift.id}/events`)).body).events
    expect(history.filter((e) => e.eventType === 'claimed')).toHaveLength(1)
  })

  it('accepts a shift that already started (the contract seed is dated)', async () => {
    const past = {
      ...contractBody(BRANCHES.downtown.id, 'Yesterday'),
      date: '2026-01-05',
      startTime: '08:00',
      endTime: '16:00',
    }
    const created = await agents.northwindAgency.post('/shifts').set('Origin', ALLOWED_ORIGIN).send(past)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ date: '2026-01-05', startTime: '08:00', endTime: '16:00' })
    expect((await claimAs(agents.ava, created.body.id)).status).toBe(200)
  })
})

describe('cancellation over HTTP', () => {
  async function claimed() {
    const shift = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    expect((await claimAs(agents.ava, shift.id)).status).toBe(200)
    return shift
  }

  it('lets the assigned nurse cancel in advance', async () => {
    const shift = await claimed()
    const res = await cancelAs(agents.ava, shift.id, 'advance')
    expect(res.status).toBe(200)
    expect(cancelResponse.parse(res.body).cancellation).toEqual({ reason: 'advance', previousNurseId: USERS.ava.slug })
  })

  it('refuses other agencies, other nurses, open shifts and bad reasons', async () => {
    const shift = await claimed()
    expect((await cancelAs(agents.harborAgency, shift.id, 'advance')).status).toBe(403)
    expect((await cancelAs(agents.eli, shift.id, 'advance')).status).toBe(403)
    const open = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    const notFilled = await cancelAs(agents.admin, open.id, 'no-show')
    expect(notFilled.status).toBe(409)
    expect(notFilled.body.code).toBe('shift_not_filled')
    expect((await cancelAs(agents.admin, shift.id, 'late')).status).toBe(400)
    expect(shiftResponse.parse((await agents.admin.get(`/shifts/${shift.id}`)).body)).toMatchObject({
      status: 'filled',
      claimedBy: USERS.ava.slug,
    })
  })
})

describe('role authorization', () => {
  it('nurses cannot create shifts', async () => {
    const res = await agents.ava.post('/shifts').set('Origin', ALLOWED_ORIGIN).send(contractBody(BRANCHES.downtown.id))
    expect(res.status).toBe(403)
  })

  it.each(['northwindAgency', 'admin'] as const)('%s cannot claim shifts', async (key) => {
    const shift = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    const res = await claimAs(agents[key], shift.id)
    expect(res.status).toBe(403)
  })

  it('admin can create shifts for any agency', async () => {
    const shift = await createAs(agents.admin, BRANCHES.hillcrest.id)
    expect(shift.agencyId).toBe(AGENCIES.harbor.slug)
  })

  it('an admin without a branch is asked to choose one', async () => {
    const body: Partial<ReturnType<typeof contractBody>> = contractBody(BRANCHES.hillcrest.id)
    delete body.branchId
    const res = await agents.admin.post('/shifts').set('Origin', ALLOWED_ORIGIN).send(body)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Choose the branch this shift is for', code: 'validation_error' })
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

describe('agency views', () => {
  it('GET /agencies/:agencyId/shifts returns only that agency, to its own users and admins', async () => {
    const created = await createAs(agents.northwindAgency, BRANCHES.downtown.id)
    for (const agent of [agents.northwindAgency, agents.admin]) {
      const body = agencyShiftsResponse.parse((await agent.get(`/agencies/${AGENCIES.northwind.slug}/shifts`)).body)
      expect(body.agencyId).toBe(AGENCIES.northwind.slug)
      expect(body.shifts.length).toBeGreaterThan(0)
      expect(body.shifts.every((s) => s.agencyId === AGENCIES.northwind.slug)).toBe(true)
      expect(body.shifts.map((s) => s.id)).toContain(created.id)
    }
    expect((await agents.harborAgency.get(`/agencies/${AGENCIES.northwind.slug}/shifts`)).status).toBe(403)
    expect((await agents.ava.get(`/agencies/${AGENCIES.northwind.slug}/shifts`)).status).toBe(403)
    expect((await agents.admin.get('/agencies/no-such-agency/shifts')).body).toEqual({
      agencyId: 'no-such-agency',
      shifts: [],
    })
  })

  it('an agency cannot create in another agency, and sees no history of its shifts', async () => {
    expect((await agents.northwindAgency.get(`/shifts/${OPEN_HILLCREST.slug}/events`)).status).toBe(404)
    const res = await agents.northwindAgency
      .post('/shifts')
      .set('Origin', ALLOWED_ORIGIN)
      .send(contractBody(BRANCHES.bayview.id))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('branch_not_found')
  })

  it('each agency lists only its own branches', async () => {
    for (const [key, agency] of [
      ['northwindAgency', AGENCIES.northwind],
      ['harborAgency', AGENCIES.harbor],
    ] as const) {
      const branches = (await agents[key].get('/branches')).body.branches as { agency: { id: string } }[]
      expect(branches.length).toBeGreaterThan(0)
      expect(branches.every((b) => b.agency.id === agency.slug)).toBe(true)
    }
  })

  it('admin lists shifts from every agency, inactive ones included, and can filter', async () => {
    const all = shiftListResponse.parse((await agents.admin.get('/shifts')).body).shifts
    const agencyIds = new Set(all.map((s) => s.agencyId))
    for (const agency of Object.values(AGENCIES)) expect(agencyIds.has(agency.slug)).toBe(true)

    const filled = shiftListResponse.parse((await agents.admin.get('/shifts?status=filled')).body).shifts
    expect(filled.length).toBeGreaterThan(0)
    expect(filled.every((s) => s.status === 'filled' && s.claimedBy)).toBe(true)

    const bayview = shiftListResponse.parse((await agents.admin.get(`/shifts?branchId=${BRANCHES.bayview.id}`)).body)
    expect(bayview.shifts.every((s) => s.branch.id === BRANCHES.bayview.id)).toBe(true)

    const harbor = shiftListResponse.parse((await agents.admin.get(`/shifts?agencyId=${AGENCIES.harbor.slug}`)).body)
    expect(harbor.shifts.length).toBeGreaterThan(0)
    expect(harbor.shifts.every((s) => s.agencyId === AGENCIES.harbor.slug)).toBe(true)
  })
})

describe('the marketplace', () => {
  it('shows every shift across every agency to every nurse, in the contract shape', async () => {
    for (const nurse of [agents.ava, agents.cora]) {
      const shifts = shiftListResponse.parse((await nurse.get('/shifts')).body).shifts
      expect(shifts.map((s) => s.id)).toEqual(
        expect.arrayContaining(['shift-1', 'shift-2', 'shift-3', OPEN_HILLCREST.slug]),
      )
      const shift2 = shifts.find((s) => s.id === 'shift-2')!
      expect(shift2).toMatchObject({
        agencyId: 'agency-a',
        agencyName: 'Sunrise Health Staffing',
        role: 'LPN',
        date: '2026-10-03',
        startTime: '07:00',
        endTime: '19:00',
        status: 'filled',
        claimedBy: 'nurse-1',
      })
      for (const shift of shifts)
        expect(Object.keys(shift)).toEqual(
          expect.arrayContaining([
            'id',
            'agencyId',
            'agencyName',
            'role',
            'date',
            'startTime',
            'endTime',
            'status',
            'claimedBy',
          ]),
        )
    }
  })

  it('splits My Shifts into upcoming and past', async () => {
    const mine = myShiftsResponse.parse((await agents.ava.get('/me/shifts')).body)
    expect(mine.past.some((s) => s.status === 'completed')).toBe(true)
    expect(mine.upcoming.every((s) => Date.parse(s.endsAt) > Date.now())).toBe(true)
  })
})
