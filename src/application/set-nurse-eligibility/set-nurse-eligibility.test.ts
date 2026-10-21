import { describe, expect, it } from 'vitest'
import type { SetEligibilityOutcome } from '../../domain/outcomes/outcomes.js'
import { AGENCY_PROFILE, BRANCH_ID, NURSE_ID, USER, eligibilityFixture, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { setNurseEligibility } from './set-nurse-eligibility.js'

describe('setNurseEligibility', () => {
  it.each(['active', 'suspended'] as const)('runs the command as the viewer and re-reads the %s row', async (status) => {
    const viewer = viewerFor(AGENCY_PROFILE)
    const eligibility = eligibilityFixture({ status })
    const store = fakeDataStore({
      setBranchEligibility: async () => ({ outcome: 'updated', entityId: 'f1000000-0000-4000-8000-000000000001' }),
      getEligibility: async () => eligibility,
    })

    await expect(setNurseEligibility({ store }, viewer, NURSE_ID, BRANCH_ID, status)).resolves.toEqual({ ok: true, eligibility })
    expect(store.setBranchEligibility).toHaveBeenCalledWith(USER.id, NURSE_ID, BRANCH_ID, status)
    expect(store.getEligibility).toHaveBeenCalledWith(viewer, NURSE_ID, BRANCH_ID)
  })

  it.each<Exclude<SetEligibilityOutcome, 'updated'>>(['actor_not_allowed', 'branch_not_found', 'nurse_not_found', 'agency_inactive', 'branch_inactive'])(
    'returns %s without re-reading',
    async (outcome) => {
      const store = fakeDataStore({ setBranchEligibility: async () => ({ outcome, entityId: null }) })
      await expect(setNurseEligibility({ store }, viewerFor(AGENCY_PROFILE), NURSE_ID, BRANCH_ID, 'active')).resolves.toEqual({ ok: false, outcome })
      expect(store.getEligibility).not.toHaveBeenCalled()
    },
  )

  it('returns eligibility_not_found when the row is not visible on re-read', async () => {
    const store = fakeDataStore({
      setBranchEligibility: async () => ({ outcome: 'updated', entityId: 'f1000000-0000-4000-8000-000000000001' }),
      getEligibility: async () => null,
    })
    await expect(setNurseEligibility({ store }, viewerFor(AGENCY_PROFILE), NURSE_ID, BRANCH_ID, 'active')).resolves.toEqual({ ok: false, outcome: 'eligibility_not_found' })
  })
})
