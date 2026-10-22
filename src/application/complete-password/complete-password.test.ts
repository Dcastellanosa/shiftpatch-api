import { describe, expect, it } from 'vitest'
import { NURSE_PROFILE, SESSION, USER, fakeAuthAdmin, fakeDataStore } from '../../test-support/fakes.js'
import { completePassword } from './complete-password.js'

describe('completePassword', () => {
  it('returns the session and the safe payload once the password is set', async () => {
    const auth = fakeAuthAdmin({ completePassword: async () => SESSION })
    const store = fakeDataStore({ getProfile: async () => NURSE_PROFILE })

    const result = await completePassword({ auth, store }, 'hash-1', 'invite', 'correct horse battery')

    expect(result).toEqual({
      ok: true,
      session: SESSION,
      payload: {
        user: { id: NURSE_PROFILE.slug, name: NURSE_PROFILE.fullName, role: 'nurse' },
      },
    })
    expect(auth.completePassword).toHaveBeenCalledWith('hash-1', 'invite', 'correct horse battery')
    expect(store.getProfile).toHaveBeenCalledWith(SESSION.accessToken, USER.id)
  })

  it.each(['invalid_link', 'weak_password'] as const)('passes %s through without a session', async (outcome) => {
    const auth = fakeAuthAdmin({ completePassword: async () => outcome })
    const store = fakeDataStore()
    await expect(completePassword({ auth, store }, 'hash-1', 'recovery', 'pw-pw-pw-pw')).resolves.toEqual({
      ok: false,
      outcome,
    })
    expect(store.getProfile).not.toHaveBeenCalled()
  })

  it('works without a data layer (profile fields stay null)', async () => {
    const auth = fakeAuthAdmin({ completePassword: async () => SESSION })
    const result = await completePassword({ auth, store: null }, 'hash-1', 'invite', 'correct horse battery')
    expect(result).toMatchObject({ ok: true, payload: { user: { id: USER.id, role: null, name: USER.email } } })
  })
})
