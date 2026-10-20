import { describe, expect, it } from 'vitest'
import { AGENCY_PROFILE, BRANCH_ID, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { listBranches } from './list-branches.js'

describe('listBranches', () => {
  it('returns the branches visible to the viewer', async () => {
    const viewer = viewerFor(AGENCY_PROFILE)
    const branch = {
      id: BRANCH_ID,
      name: 'Downtown Clinic',
      address: '120 Main Street',
      timezone: 'America/New_York',
      agency: { id: AGENCY_PROFILE.agencyId!, name: 'Northwind Care Staffing' },
    }
    const store = fakeDataStore({ listBranches: async () => [branch] })

    await expect(listBranches({ store }, viewer)).resolves.toEqual([branch])
    expect(store.listBranches).toHaveBeenCalledWith(viewer)
  })
})
