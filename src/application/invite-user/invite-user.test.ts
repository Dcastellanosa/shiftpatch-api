import { describe, expect, it } from 'vitest'
import type { InviteUserCommand } from '../../domain/admin/admin.js'
import type { ProvisionOutcome } from '../../domain/outcomes/outcomes.js'
import {
  ADMIN_PROFILE,
  BRANCH_ID,
  INVITED_USER_ID,
  USER,
  adminUserFixture,
  fakeAuthAdmin,
  fakeDataStore,
  viewerFor,
} from '../../test-support/fakes.js'
import { inviteUser } from './invite-user.js'

const SET_PASSWORD_URL = 'http://localhost:5173/set-password'
const COMMAND: InviteUserCommand = { email: 'new.nurse@example.test', fullName: 'Nina Nurse', role: 'nurse', branchId: BRANCH_ID }

describe('inviteUser', () => {
  it('invites through the provider, provisions with the viewer id and returns the listed user', async () => {
    const viewer = viewerFor(ADMIN_PROFILE)
    const user = adminUserFixture()
    const auth = fakeAuthAdmin({ inviteUser: async () => ({ id: INVITED_USER_ID }) })
    const store = fakeDataStore({
      provisionUser: async () => ({ outcome: 'provisioned', entityId: INVITED_USER_ID }),
      getUser: async () => user,
    })

    await expect(inviteUser({ store, auth }, viewer, COMMAND, SET_PASSWORD_URL)).resolves.toEqual({ ok: true, user })
    expect(auth.inviteUser).toHaveBeenCalledWith(COMMAND.email, { fullName: COMMAND.fullName, redirectTo: SET_PASSWORD_URL })
    expect(store.provisionUser).toHaveBeenCalledWith(USER.id, INVITED_USER_ID, COMMAND)
    expect(store.getUser).toHaveBeenCalledWith(viewer, INVITED_USER_ID)
    expect(auth.deleteUser).not.toHaveBeenCalled()
  })

  it('stops at email_exists without provisioning', async () => {
    const auth = fakeAuthAdmin({ inviteUser: async () => 'email_exists' })
    const store = fakeDataStore()
    await expect(inviteUser({ store, auth }, viewerFor(ADMIN_PROFILE), COMMAND, SET_PASSWORD_URL)).resolves.toEqual({ ok: false, outcome: 'email_exists' })
    expect(store.provisionUser).not.toHaveBeenCalled()
    expect(auth.deleteUser).not.toHaveBeenCalled()
  })

  it('does not remove an account that was already provisioned (a re-sent invitation)', async () => {
    const auth = fakeAuthAdmin({ inviteUser: async () => ({ id: INVITED_USER_ID }) })
    const store = fakeDataStore({ provisionUser: async () => ({ outcome: 'profile_exists', entityId: null }) })
    await expect(inviteUser({ store, auth }, viewerFor(ADMIN_PROFILE), COMMAND, SET_PASSWORD_URL)).resolves.toEqual({ ok: false, outcome: 'profile_exists' })
    expect(auth.deleteUser).not.toHaveBeenCalled()
  })

  it.each<Exclude<ProvisionOutcome, 'provisioned' | 'profile_exists'>>([
    'actor_not_allowed',
    'auth_user_not_found',
    'invalid_assignment',
    'agency_not_found',
    'agency_inactive',
    'branch_not_found',
    'branch_inactive',
  ])('removes the Auth user again when provisioning answers %s', async (outcome) => {
    const auth = fakeAuthAdmin({ inviteUser: async () => ({ id: INVITED_USER_ID }) })
    const store = fakeDataStore({ provisionUser: async () => ({ outcome, entityId: null }) })
    await expect(inviteUser({ store, auth }, viewerFor(ADMIN_PROFILE), COMMAND, SET_PASSWORD_URL)).resolves.toEqual({ ok: false, outcome })
    expect(auth.deleteUser).toHaveBeenCalledWith(INVITED_USER_ID)
    expect(store.getUser).not.toHaveBeenCalled()
  })

  it('still reports the provisioning outcome when the compensation itself fails', async () => {
    const auth = fakeAuthAdmin({
      inviteUser: async () => ({ id: INVITED_USER_ID }),
      deleteUser: async () => {
        throw new Error('auth down')
      },
    })
    const store = fakeDataStore({ provisionUser: async () => ({ outcome: 'branch_inactive', entityId: null }) })
    await expect(inviteUser({ store, auth }, viewerFor(ADMIN_PROFILE), COMMAND, SET_PASSWORD_URL)).resolves.toEqual({ ok: false, outcome: 'branch_inactive' })
  })

  it('reports user_not_found when the provisioned user is not visible on re-read', async () => {
    const auth = fakeAuthAdmin({ inviteUser: async () => ({ id: INVITED_USER_ID }) })
    const store = fakeDataStore({
      provisionUser: async () => ({ outcome: 'provisioned', entityId: INVITED_USER_ID }),
      getUser: async () => null,
    })
    await expect(inviteUser({ store, auth }, viewerFor(ADMIN_PROFILE), COMMAND, SET_PASSWORD_URL)).resolves.toEqual({ ok: false, outcome: 'user_not_found' })
    expect(auth.deleteUser).not.toHaveBeenCalled()
  })
})
