import request from 'supertest'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  agencyDetailResponse,
  agencyListResponse,
  agencyResponse,
  branchResponse,
  userListResponse,
  userResponse,
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

/** Leaves the seeded fixtures as other files expect them: no stray active eligibility for Ava. */
afterAll(async () => {
  await pool.query(
    `update shiftpatch.branch_nurse_eligibility e set status = 'suspended' from shiftpatch.agency_branches b
     where b.id = e.branch_id and e.nurse_id = $1 and b.id not in (select unnest($2::uuid[]))`,
    [USERS.ava.id, [BRANCHES.downtown.id, BRANCHES.riverside.id, BRANCHES.bayview.id, BRANCHES.lakesideClinic.id]],
  )
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

const MAILPIT = inject('stack').mailUrl

interface MailpitMessage {
  ID: string
  To: { Address: string }[]
  Subject: string
}

/** The newest Mailpit message addressed to `email`, polled briefly because delivery is asynchronous. */
async function latestMailTo(email: string): Promise<{ subject: string; html: string }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json()) as { messages: MailpitMessage[] }
    const match = list.messages.find((m) => m.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()))
    if (match) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json()) as { HTML: string }
      return { subject: match.Subject, html: message.HTML }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no email delivered to ${email}`)
}

/** Parses the one-time link: the hash and type must live in the fragment only. */
function linkFrom(html: string) {
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&')
  if (!href) throw new Error('no link in email')
  const url = new URL(href)
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  return { url, tokenHash: fragment.get('token_hash'), type: fragment.get('type') }
}

describe('invitations, password completion and recovery over HTTP', () => {
  const email = `invited.nurse.${Date.now()}@shiftpatch.test`
  let invitedId: string
  let tokenHash: string

  it('invites a nurse: profile, eligibility, listing as invited, and an email whose link carries the hash only in the fragment', async () => {
    const res = await post(agents.admin, '/admin/users', { email, fullName: 'Invited Nurse', role: 'nurse', branchId: BRANCHES.downtown.id })
    expect(res.status).toBe(201)
    const user = userResponse.parse(res.body).user
    expect(user).toMatchObject({ email, fullName: 'Invited Nurse', role: 'nurse', status: 'invited', agencies: [] })
    expect(user.eligibleBranches).toEqual([{ id: BRANCHES.downtown.id, name: BRANCHES.downtown.name, agency: { id: AGENCIES.northwind.id, name: AGENCIES.northwind.name }, status: 'active' }])
    expect(JSON.stringify(res.body)).not.toMatch(/token|hash|password|set-password/i)
    invitedId = user.id

    const { rows } = await pool.query('select full_name, role from shiftpatch.profiles where id = $1', [invitedId])
    expect(rows).toEqual([{ full_name: 'Invited Nurse', role: 'nurse' }])

    const mail = await latestMailTo(email)
    expect(mail.subject).toContain('invited')
    const link = linkFrom(mail.html)
    expect(link.url.origin + link.url.pathname).toBe('http://localhost:5173/set-password')
    expect(link.url.search).toBe('')
    expect(link.type).toBe('invite')
    expect(link.tokenHash).toMatch(/^[A-Za-z0-9._~-]{16,}$/)
    tokenHash = link.tokenHash!

    const listed = userListResponse.parse((await agents.admin.get('/admin/users')).body).users
    expect(listed.find((u) => u.id === invitedId)).toMatchObject({ status: 'invited', email })
  })

  it('refuses a second invitation for the same address and keeps the existing account intact', async () => {
    const res = await post(agents.admin, '/admin/users', { email, fullName: 'Again', role: 'admin' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('email_exists')
    const { rows } = await pool.query('select full_name, role from shiftpatch.profiles where id = $1', [invitedId])
    expect(rows).toEqual([{ full_name: 'Invited Nurse', role: 'nurse' }])
    const { rows: auth } = await pool.query('select count(*)::int as n from auth.users where id = $1', [invitedId])
    expect(auth[0].n).toBe(1)
  })

  it('rejects a weak password without consuming a session', async () => {
    const res = await post(agents.admin, '/auth/complete-password', { tokenHash, type: 'invite', password: 'short' })
    expect(res.status).toBe(400)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('completes the invitation: sets the password, issues cookies, and the new nurse can sign in and see shifts', async () => {
    // The repeated invitation re-sent the email, which supersedes the first link.
    const superseded = tokenHash
    tokenHash = linkFrom((await latestMailTo(email)).html).tokenHash!
    expect(tokenHash).not.toBe(superseded)
    const stale = await post(agents.admin, '/auth/complete-password', { tokenHash: superseded, type: 'invite', password: 'brand-new-password-1' })
    expect(stale.status).toBe(401)
    expect(stale.headers['set-cookie']).toBeUndefined()

    const agent = request.agent(app)
    const res = await agent.post('/auth/complete-password').set('Origin', ALLOWED_ORIGIN).send({ tokenHash, type: 'invite', password: 'brand-new-password-1' })
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ id: invitedId, email, role: 'nurse', fullName: 'Invited Nurse' })
    expect(JSON.stringify(res.body)).not.toMatch(/token|hash/i)
    expect((res.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('sp_access='))).toBe(true)

    const me = await agent.get('/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.user.id).toBe(invitedId)

    const listed = userListResponse.parse((await agents.admin.get('/admin/users')).body).users
    expect(listed.find((u) => u.id === invitedId)).toMatchObject({ status: 'active' })

    const login = await post(agent, '/auth/login', { email, password: 'brand-new-password-1' })
    expect(login.status).toBe(200)
  })

  it('refuses a replayed link with 401 and no cookies', async () => {
    const res = await post(agents.admin, '/auth/complete-password', { tokenHash, type: 'invite', password: 'another-password-2' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('invalid_or_expired_link')
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('sends a recovery email with a fragment-only link, and answers 204 for unknown addresses too', async () => {
    const res = await post(agents.ava, '/auth/recover', { email: USERS.ava.email })
    expect(res.status).toBe(204)
    const mail = await latestMailTo(USERS.ava.email)
    const link = linkFrom(mail.html)
    expect(link.url.search).toBe('')
    expect(link.type).toBe('recovery')
    expect(link.tokenHash).toBeTruthy()

    const unknown = await post(agents.ava, '/auth/recover', { email: `nobody.${Date.now()}@shiftpatch.test` })
    expect(unknown.status).toBe(204)
  })

  it('keeps invitations admin-only', async () => {
    for (const agent of [agents.northwindAgency, agents.ava]) {
      const res = await post(agent, '/admin/users', { email: `x.${Date.now()}@shiftpatch.test`, fullName: 'X', role: 'admin' })
      expect(res.status).toBe(403)
      expect((await agent.get('/admin/users')).status).toBe(403)
    }
  })
})
