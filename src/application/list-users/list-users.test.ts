import { describe, expect, it } from 'vitest'
import { ADMIN_PROFILE, adminUserFixture, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { listUsers } from './list-users.js'

describe('listUsers', () => {
  it('returns every user the viewer can list', async () => {
    const viewer = viewerFor(ADMIN_PROFILE)
    const users = [
      adminUserFixture(),
      adminUserFixture({
        id: '7c1e0d52-0000-4000-8000-000000000098',
        role: 'admin',
        status: 'active',
        eligibleBranches: [],
      }),
    ]
    const store = fakeDataStore({ listUsers: async () => users })
    await expect(listUsers({ store }, viewer)).resolves.toEqual(users)
    expect(store.listUsers).toHaveBeenCalledWith(viewer)
  })
})
