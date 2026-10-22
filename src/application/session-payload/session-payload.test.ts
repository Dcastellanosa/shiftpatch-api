import { describe, expect, it } from 'vitest'
import { ADMIN_PROFILE, AGENCY_PROFILE, NURSE_PROFILE, USER, fakeDataStore } from '../../test-support/fakes.js'
import { loadSessionPayload, loadSignInPayload, toSessionPayload, toSignInPayload } from './session-payload.js'

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

  it('falls back to the email as the name for a user without a profile', () => {
    expect(toSessionPayload(USER, null).user).toEqual({
      id: USER.id,
      name: USER.email,
      email: USER.email,
      role: null,
      agencyId: null,
      agencyIds: [],
    })
  })

  it('falls back to the id when there is neither a profile nor an email', () => {
    expect(toSessionPayload({ id: USER.id, email: null }, null).user.name).toBe(USER.id)
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

describe('toSignInPayload', () => {
  it('is exactly { user: { id, name, role } }, the contract login payload', () => {
    expect(toSignInPayload(USER, NURSE_PROFILE)).toEqual({
      user: { id: NURSE_PROFILE.slug, name: NURSE_PROFILE.fullName, role: 'nurse' },
    })
    expect(Object.keys(toSignInPayload(USER, AGENCY_PROFILE).user)).toEqual(['id', 'name', 'role'])
    expect(toSignInPayload(USER, AGENCY_PROFILE).user.id).toBe(AGENCY_PROFILE.agencySlug)
  })

  it('always carries a string name', () => {
    expect(toSignInPayload(USER, null).user).toEqual({ id: USER.id, name: USER.email, role: null })
    expect(toSignInPayload({ id: USER.id, email: null }, null).user.name).toBe(USER.id)
  })
})

describe('loadSignInPayload', () => {
  it('looks the profile up with the access token and verified user id', async () => {
    const store = fakeDataStore({ getProfile: async () => NURSE_PROFILE })
    await expect(loadSignInPayload({ store }, USER, 'token')).resolves.toEqual(toSignInPayload(USER, NURSE_PROFILE))
    expect(store.getProfile).toHaveBeenCalledWith('token', USER.id)
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
