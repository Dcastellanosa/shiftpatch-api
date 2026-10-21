import { describe, expect, it } from 'vitest'
import { fakeAuthAdmin } from '../../test-support/fakes.js'
import { requestRecovery } from './request-recovery.js'

describe('requestRecovery', () => {
  it('asks the provider for a recovery email pointing at the set-password page', async () => {
    const auth = fakeAuthAdmin()
    await expect(
      requestRecovery({ auth }, 'nurse@example.test', 'http://localhost:5173/set-password'),
    ).resolves.toBeUndefined()
    expect(auth.sendRecovery).toHaveBeenCalledWith('nurse@example.test', 'http://localhost:5173/set-password')
  })
})
