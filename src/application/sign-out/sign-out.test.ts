import { describe, expect, it } from 'vitest'
import { fakeAuthProvider } from '../../test-support/fakes.js'
import { signOut } from './sign-out.js'

describe('signOut', () => {
  it('revokes the session that owns the access token', async () => {
    const auth = fakeAuthProvider()
    await signOut({ auth }, 'token')
    expect(auth.signOut).toHaveBeenCalledWith('token')
  })
})
