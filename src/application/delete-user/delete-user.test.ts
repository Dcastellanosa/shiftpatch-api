import { describe, expect, it } from 'vitest'
import type { DeleteUserOutcome } from '../../domain/outcomes/outcomes.js'
import { ADMIN_PROFILE, INVITED_USER_ID, INVITED_USER_SLUG, USER, fakeAuthAdmin, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { deleteUser } from './delete-user.js'

describe('deleteUser', () => {
  it('removes the profile by public id first, then the Auth account by the UUID the command reports', async () => {
    const calls: string[] = []
    const store = fakeDataStore({
      deleteUser: async () => {
        calls.push('store')
        return { outcome: 'deleted', entityId: INVITED_USER_ID }
      },
    })
    const auth = fakeAuthAdmin({
      deleteUser: async () => {
        calls.push('auth')
      },
    })
    await expect(deleteUser({ store, auth }, viewerFor(ADMIN_PROFILE), INVITED_USER_SLUG)).resolves.toEqual({ ok: true })
    expect(store.deleteUser).toHaveBeenCalledWith(USER.id, INVITED_USER_SLUG)
    expect(auth.deleteUser).toHaveBeenCalledWith(INVITED_USER_ID)
    expect(calls).toEqual(['store', 'auth'])
  })

  it.each<Exclude<DeleteUserOutcome, 'deleted'>>(['actor_not_allowed', 'user_not_found', 'self_delete', 'user_has_history'])(
    'returns %s and never touches the Auth account',
    async (outcome) => {
      const store = fakeDataStore({ deleteUser: async () => ({ outcome, entityId: null }) })
      const auth = fakeAuthAdmin()
      await expect(deleteUser({ store, auth }, viewerFor(ADMIN_PROFILE), INVITED_USER_SLUG)).resolves.toEqual({ ok: false, outcome })
      expect(auth.deleteUser).not.toHaveBeenCalled()
    },
  )
})
