import { describe, expect, it } from 'vitest'
import { REFRESHED_SESSION, SESSION, USER, fakeAuthProvider } from '../../test-support/fakes.js'
import { authenticate } from './authenticate.js'

describe('authenticate', () => {
  it('accepts a valid access token without refreshing', async () => {
    const auth = fakeAuthProvider({ getUser: async () => USER })
    const result = await authenticate({ auth }, { accessToken: 'a', refreshToken: 'r' })

    expect(result).toEqual({ user: USER, accessToken: 'a', refreshed: null })
    expect(auth.refreshSession).not.toHaveBeenCalled()
  })

  it('falls back to the refresh token when the access token is rejected', async () => {
    const auth = fakeAuthProvider({ refreshSession: async () => REFRESHED_SESSION })
    const result = await authenticate({ auth }, { accessToken: 'stale', refreshToken: 'r' })

    expect(result).toEqual({ user: USER, accessToken: REFRESHED_SESSION.accessToken, refreshed: REFRESHED_SESSION })
    expect(auth.getUser).toHaveBeenCalledWith('stale')
    expect(auth.refreshSession).toHaveBeenCalledWith('r')
  })

  it('refreshes directly when only a refresh token is present', async () => {
    const auth = fakeAuthProvider({ refreshSession: async () => SESSION })
    await expect(authenticate({ auth }, { refreshToken: 'r' })).resolves.toMatchObject({ refreshed: SESSION })
    expect(auth.getUser).not.toHaveBeenCalled()
  })

  it('returns null when neither token yields a session', async () => {
    const auth = fakeAuthProvider()
    await expect(authenticate({ auth }, { accessToken: 'a', refreshToken: 'r' })).resolves.toBeNull()
  })

  it('returns null without tokens and never calls the provider', async () => {
    const auth = fakeAuthProvider()
    await expect(authenticate({ auth }, {})).resolves.toBeNull()
    expect(auth.getUser).not.toHaveBeenCalled()
    expect(auth.refreshSession).not.toHaveBeenCalled()
  })
})
