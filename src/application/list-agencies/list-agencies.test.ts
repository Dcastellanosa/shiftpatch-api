import { describe, expect, it } from 'vitest'
import { ADMIN_PROFILE, agencyFixture, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { listAgencies } from './list-agencies.js'

describe('listAgencies', () => {
  it('returns every agency the viewer can see', async () => {
    const viewer = viewerFor(ADMIN_PROFILE)
    const agencies = [
      agencyFixture(),
      agencyFixture({ id: 'a1000000-0000-4000-8000-000000000003', name: 'Lakeside', status: 'inactive' }),
    ]
    const store = fakeDataStore({ listAgencies: async () => agencies })

    await expect(listAgencies({ store }, viewer)).resolves.toEqual(agencies)
    expect(store.listAgencies).toHaveBeenCalledWith(viewer)
  })
})
