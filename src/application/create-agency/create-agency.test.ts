import { describe, expect, it } from 'vitest'
import type { CreateAgencyOutcome } from '../../domain/outcomes/outcomes.js'
import { ADMIN_PROFILE, AGENCY_ID, USER, agencyFixture, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { createAgency } from './create-agency.js'

const INPUT = { name: 'Summit Nursing' }

describe('createAgency', () => {
  it('creates with the viewer id and re-reads the agency', async () => {
    const viewer = viewerFor(ADMIN_PROFILE)
    const agency = agencyFixture({ name: INPUT.name, branchCount: 0 })
    const store = fakeDataStore({
      createAgency: async () => ({ outcome: 'created', entityId: AGENCY_ID }),
      getAgency: async () => ({ agency, branches: [] }),
    })

    await expect(createAgency({ store }, viewer, INPUT)).resolves.toEqual({ ok: true, agency })
    expect(store.createAgency).toHaveBeenCalledWith(USER.id, INPUT)
    expect(store.getAgency).toHaveBeenCalledWith(viewer, AGENCY_ID)
  })

  it.each<Exclude<CreateAgencyOutcome, 'created'>>(['actor_not_allowed', 'name_taken'])('returns %s without re-reading', async (outcome) => {
    const store = fakeDataStore({ createAgency: async () => ({ outcome, entityId: null }) })
    await expect(createAgency({ store }, viewerFor(ADMIN_PROFILE), INPUT)).resolves.toEqual({ ok: false, outcome })
    expect(store.getAgency).not.toHaveBeenCalled()
  })

  it('returns agency_not_found when the created agency is not visible on re-read', async () => {
    const store = fakeDataStore({
      createAgency: async () => ({ outcome: 'created', entityId: AGENCY_ID }),
      getAgency: async () => null,
    })
    await expect(createAgency({ store }, viewerFor(ADMIN_PROFILE), INPUT)).resolves.toEqual({ ok: false, outcome: 'agency_not_found' })
  })
})
