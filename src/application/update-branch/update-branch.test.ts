import { describe, expect, it } from 'vitest'
import {
  ADMIN_PROFILE,
  AGENCY_ID,
  BRANCH_ID,
  USER,
  agencyBranchFixture,
  fakeDataStore,
  viewerFor,
} from '../../test-support/fakes.js'
import { updateBranch } from './update-branch.js'

describe('updateBranch', () => {
  it('checks the branch belongs to the agency, runs the command and re-reads', async () => {
    const viewer = viewerFor(ADMIN_PROFILE)
    const before = agencyBranchFixture()
    const after = agencyBranchFixture({ status: 'inactive' })
    const reads = [before, after]
    const store = fakeDataStore({
      getAgencyBranch: async () => reads.shift() ?? null,
      updateBranch: async () => ({ outcome: 'updated', entityId: BRANCH_ID }),
    })

    await expect(updateBranch({ store }, viewer, AGENCY_ID, BRANCH_ID, { status: 'inactive' })).resolves.toEqual({
      ok: true,
      branch: after,
    })
    expect(store.getAgencyBranch).toHaveBeenNthCalledWith(1, viewer, AGENCY_ID, BRANCH_ID)
    expect(store.updateBranch).toHaveBeenCalledWith(USER.id, BRANCH_ID, { status: 'inactive' })
  })

  it('answers branch_not_found before running any command when the branch is not under the agency', async () => {
    const store = fakeDataStore({ getAgencyBranch: async () => null })
    await expect(
      updateBranch({ store }, viewerFor(ADMIN_PROFILE), AGENCY_ID, BRANCH_ID, { name: 'x' }),
    ).resolves.toEqual({ ok: false, outcome: 'branch_not_found' })
    expect(store.updateBranch).not.toHaveBeenCalled()
  })

  it.each(['actor_not_allowed', 'name_taken'] as const)('returns %s from the command', async (outcome) => {
    const store = fakeDataStore({
      getAgencyBranch: async () => agencyBranchFixture(),
      updateBranch: async () => ({ outcome, entityId: null }),
    })
    await expect(
      updateBranch({ store }, viewerFor(ADMIN_PROFILE), AGENCY_ID, BRANCH_ID, { name: 'x' }),
    ).resolves.toEqual({ ok: false, outcome })
  })
})
