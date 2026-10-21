import { describe, expect, it } from 'vitest'
import {
  ADMIN_PROFILE,
  AGENCY_ID,
  agencyBranchFixture,
  agencyFixture,
  fakeDataStore,
  viewerFor,
} from '../../test-support/fakes.js'
import { getAgency } from './get-agency.js'

describe('getAgency', () => {
  it('returns the agency with its branches', async () => {
    const viewer = viewerFor(ADMIN_PROFILE)
    const detail = { agency: agencyFixture(), branches: [agencyBranchFixture()] }
    const store = fakeDataStore({ getAgency: async () => detail })

    await expect(getAgency({ store }, viewer, AGENCY_ID)).resolves.toEqual({ ok: true, detail })
    expect(store.getAgency).toHaveBeenCalledWith(viewer, AGENCY_ID)
  })

  it('reports agency_not_found when the viewer cannot see it', async () => {
    const store = fakeDataStore({ getAgency: async () => null })
    await expect(getAgency({ store }, viewerFor(ADMIN_PROFILE), AGENCY_ID)).resolves.toEqual({
      ok: false,
      outcome: 'agency_not_found',
    })
  })
})
