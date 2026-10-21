import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eligibilityResponse, nurseListResponse } from '../../src/interfaces/http/schemas/eligibility/eligibility.js'
import { shiftListResponse } from '../../src/interfaces/http/schemas/shifts/shifts.js'
import { AGENCIES, ALLOWED_ORIGIN, BRANCHES, USERS, buildRealApp, openPool, signIn, windows } from './helpers.js'

type Agent = Awaited<ReturnType<typeof signIn>>

const app = buildRealApp()
const pool = openPool()
const nextWindow = windows(1000)
const agents = {} as Record<'admin' | 'northwindAgency' | 'harborAgency' | 'ava' | 'eli', Agent>

beforeAll(async () => {
  for (const key of ['admin', 'northwindAgency', 'harborAgency', 'ava', 'eli'] as const) {
    agents[key] = await signIn(app, USERS[key])
  }
})

afterAll(async () => {
  // Restore the seeded eligibility so later files see the fixtures they expect.
  await pool.query(
    `update shiftpatch.branch_nurse_eligibility set status = 'active', activated_at = coalesce(activated_at, now())
     where nurse_id = $1 and branch_id in ($2, $3, $4)`,
    [USERS.ava.id, BRANCHES.downtown.id, BRANCHES.riverside.id, BRANCHES.bayview.id],
  )
  await pool.query(`delete from shiftpatch.agency_memberships where profile_id = $1 and agency_id = $2`, [
    USERS.northwindAgency.id,
    AGENCIES.harbor.id,
  ])
})

const put = (agent: Agent, nurseId: string, branchId: string) =>
  agent.put(`/nurses/${nurseId}/eligibility/${branchId}`).set('Origin', ALLOWED_ORIGIN).send()
const del = (agent: Agent, nurseId: string, branchId: string) =>
  agent.delete(`/nurses/${nurseId}/eligibility/${branchId}`).set('Origin', ALLOWED_ORIGIN).send()
const claim = (agent: Agent, shiftId: string) =>
  agent.post(`/shifts/${shiftId}/claim`).set('Origin', ALLOWED_ORIGIN).send()

describe('GET /agency/nurses', () => {
  it('lists the nurses connected to Northwind with statuses at Northwind branches only', async () => {
    const res = await agents.northwindAgency.get('/agency/nurses')
    expect(res.status).toBe(200)
    const nurses = nurseListResponse.parse(res.body).nurses
    const byId = new Map(nurses.map((n) => [n.nurse.id, n]))
    expect([...byId.keys()]).toEqual(
      expect.arrayContaining([USERS.ava.slug, USERS.ben.slug, USERS.cora.slug, USERS.dev.slug, USERS.eli.slug]),
    )

    const ava = byId.get(USERS.ava.slug)!
    expect(ava.nurse.fullName).toBe(USERS.ava.fullName)
    expect(ava.branches.map((b) => [b.branch.id, b.status]).sort()).toEqual(
      [
        [BRANCHES.downtown.id, 'active'],
        [BRANCHES.riverside.id, 'active'],
      ].sort(),
    )
    for (const nurse of nurses) {
      for (const row of nurse.branches) expect(row.branch.agency.id).toBe(AGENCIES.northwind.slug)
    }
    expect(byId.get(USERS.cora.slug)!.branches).toEqual([
      {
        branch: {
          id: BRANCHES.downtown.id,
          name: BRANCHES.downtown.name,
          agency: { id: AGENCIES.northwind.slug, name: AGENCIES.northwind.name },
        },
        status: 'pending',
        activatedAt: null,
      },
    ])
  })

  it('is closed to admins and nurses', async () => {
    expect((await agents.admin.get('/agency/nurses')).status).toBe(403)
    expect((await agents.ava.get('/agency/nurses')).status).toBe(403)
  })
})

describe('eligibility changes and their effect on claims', () => {
  it('Harbor cannot touch Ava at Downtown (404), and sees no Downtown data', async () => {
    const res = await del(agents.harborAgency, USERS.ava.slug, BRANCHES.downtown.id)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('branch_not_found')
    const { rows } = await pool.query(
      'select status from shiftpatch.branch_nurse_eligibility where nurse_id = $1 and branch_id = $2',
      [USERS.ava.id, BRANCHES.downtown.id],
    )
    expect(rows).toEqual([{ status: 'active' }])
  })

  it('Northwind cannot reach a nurse who is not connected to it, and an unknown nurse answers the same', async () => {
    // The trial nurses are connected to Sunrise and Metro only, never to Northwind.
    const stranger = await put(agents.northwindAgency, 'nurse-1', BRANCHES.downtown.id)
    expect(stranger.status).toBe(404)
    expect(stranger.body.code).toBe('nurse_not_found')
    const unknown = await put(agents.northwindAgency, 'nurse-404', BRANCHES.downtown.id)
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('nurse_not_found')
  })

  it('suspending Ava at Downtown hides and blocks its shifts; re-activating restores them', async () => {
    const window = nextWindow()
    const created = await agents.northwindAgency
      .post('/shifts')
      .set('Origin', ALLOWED_ORIGIN)
      .send({
        role: 'Eligibility RN',
        date: window.startsAt.slice(0, 10),
        startTime: '08:00',
        endTime: '16:00',
        branchId: BRANCHES.downtown.id,
      })
    expect(created.status).toBe(201)
    const shiftId = created.body.id as string

    const suspended = await del(agents.northwindAgency, USERS.ava.slug, BRANCHES.downtown.id)
    expect(suspended.status).toBe(200)
    expect(eligibilityResponse.parse(suspended.body).eligibility).toMatchObject({
      nurseId: USERS.ava.slug,
      branchId: BRANCHES.downtown.id,
      status: 'suspended',
    })

    // The marketplace still lists the shift; the claim is what eligibility gates.
    const listed = shiftListResponse.parse((await agents.ava.get('/shifts')).body).shifts
    expect(listed.map((s) => s.id)).toContain(shiftId)
    const blocked = await claim(agents.ava, shiftId)
    expect(blocked.status).toBe(422)
    expect(blocked.body.code).toBe('eligibility_inactive')

    const activated = await put(agents.northwindAgency, USERS.ava.slug, BRANCHES.downtown.id)
    expect(activated.status).toBe(200)
    expect(eligibilityResponse.parse(activated.body).eligibility.status).toBe('active')
    expect((await claim(agents.ava, shiftId)).status).toBe(200)
  })

  it('an admin can activate a nurse at any branch, and inactive branches refuse changes', async () => {
    const res = await put(agents.admin, USERS.eli.slug, BRANCHES.bayview.id)
    expect(res.status).toBe(200)
    await pool.query('delete from shiftpatch.branch_nurse_eligibility where nurse_id = $1 and branch_id = $2', [
      USERS.eli.id,
      BRANCHES.bayview.id,
    ])

    const inactive = await put(agents.admin, USERS.ava.slug, BRANCHES.lakesideClinic.id)
    expect(inactive.status).toBe(422)
    expect(inactive.body.code).toBe('agency_inactive')
  })

  it('nurses cannot manage eligibility', async () => {
    expect((await put(agents.ava, USERS.ava.slug, BRANCHES.hillcrest.id)).status).toBe(403)
  })
})

describe('an agency user with several active memberships', () => {
  it('sees both agencies in the session, branches and nurses', async () => {
    await pool.query(
      `insert into shiftpatch.agency_memberships (profile_id, agency_id, status) values ($1, $2, 'active')`,
      [USERS.northwindAgency.id, AGENCIES.harbor.id],
    )
    const both = await signIn(app, USERS.northwindAgency)

    const me = await both.get('/auth/me')
    expect(me.body.user.agencyIds.sort()).toEqual([AGENCIES.northwind.slug, AGENCIES.harbor.slug].sort())
    expect([AGENCIES.northwind.slug, AGENCIES.harbor.slug]).toContain(me.body.user.agencyId)
    expect(me.body.user.id).toBe(me.body.user.agencyId)

    const branches = (await both.get('/branches')).body.branches as { agency: { id: string } }[]
    expect(new Set(branches.map((b) => b.agency.id))).toEqual(new Set([AGENCIES.northwind.slug, AGENCIES.harbor.slug]))

    const nurses = nurseListResponse.parse((await both.get('/agency/nurses')).body).nurses
    const agencies = new Set(nurses.flatMap((n) => n.branches.map((b) => b.branch.agency.id)))
    expect(agencies).toEqual(new Set([AGENCIES.northwind.slug, AGENCIES.harbor.slug]))

    const harborChange = await put(both, USERS.ava.slug, BRANCHES.bayview.id)
    expect(harborChange.status).toBe(200)
  })
})
