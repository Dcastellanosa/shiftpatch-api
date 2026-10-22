import { describe, expect, it } from 'vitest'
import { USER, fakeTokenVerifier } from '../../test-support/fakes.js'
import { authenticate } from './authenticate.js'

describe('authenticate', () => {
  it('returns the verified user with the token that proved it', async () => {
    const verifier = fakeTokenVerifier({ verify: async () => USER })
    await expect(authenticate({ verifier }, 'a')).resolves.toEqual({ user: USER, accessToken: 'a' })
    expect(verifier.verify).toHaveBeenCalledWith('a')
  })

  it('returns null when the verifier rejects the token', async () => {
    await expect(authenticate({ verifier: fakeTokenVerifier() }, 'a')).resolves.toBeNull()
  })
})
