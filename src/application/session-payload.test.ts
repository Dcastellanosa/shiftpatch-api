import { describe, expect, it } from 'vitest'
import { AGENCY_PROFILE, USER, fakeDataStore } from '../test-support/fakes.js'
import { loadSessionPayload, toSessionPayload } from './session-payload.js'

describe('toSessionPayload', () => {
  it('combines the verified user with the profile', () => {
    expect(toSessionPayload(USER, AGENCY_PROFILE)).toEqual({
      user: {
        id: USER.id,
        email: USER.email,
        fullName: AGENCY_PROFILE.fullName,
        role: 'agency',
        agencyId: AGENCY_PROFILE.agencyId,
      },
    })
  })

  it('returns null profile fields for a user without a profile', () => {
    expect(toSessionPayload(USER, null).user).toEqual({
      id: USER.id,
      email: USER.email,
      fullName: null,
      role: null,
      agencyId: null,
    })
  })

  it('never includes tokens', () => {
    expect(Object.keys(toSessionPayload(USER, AGENCY_PROFILE).user)).toEqual([
      'id',
      'email',
      'fullName',
      'role',
      'agencyId',
    ])
  })
})

describe('loadSessionPayload', () => {
  it('looks the profile up with the access token and verified user id', async () => {
    const store = fakeDataStore({ getProfile: async () => AGENCY_PROFILE })
    const payload = await loadSessionPayload({ store }, USER, 'token')
    expect(payload.user.role).toBe('agency')
    expect(store.getProfile).toHaveBeenCalledWith('token', USER.id)
  })

  it('skips the lookup when the data layer is not configured', async () => {
    await expect(loadSessionPayload({ store: null }, USER, 'token')).resolves.toEqual(toSessionPayload(USER, null))
  })
})
