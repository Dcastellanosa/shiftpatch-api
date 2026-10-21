import { describe, expect, it } from 'vitest'
import { ADMIN_PROFILE, AGENCY_PROFILE, NURSE_PROFILE, USER, fakeDataStore } from '../../test-support/fakes.js'
import { loadSessionPayload, toSessionPayload } from './session-payload.js'

describe('toSessionPayload', () => {
  it('identifies an agency user by the agency they manage (public id)', () => {
    expect(toSessionPayload(USER, AGENCY_PROFILE)).toEqual({
      user: {
        id: AGENCY_PROFILE.agencySlug,
        name: AGENCY_PROFILE.fullName,
        email: USER.email,
        role: 'agency',
        agencyId: AGENCY_PROFILE.agencySlug,
        agencyIds: AGENCY_PROFILE.agencySlugs,
      },
    })
  })

  it.each([NURSE_PROFILE, ADMIN_PROFILE])(
    'identifies a $role by their profile public id, never the Auth UUID',
    (profile) => {
      const { user } = toSessionPayload(USER, profile)
      expect(user.id).toBe(profile.slug)
      expect(JSON.stringify(user)).not.toContain(USER.id)
    },
  )

  it('returns null profile fields for a user without a profile', () => {
    expect(toSessionPayload(USER, null).user).toEqual({
      id: USER.id,
      name: null,
      email: USER.email,
      role: null,
      agencyId: null,
      agencyIds: [],
    })
  })

  it('never includes tokens', () => {
    expect(Object.keys(toSessionPayload(USER, AGENCY_PROFILE).user)).toEqual([
      'id',
      'name',
      'email',
      'role',
      'agencyId',
      'agencyIds',
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
