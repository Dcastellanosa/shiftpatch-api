import { describe, expect, it } from 'vitest'
import { NURSE_PROFILE, SESSION, USER, fakeAuthProvider, fakeDataStore } from '../../test-support/fakes.js'
import { signIn } from './sign-in.js'

describe('signIn', () => {
  it('returns the session and a payload built from the profile', async () => {
    const auth = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const store = fakeDataStore({ getProfile: async () => NURSE_PROFILE })

    const result = await signIn({ auth, store }, 'nurse@example.com', 'pw')

    expect(result).toEqual({
      ok: true,
      session: SESSION,
      payload: {
        user: { id: NURSE_PROFILE.slug, name: NURSE_PROFILE.fullName, role: 'nurse' },
      },
    })
    expect(auth.signInWithPassword).toHaveBeenCalledWith('nurse@example.com', 'pw')
    expect(store.getProfile).toHaveBeenCalledWith(SESSION.accessToken, USER.id)
  })

  it('fails without touching the store when the credentials are rejected', async () => {
    const auth = fakeAuthProvider()
    const store = fakeDataStore()

    await expect(signIn({ auth, store }, 'nurse@example.com', 'wrong')).resolves.toEqual({ ok: false })
    expect(store.getProfile).not.toHaveBeenCalled()
  })

  it('returns null profile fields when the data layer is not configured', async () => {
    const auth = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const result = await signIn({ auth, store: null }, 'nurse@example.com', 'pw')
    expect(result.ok && result.payload.user).toEqual({ id: USER.id, name: USER.email, role: null })
  })
})
