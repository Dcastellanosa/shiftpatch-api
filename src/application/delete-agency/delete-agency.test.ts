import { describe, expect, it } from 'vitest'
import type { DeleteAgencyOutcome } from '../../domain/outcomes/outcomes.js'
import { ADMIN_PROFILE, AGENCY_ID, USER, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { deleteAgency } from './delete-agency.js'

describe('deleteAgency', () => {
  it('runs the command with the viewer id', async () => {
    const store = fakeDataStore({ deleteAgency: async () => ({ outcome: 'deleted', entityId: AGENCY_ID }) })
    await expect(deleteAgency({ store }, viewerFor(ADMIN_PROFILE), AGENCY_ID)).resolves.toEqual({ ok: true })
    expect(store.deleteAgency).toHaveBeenCalledWith(USER.id, AGENCY_ID)
  })

  it.each<Exclude<DeleteAgencyOutcome, 'deleted'>>(['actor_not_allowed', 'agency_not_found', 'agency_has_shifts'])(
    'returns %s',
    async (outcome) => {
      const store = fakeDataStore({ deleteAgency: async () => ({ outcome, entityId: null }) })
      await expect(deleteAgency({ store }, viewerFor(ADMIN_PROFILE), AGENCY_ID)).resolves.toEqual({
        ok: false,
        outcome,
      })
    },
  )
})
