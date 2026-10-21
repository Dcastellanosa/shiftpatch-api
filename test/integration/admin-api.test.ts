import { beforeAll, describe, expect, it } from 'vitest'
import {
  agencyDetailResponse,
  agencyListResponse,
  agencyResponse,
  branchResponse,
} from '../../src/interfaces/http/schemas/admin/admin.js'
import { shiftListResponse, shiftResponse } from '../../src/interfaces/http/schemas/shifts/shifts.js'
import { AGENCIES, ALLOWED_ORIGIN, BRANCHES, USERS, buildRealApp, openPool, signIn, windows } from './helpers.js'

type Agent = Awaited<ReturnType<typeof signIn>>

const app = buildRealApp()
const pool = openPool()
const nextWindow = windows(800)
const agents = {} as Record<'admin' | 'northwindAgency' | 'harborAgency' | 'ava', Agent>

beforeAll(async () => {
  agents.admin = await signIn(app, USERS.admin)
  agents.northwindAgency = await signIn(app, USERS.northwindAgency)
  agents.harborAgency = await signIn(app, USERS.harborAgency)
  agents.ava = await signIn(app, USERS.ava)
})

const post = (agent: Agent, path: string, body: object) => agent.post(path).set('Origin', ALLOWED_ORIGIN).send(body)
const patch = (agent: Agent, path: string, body: object) => agent.patch(path).set('Origin', ALLOWED_ORIGIN).send(body)

describe('admin agency and branch lifecycle over HTTP', () => {
  const name = `HTTP Agency ${Date.now()}`
  let agencyId: string
  let branchId: string

  it('creates an agency, lists it with a zero branch count and reads it back', async () => {
    const created = await post(agents.admin, '/admin/agencies', { name })
    expect(created.status).toBe(201)
    const agency = agencyResponse.parse(created.body).agency
    expect(agency).toMatchObject({ name, status: 'active', branchCount: 0 })
    agencyId = agency.id

    const list = agencyListResponse.parse((await agents.admin.get('/admin/agencies')).body).agencies
    expect(list.map((a) => a.id)).toEqual(expect.arrayContaining([agencyId, AGENCIES.northwind.id, AGENCIES.lakeside.id]))
    expect(list.find((a) => a.id === AGENCIES.lakeside.id)).toMatchObject({ status: 'inactive', branchCount: 1 })

    const detail = agencyDetailResponse.parse((await agents.admin.get(`/admin/agencies/${agencyId}`)).body)
    expect(detail).toEqual({ agency, branches: [] })
  })

  it('refuses a duplicate agency name with 409', async () => {
    const res = await post(agents.admin, '/admin/agencies', { name })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: { code: 'name_taken', message: expect.any(String) } })
  })

  it('creates a branch and shows it in the detail and in /branches', async () => {
    const res = await post(agents.admin, `/admin/agencies/${agencyId}/branches`, {
      name: 'Harbor Annex',
      address: '2 Pier Road',
      timezone: 'America/Los_Angeles',
    })
    expect(res.status).toBe(201)
    const branch = branchResponse.parse(res.body).branch
    expect(branch).toMatchObject({ agencyId, name: 'Harbor Annex', status: 'active' })
    branchId = branch.id

    const detail = agencyDetailResponse.parse((await agents.admin.get(`/admin/agencies/${agencyId}`)).body)
    expect(detail.agency.branchCount).toBe(1)
    expect(detail.branches).toEqual([branch])

    const branches = (await agents.admin.get('/branches')).body.branches as { id: string; status: string }[]
    expect(branches.find((b) => b.id === branchId)).toMatchObject({ status: 'active' })
  })

  it('refuses a duplicate branch name within the agency and an unknown time zone', async () => {
    const dup = await post(agents.admin, `/admin/agencies/${agencyId}/branches`, { name: 'Harbor Annex', address: 'x', timezone: 'UTC' })
    expect(dup.status).toBe(409)
    const tz = await post(agents.admin, `/admin/agencies/${agencyId}/branches`, { name: 'Other', address: 'x', timezone: 'Nowhere/Land' })
    expect(tz.status).toBe(400)
  })

  it('deactivating the branch blocks shift creation and claims until it is reactivated', async () => {
    const shift = shiftResponse.parse((await post(agents.admin, '/shifts', { branchId, title: 'Annex shift', ...nextWindow() })).body).shift
    await pool.query('select shiftpatch.set_branch_eligibility($1, $2, $3, $4)', [USERS.admin.id, USERS.ava.id, branchId, 'active'])

    const off = await patch(agents.admin, `/admin/agencies/${agencyId}/branches/${branchId}`, { status: 'inactive' })
    expect(off.status).toBe(200)
    expect(branchResponse.parse(off.body).branch.status).toBe('inactive')

    const blockedCreate = await post(agents.admin, '/shifts', { branchId, title: 'Blocked', ...nextWindow() })
    expect(blockedCreate.status).toBe(422)
    expect(blockedCreate.body.error.code).toBe('branch_inactive')

    const hidden = shiftListResponse.parse((await agents.ava.get('/shifts')).body).shifts
    expect(hidden.map((s) => s.id)).not.toContain(shift.id)
    const blockedClaim = await post(agents.ava, `/shifts/${shift.id}/claim`, {})
    expect(blockedClaim.status).toBe(422)
    expect(blockedClaim.body.error.code).toBe('branch_inactive')

    const on = await patch(agents.admin, `/admin/agencies/${agencyId}/branches/${branchId}`, { status: 'active' })
    expect(on.status).toBe(200)
    const visible = shiftListResponse.parse((await agents.ava.get('/shifts')).body).shifts
    expect(visible.map((s) => s.id)).toContain(shift.id)
  })

  it('deactivating the agency blocks branch creation, shift creation and claims', async () => {
    const shift = shiftResponse.parse((await post(agents.admin, '/shifts', { branchId, title: 'Agency shift', ...nextWindow() })).body).shift
    const off = await patch(agents.admin, `/admin/agencies/${agencyId}`, { status: 'inactive' })
    expect(off.status).toBe(200)
    expect(agencyResponse.parse(off.body).agency.status).toBe('inactive')

    const newBranch = await post(agents.admin, `/admin/agencies/${agencyId}/branches`, { name: 'Late', address: 'x', timezone: 'UTC' })
    expect(newBranch.status).toBe(422)
    expect(newBranch.body.error.code).toBe('agency_inactive')
    const create = await post(agents.admin, '/shifts', { branchId, title: 'Blocked', ...nextWindow() })
    expect(create.status).toBe(422)
    expect(create.body.error.code).toBe('agency_inactive')
    const claim = await post(agents.ava, `/shifts/${shift.id}/claim`, {})
    expect(claim.status).toBe(422)
    expect(claim.body.error.code).toBe('agency_inactive')

    const on = await patch(agents.admin, `/admin/agencies/${agencyId}`, { status: 'active', name: `${name} Renamed` })
    expect(on.status).toBe(200)
    expect(agencyResponse.parse(on.body).agency).toMatchObject({ status: 'active', name: `${name} Renamed` })
    expect((await post(agents.ava, `/shifts/${shift.id}/claim`, {})).status).toBe(200)
  })

  it('answers 404 for a branch addressed through the wrong agency', async () => {
    const res = await patch(agents.admin, `/admin/agencies/${AGENCIES.northwind.id}/branches/${branchId}`, { status: 'inactive' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('branch_not_found')
    const { rows } = await pool.query('select status from shiftpatch.agency_branches where id = $1', [branchId])
    expect(rows).toEqual([{ status: 'active' }])
  })
})

describe('admin routes are closed to other roles', () => {
  it.each(['northwindAgency', 'harborAgency', 'ava'] as const)('%s gets 403 everywhere', async (key) => {
    const agent = agents[key]
    const responses = await Promise.all([
      agent.get('/admin/agencies'),
      post(agent, '/admin/agencies', { name: 'Nope' }),
      agent.get(`/admin/agencies/${AGENCIES.northwind.id}`),
      patch(agent, `/admin/agencies/${AGENCIES.northwind.id}`, { status: 'inactive' }),
      post(agent, `/admin/agencies/${AGENCIES.northwind.id}/branches`, { name: 'Nope', address: 'x', timezone: 'UTC' }),
      patch(agent, `/admin/agencies/${AGENCIES.northwind.id}/branches/${BRANCHES.downtown.id}`, { status: 'inactive' }),
    ])
    for (const res of responses) expect(res.status).toBe(403)
    const { rows } = await pool.query(`select 1 from shiftpatch.agencies where name = 'Nope'`)
    expect(rows).toEqual([])
  })
})
