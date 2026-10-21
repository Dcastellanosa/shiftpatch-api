import { describe, expect, it } from 'vitest'
import type { UpdateAgencyOutcome } from '../../domain/outcomes/outcomes.js'
import { ADMIN_PROFILE, AGENCY_ID, USER, agencyFixture, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { updateAgency } from './update-agency.js'

describe('updateAgency', () => {
  it('runs the command with the viewer id and re-reads the agency', async () => {
    const viewer = viewerFor(ADMIN_PROFILE)
    const agency = agencyFixture({ status: 'inactive' })
    const store = fakeDataStore({
      updateAgency: async () => ({ outcome: 'updated', entityId: AGENCY_ID }),
      getAgency: async () => ({ agency, branches: [] }),
    })

    await expect(updateAgency({ store }, viewer, AGENCY_ID, { status: 'inactive' })).resolves.toEqual({ ok: true, agency })
    expect(store.updateAgency).toHaveBeenCalledWith(USER.id, AGENCY_ID, { status: 'inactive' })
    expect(store.getAgency).toHaveBeenCalledWith(viewer, AGENCY_ID)
  })

  it.each<Exclude<UpdateAgencyOutcome, 'updated'>>(['actor_not_allowed', 'agency_not_found', 'name_taken'])('returns %s without re-reading', async (outcome) => {
    const store = fakeDataStore({ updateAgency: async () => ({ outcome, entityId: null }) })
    await expect(updateAgency({ store }, viewerFor(ADMIN_PROFILE), AGENCY_ID, { name: 'x' })).resolves.toEqual({ ok: false, outcome })
    expect(store.getAgency).not.toHaveBeenCalled()
  })
})
