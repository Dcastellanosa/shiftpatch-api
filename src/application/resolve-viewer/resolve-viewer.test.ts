import { describe, expect, it } from 'vitest'
import { AGENCY_PROFILE, NURSE_PROFILE, USER, fakeDataStore } from '../../test-support/fakes.js'
import { resolveViewer } from './resolve-viewer.js'

describe('resolveViewer', () => {
  it('builds the viewer from the profile and the session token', async () => {
    const store = fakeDataStore({ getProfile: async () => NURSE_PROFILE })
    await expect(resolveViewer({ store }, USER, 'token')).resolves.toEqual({
      ok: true,
      viewer: { ...NURSE_PROFILE, accessToken: 'token' },
    })
    expect(store.getProfile).toHaveBeenCalledWith('token', USER.id)
  })

  it('fails with profile_missing for an unprovisioned user', async () => {
    const store = fakeDataStore()
    await expect(resolveViewer({ store }, USER, 'token')).resolves.toEqual({ ok: false, outcome: 'profile_missing' })
  })

  it('fails with membership_inactive for an agency user without an active agency', async () => {
    const store = fakeDataStore({ getProfile: async () => ({ ...AGENCY_PROFILE, agencyId: null }) })
    await expect(resolveViewer({ store }, USER, 'token')).resolves.toEqual({
      ok: false,
      outcome: 'membership_inactive',
    })
  })

  it('accepts an agency user with an active agency', async () => {
    const store = fakeDataStore({ getProfile: async () => AGENCY_PROFILE })
    const result = await resolveViewer({ store }, USER, 'token')
    expect(result.ok && result.viewer.agencyId).toBe(AGENCY_PROFILE.agencyId)
  })
})
