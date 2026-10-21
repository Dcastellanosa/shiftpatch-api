import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { Profile } from '../../../../domain/viewer/viewer.js'
import {
  ADMIN_PROFILE,
  AGENCY_ID,
  AGENCY_PROFILE,
  ALLOWED_ORIGIN,
  BRANCH_ID,
  NURSE_PROFILE,
  SESSION_COOKIE,
  INVITED_USER_ID,
  adminUserFixture,
  agencyBranchFixture,
  agencyFixture,
  buildApp,
  buildSignedInApp,
  fakeAuthAdmin,
  fakeDataStore,
} from '../../../../test-support/fakes.js'
import {
  agencyDetailResponse,
  agencyListResponse,
  agencyResponse,
  branchResponse,
  userListResponse,
  userResponse,
} from '../../schemas/admin/admin.js'

const asProfile = (profile: Profile | null) => async () => profile
type App = ReturnType<typeof buildApp>
const get = (app: App, path: string) => request(app).get(path).set('Cookie', SESSION_COOKIE)
const post = (app: App, path: string, body?: object) =>
  request(app).post(path).set('Origin', ALLOWED_ORIGIN).set('Cookie', SESSION_COOKIE).send(body)
const patch = (app: App, path: string, body?: object) =>
  request(app).patch(path).set('Origin', ALLOWED_ORIGIN).set('Cookie', SESSION_COOKIE).send(body)
const del = (app: App, path: string) => request(app).delete(path).set('Origin', ALLOWED_ORIGIN).set('Cookie', SESSION_COOKIE)

const AGENCY_PATH = `/admin/agencies/${AGENCY_ID}`
const BRANCH_PATH = `${AGENCY_PATH}/branches/${BRANCH_ID}`
const BRANCH_BODY = { name: 'Uptown Clinic', address: '1 Up Street', timezone: 'America/New_York' }

function adminStore(overrides: Parameters<typeof fakeDataStore>[0] = {}) {
  return fakeDataStore({ getProfile: asProfile(ADMIN_PROFILE), ...overrides })
}

describe('access control', () => {
  it.each([
    ['GET', '/admin/agencies'],
    ['POST', '/admin/agencies'],
    ['GET', AGENCY_PATH],
    ['PATCH', AGENCY_PATH],
    ['POST', `${AGENCY_PATH}/branches`],
    ['PATCH', BRANCH_PATH],
    ['DELETE', AGENCY_PATH],
    ['DELETE', `/admin/users/${INVITED_USER_ID}`],
  ] as const)('%s %s needs a session', async (method, path) => {
    const store = fakeDataStore()
    const res = await request(buildSignedInApp(store))[method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](path).set('Origin', ALLOWED_ORIGIN)
    expect(res.status).toBe(401)
    expect(store.getProfile).not.toHaveBeenCalled()
  })

  it.each([NURSE_PROFILE, AGENCY_PROFILE])('refuses a $role on every admin route without touching the store', async (profile) => {
    const store = fakeDataStore({ getProfile: asProfile(profile) })
    const app = buildSignedInApp(store)
    const responses = await Promise.all([
      get(app, '/admin/agencies'),
      post(app, '/admin/agencies', { name: 'x' }),
      get(app, AGENCY_PATH),
      patch(app, AGENCY_PATH, { status: 'inactive' }),
      post(app, `${AGENCY_PATH}/branches`, BRANCH_BODY),
      patch(app, BRANCH_PATH, { status: 'inactive' }),
      del(app, AGENCY_PATH),
      del(app, `/admin/users/${INVITED_USER_ID}`),
    ])
    for (const res of responses) {
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('forbidden')
    }
    for (const method of ['listAgencies', 'getAgency', 'createAgency', 'updateAgency', 'createBranch', 'updateBranch', 'deleteAgency', 'deleteUser'] as const) {
      expect(store[method]).not.toHaveBeenCalled()
    }
  })

  it('rejects cross-site writes before touching the store', async () => {
    const store = adminStore()
    const res = await request(buildSignedInApp(store)).post('/admin/agencies').set('Origin', 'https://evil.example').set('Cookie', SESSION_COOKIE).send({ name: 'x' })
    expect(res.status).toBe(403)
    expect(store.getProfile).not.toHaveBeenCalled()
  })
})

describe('agencies', () => {
  it('lists agencies of every status', async () => {
    const agencies = [agencyFixture(), agencyFixture({ id: 'a1000000-0000-4000-8000-000000000003', name: 'Lakeside', status: 'inactive', branchCount: 1 })]
    const res = await get(buildSignedInApp(adminStore({ listAgencies: async () => agencies })), '/admin/agencies')
    expect(res.status).toBe(200)
    expect(agencyListResponse.parse(res.body).agencies).toEqual(agencies)
  })

  it('creates an agency and answers 201 with the re-read agency', async () => {
    const agency = agencyFixture({ name: 'Summit Nursing', branchCount: 0 })
    const store = adminStore({
      createAgency: async () => ({ outcome: 'created', entityId: AGENCY_ID }),
      getAgency: async () => ({ agency, branches: [] }),
    })
    const res = await post(buildSignedInApp(store), '/admin/agencies', { name: '  Summit Nursing  ' })
    expect(res.status).toBe(201)
    expect(agencyResponse.parse(res.body).agency).toEqual(agency)
    expect(store.createAgency).toHaveBeenCalledWith(ADMIN_PROFILE.id, { name: 'Summit Nursing' })
  })

  it('returns the agency with its branches', async () => {
    const detail = { agency: agencyFixture(), branches: [agencyBranchFixture()] }
    const res = await get(buildSignedInApp(adminStore({ getAgency: async () => detail })), AGENCY_PATH)
    expect(res.status).toBe(200)
    expect(agencyDetailResponse.parse(res.body)).toEqual(detail)
  })

  it('answers 404 for an unknown agency and 400 for a malformed id', async () => {
    const store = adminStore({ getAgency: async () => null })
    expect((await get(buildSignedInApp(store), AGENCY_PATH)).status).toBe(404)
    const bad = await get(buildSignedInApp(store), '/admin/agencies/not-a-uuid')
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('validation_error')
  })

  it('updates name and status', async () => {
    const agency = agencyFixture({ name: 'Northwind Care Group', status: 'inactive' })
    const store = adminStore({
      updateAgency: async () => ({ outcome: 'updated', entityId: AGENCY_ID }),
      getAgency: async () => ({ agency, branches: [] }),
    })
    const res = await patch(buildSignedInApp(store), AGENCY_PATH, { name: 'Northwind Care Group', status: 'inactive' })
    expect(res.status).toBe(200)
    expect(agencyResponse.parse(res.body).agency).toEqual(agency)
    expect(store.updateAgency).toHaveBeenCalledWith(ADMIN_PROFILE.id, AGENCY_ID, { name: 'Northwind Care Group', status: 'inactive' })
  })

  it.each([
    ['empty body', {}],
    ['blank name', { name: '   ' }],
    ['overlong name', { name: 'x'.repeat(201) }],
    ['unknown status', { status: 'closed' }],
    ['unexpected key', { name: 'Ok', id: 'a1000000-0000-4000-8000-000000000009' }],
  ])('rejects %s with 400 and no store call', async (_label, body) => {
    const store = adminStore()
    const res = await patch(buildSignedInApp(store), AGENCY_PATH, body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
    expect(JSON.stringify(res.body)).not.toContain('closed')
    expect(store.updateAgency).not.toHaveBeenCalled()
  })

  it.each([
    ['name_taken', 409],
    ['agency_not_found', 404],
    ['actor_not_allowed', 403],
  ] as const)('maps %s on update to %i', async (outcome, status) => {
    const store = adminStore({ updateAgency: async () => ({ outcome, entityId: null }) })
    const res = await patch(buildSignedInApp(store), AGENCY_PATH, { name: 'x' })
    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error: { code: expect.any(String), message: expect.any(String) } })
  })

  it('maps a taken name on creation to 409', async () => {
    const store = adminStore({ createAgency: async () => ({ outcome: 'name_taken', entityId: null }) })
    const res = await post(buildSignedInApp(store), '/admin/agencies', { name: 'Northwind Care Staffing' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('name_taken')
  })
})

describe('branches', () => {
  it('creates a branch under the agency and answers 201', async () => {
    const branch = agencyBranchFixture({ name: BRANCH_BODY.name, address: BRANCH_BODY.address })
    const store = adminStore({
      createBranch: async () => ({ outcome: 'created', entityId: BRANCH_ID }),
      getAgencyBranch: async () => branch,
    })
    const res = await post(buildSignedInApp(store), `${AGENCY_PATH}/branches`, BRANCH_BODY)
    expect(res.status).toBe(201)
    expect(branchResponse.parse(res.body).branch).toEqual(branch)
    expect(store.createBranch).toHaveBeenCalledWith(ADMIN_PROFILE.id, AGENCY_ID, BRANCH_BODY)
  })

  it.each([
    ['an unknown time zone', { ...BRANCH_BODY, timezone: 'Mars/Olympus' }],
    ['a free-form time zone', { ...BRANCH_BODY, timezone: 'UTC+2' }],
    ['a blank address', { ...BRANCH_BODY, address: ' ' }],
    ['an unexpected key', { ...BRANCH_BODY, status: 'inactive' }],
  ])('rejects %s with 400', async (_label, body) => {
    const store = adminStore()
    const res = await post(buildSignedInApp(store), `${AGENCY_PATH}/branches`, body)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toMatch(/Mars|UTC\+2/)
    expect(store.createBranch).not.toHaveBeenCalled()
  })

  it.each([
    ['agency_not_found', 404],
    ['agency_inactive', 422],
    ['name_taken', 409],
    ['actor_not_allowed', 403],
  ] as const)('maps %s on branch creation to %i', async (outcome, status) => {
    const store = adminStore({ createBranch: async () => ({ outcome, entityId: null }) })
    const res = await post(buildSignedInApp(store), `${AGENCY_PATH}/branches`, BRANCH_BODY)
    expect(res.status).toBe(status)
    expect(res.body.error.code).toBe(outcome === 'actor_not_allowed' ? 'forbidden' : outcome)
  })

  it('deactivates a branch through its agency', async () => {
    const branch = agencyBranchFixture({ status: 'inactive' })
    const store = adminStore({
      getAgencyBranch: async () => branch,
      updateBranch: async () => ({ outcome: 'updated', entityId: BRANCH_ID }),
    })
    const res = await patch(buildSignedInApp(store), BRANCH_PATH, { status: 'inactive' })
    expect(res.status).toBe(200)
    expect(branchResponse.parse(res.body).branch).toEqual(branch)
    expect(store.updateBranch).toHaveBeenCalledWith(ADMIN_PROFILE.id, BRANCH_ID, { status: 'inactive' })
  })

  it('answers 404 for a branch outside the agency without running the command', async () => {
    const store = adminStore({ getAgencyBranch: async () => null })
    const res = await patch(buildSignedInApp(store), BRANCH_PATH, { status: 'inactive' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('branch_not_found')
    expect(store.updateBranch).not.toHaveBeenCalled()
  })

  it('rejects an empty branch patch', async () => {
    const store = adminStore()
    const res = await patch(buildSignedInApp(store), BRANCH_PATH, {})
    expect(res.status).toBe(400)
    expect(store.getAgencyBranch).not.toHaveBeenCalled()
  })

  it('never leaks internals in responses', async () => {
    const store = adminStore({ listAgencies: async () => [agencyFixture()] })
    const res = await get(buildSignedInApp(store), '/admin/agencies')
    expect(JSON.stringify(res.body)).not.toMatch(/token|secret|supabase/i)
  })
})

describe('users', () => {
  const NURSE_INVITE = { email: 'new.nurse@example.test', fullName: 'Nina Nurse', role: 'nurse', branchId: BRANCH_ID }

  it('lists users with their access', async () => {
    const users = [adminUserFixture(), adminUserFixture({ id: 'a1000000-0000-4000-8000-0000000000aa', role: 'agency', status: 'active', agencies: [{ id: AGENCY_ID, name: 'Northwind' }], eligibleBranches: [] })]
    const res = await get(buildSignedInApp(adminStore({ listUsers: async () => users })), '/admin/users')
    expect(res.status).toBe(200)
    expect(userListResponse.parse(res.body).users).toEqual(users)
  })

  it('invites a nurse: provider, provisioning with the viewer id, 201 with the listed user', async () => {
    const user = adminUserFixture()
    const auth = fakeAuthAdmin({ inviteUser: async () => ({ id: INVITED_USER_ID }) })
    const store = adminStore({
      provisionUser: async () => ({ outcome: 'provisioned', entityId: INVITED_USER_ID }),
      getUser: async () => user,
    })
    const res = await post(buildSignedInApp(store, auth), '/admin/users', NURSE_INVITE)
    expect(res.status).toBe(201)
    expect(userResponse.parse(res.body).user).toEqual(user)
    expect(auth.inviteUser).toHaveBeenCalledWith(NURSE_INVITE.email, { fullName: 'Nina Nurse', redirectTo: `${ALLOWED_ORIGIN}/set-password` })
    expect(store.provisionUser).toHaveBeenCalledWith(ADMIN_PROFILE.id, INVITED_USER_ID, NURSE_INVITE)
  })

  it.each([
    ['an admin with an agency', { email: 'a@example.test', fullName: 'A', role: 'admin', agencyIds: [AGENCY_ID] }],
    ['an agency user without agencies', { email: 'a@example.test', fullName: 'A', role: 'agency' }],
    ['an agency user with an empty list', { email: 'a@example.test', fullName: 'A', role: 'agency', agencyIds: [] }],
    ['a nurse with agencies', { email: 'a@example.test', fullName: 'A', role: 'nurse', branchId: BRANCH_ID, agencyIds: [AGENCY_ID] }],
    ['an unknown role', { email: 'a@example.test', fullName: 'A', role: 'owner' }],
    ['a password', { ...NURSE_INVITE, password: 'hunter2-secret' }],
    ['an id', { ...NURSE_INVITE, id: INVITED_USER_ID }],
    ['an invalid email', { ...NURSE_INVITE, email: 'not-an-email' }],
  ])('rejects %s with 400 before contacting the provider', async (_label, body) => {
    const auth = fakeAuthAdmin()
    const store = adminStore()
    const res = await post(buildSignedInApp(store, auth), '/admin/users', body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|owner|example\.test/)
    expect(auth.inviteUser).not.toHaveBeenCalled()
    expect(store.provisionUser).not.toHaveBeenCalled()
  })

  it('answers 409 and provisions nothing when the address exists', async () => {
    const auth = fakeAuthAdmin({ inviteUser: async () => 'email_exists' })
    const store = adminStore()
    const res = await post(buildSignedInApp(store, auth), '/admin/users', NURSE_INVITE)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('email_exists')
    expect(store.provisionUser).not.toHaveBeenCalled()
  })

  it.each([
    ['agency_not_found', 404],
    ['branch_not_found', 404],
    ['agency_inactive', 422],
    ['branch_inactive', 422],
    ['invalid_assignment', 422],
    ['actor_not_allowed', 403],
    ['auth_user_not_found', 503],
  ] as const)('maps provisioning outcome %s to %i and removes the Auth user again', async (outcome, status) => {
    const auth = fakeAuthAdmin({ inviteUser: async () => ({ id: INVITED_USER_ID }) })
    const store = adminStore({ provisionUser: async () => ({ outcome, entityId: null }) })
    const res = await post(buildSignedInApp(store, auth), '/admin/users', NURSE_INVITE)
    expect(res.status).toBe(status)
    expect(auth.deleteUser).toHaveBeenCalledWith(INVITED_USER_ID)
    expect(JSON.stringify(res.body)).not.toContain(INVITED_USER_ID)
  })

  it('answers 409 email_exists for an already provisioned account and keeps it', async () => {
    const auth = fakeAuthAdmin({ inviteUser: async () => ({ id: INVITED_USER_ID }) })
    const store = adminStore({ provisionUser: async () => ({ outcome: 'profile_exists', entityId: null }) })
    const res = await post(buildSignedInApp(store, auth), '/admin/users', NURSE_INVITE)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('email_exists')
    expect(auth.deleteUser).not.toHaveBeenCalled()
  })

  it('answers 503 when invitations are not configured, without contacting anything', async () => {
    const store = adminStore()
    const res = await post(buildSignedInApp(store, null), '/admin/users', NURSE_INVITE)
    expect(res.status).toBe(503)
    expect(store.provisionUser).not.toHaveBeenCalled()
  })

  it.each([NURSE_PROFILE, AGENCY_PROFILE])('refuses a $role on the user routes', async (profile) => {
    const auth = fakeAuthAdmin()
    const store = fakeDataStore({ getProfile: asProfile(profile) })
    const app = buildSignedInApp(store, auth)
    expect((await get(app, '/admin/users')).status).toBe(403)
    expect((await post(app, '/admin/users', NURSE_INVITE)).status).toBe(403)
    expect(auth.inviteUser).not.toHaveBeenCalled()
    expect(store.listUsers).not.toHaveBeenCalled()
  })
})

describe('deletion', () => {
  it('deletes an agency with the viewer id and answers 204', async () => {
    const store = adminStore({ deleteAgency: async () => ({ outcome: 'deleted', entityId: AGENCY_ID }) })
    const res = await del(buildSignedInApp(store), AGENCY_PATH)
    expect(res.status).toBe(204)
    expect(store.deleteAgency).toHaveBeenCalledWith(ADMIN_PROFILE.id, AGENCY_ID)
  })

  it.each([
    ['agency_has_shifts', 409, 'agency_has_shifts'],
    ['agency_not_found', 404, 'agency_not_found'],
    ['actor_not_allowed', 403, 'forbidden'],
  ] as const)('maps %s on agency deletion to %s %s', async (outcome, status, code) => {
    const store = adminStore({ deleteAgency: async () => ({ outcome, entityId: null }) })
    const res = await del(buildSignedInApp(store), AGENCY_PATH)
    expect(res.status).toBe(status)
    expect(res.body.error.code).toBe(code)
  })

  it('deletes a user: profile command first, Auth account second, 204', async () => {
    const store = adminStore({ deleteUser: async () => ({ outcome: 'deleted', entityId: INVITED_USER_ID }) })
    const authAdmin = fakeAuthAdmin()
    const res = await del(buildSignedInApp(store, authAdmin), `/admin/users/${INVITED_USER_ID}`)
    expect(res.status).toBe(204)
    expect(store.deleteUser).toHaveBeenCalledWith(ADMIN_PROFILE.id, INVITED_USER_ID)
    expect(authAdmin.deleteUser).toHaveBeenCalledWith(INVITED_USER_ID)
  })

  it.each([
    ['self_delete', 409, 'cannot_delete_self'],
    ['user_has_history', 409, 'user_has_history'],
    ['user_not_found', 404, 'user_not_found'],
  ] as const)('maps %s on user deletion to %s %s without touching Auth', async (outcome, status, code) => {
    const store = adminStore({ deleteUser: async () => ({ outcome, entityId: null }) })
    const authAdmin = fakeAuthAdmin()
    const res = await del(buildSignedInApp(store, authAdmin), `/admin/users/${INVITED_USER_ID}`)
    expect(res.status).toBe(status)
    expect(res.body.error.code).toBe(code)
    expect(authAdmin.deleteUser).not.toHaveBeenCalled()
  })

  it('answers 503 for user deletion when Auth administration is not configured, before any command', async () => {
    const store = adminStore()
    const res = await del(buildSignedInApp(store, null), `/admin/users/${INVITED_USER_ID}`)
    expect(res.status).toBe(503)
    expect(store.deleteUser).not.toHaveBeenCalled()
  })

  it('rejects a malformed user id with 400', async () => {
    const res = await del(buildSignedInApp(adminStore(), fakeAuthAdmin()), '/admin/users/not-a-uuid')
    expect(res.status).toBe(400)
  })
})
