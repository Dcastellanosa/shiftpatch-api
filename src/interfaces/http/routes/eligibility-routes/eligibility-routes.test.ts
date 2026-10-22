import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { Profile } from '../../../../domain/viewer/viewer.js'
import {
  ADMIN_PROFILE,
  AGENCY_PROFILE,
  ALLOWED_ORIGIN,
  BRANCH_ID,
  NURSE_ID,
  NURSE_PROFILE,
  BEARER,
  buildApp,
  buildSignedInApp,
  eligibilityFixture,
  fakeDataStore,
  nurseEligibilityFixture,
} from '../../../../test-support/fakes.js'
import { eligibilityResponse, nurseListResponse } from '../../schemas/eligibility/eligibility.js'

const asProfile = (profile: Profile | null) => async () => profile
type App = ReturnType<typeof buildApp>
const get = (app: App, path: string) => request(app).get(path).set(BEARER)
const put = (app: App, path: string) => request(app).put(path).set('Origin', ALLOWED_ORIGIN).set(BEARER).send()
const del = (app: App, path: string) => request(app).delete(path).set('Origin', ALLOWED_ORIGIN).set(BEARER).send()
const PATH = `/nurses/${NURSE_ID}/eligibility/${BRANCH_ID}`

describe('GET /agency/nurses', () => {
  it('lists nurses for an agency user', async () => {
    const nurses = [nurseEligibilityFixture()]
    const res = await get(
      buildSignedInApp(fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE), listAgencyNurses: async () => nurses })),
      '/agency/nurses',
    )
    expect(res.status).toBe(200)
    expect(nurseListResponse.parse(res.body).nurses).toEqual(nurses)
  })

  it.each([NURSE_PROFILE, ADMIN_PROFILE])('refuses a $role without touching the store', async (profile) => {
    const store = fakeDataStore({ getProfile: asProfile(profile) })
    const res = await get(buildSignedInApp(store), '/agency/nurses')
    expect(res.status).toBe(403)
    expect(store.listAgencyNurses).not.toHaveBeenCalled()
  })

  it('needs a session', async () => {
    const res = await request(buildSignedInApp(fakeDataStore())).get('/agency/nurses')
    expect(res.status).toBe(401)
  })
})

describe('PUT and DELETE /nurses/:nurseId/eligibility/:branchId', () => {
  it.each([AGENCY_PROFILE, ADMIN_PROFILE])(
    'activates as $role with the viewer id and returns the row',
    async (profile) => {
      const eligibility = eligibilityFixture({ status: 'active' })
      const store = fakeDataStore({
        getProfile: asProfile(profile),
        setBranchEligibility: async () => ({ outcome: 'updated', entityId: 'f1000000-0000-4000-8000-000000000001' }),
        getEligibility: async () => eligibility,
      })
      const res = await put(buildSignedInApp(store), PATH)
      expect(res.status).toBe(200)
      expect(eligibilityResponse.parse(res.body).eligibility).toEqual(eligibility)
      expect(store.setBranchEligibility).toHaveBeenCalledWith(profile.id, NURSE_ID, BRANCH_ID, 'active')
    },
  )

  it('suspends through DELETE (soft: the row stays and is returned)', async () => {
    const eligibility = eligibilityFixture({ status: 'suspended' })
    const store = fakeDataStore({
      getProfile: asProfile(AGENCY_PROFILE),
      setBranchEligibility: async () => ({ outcome: 'updated', entityId: 'f1000000-0000-4000-8000-000000000001' }),
      getEligibility: async () => eligibility,
    })
    const res = await del(buildSignedInApp(store), PATH)
    expect(res.status).toBe(200)
    expect(eligibilityResponse.parse(res.body).eligibility.status).toBe('suspended')
    expect(store.setBranchEligibility).toHaveBeenCalledWith(AGENCY_PROFILE.id, NURSE_ID, BRANCH_ID, 'suspended')
  })

  it.each([
    ['branch_not_found', 404],
    ['nurse_not_found', 404],
    ['agency_inactive', 422],
    ['branch_inactive', 422],
    ['actor_not_allowed', 403],
  ] as const)('maps %s to %i', async (outcome, status) => {
    const store = fakeDataStore({
      getProfile: asProfile(AGENCY_PROFILE),
      setBranchEligibility: async () => ({ outcome, entityId: null }),
    })
    const res = await put(buildSignedInApp(store), PATH)
    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error: expect.any(String) })
  })

  it('refuses nurses and rejects malformed ids before touching the store', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE) })
    expect((await put(buildSignedInApp(store), PATH)).status).toBe(403)
    const agencyStore = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const bad = await put(buildSignedInApp(agencyStore), `/nurses/Nurse_Ava/eligibility/${BRANCH_ID}`)
    expect(bad.status).toBe(400)
    expect(store.setBranchEligibility).not.toHaveBeenCalled()
    expect(agencyStore.setBranchEligibility).not.toHaveBeenCalled()
  })

  it('rejects cross-site writes', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await request(buildSignedInApp(store))
      .put(PATH)
      .set('Origin', 'https://evil.example')
      .set(BEARER)
      .send()
    expect(res.status).toBe(403)
    expect(store.getProfile).not.toHaveBeenCalled()
  })
})
