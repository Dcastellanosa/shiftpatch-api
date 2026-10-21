import { describe, expect, it } from 'vitest'
import type { CreateBranchOutcome } from '../../domain/outcomes/outcomes.js'
import {
  ADMIN_PROFILE,
  AGENCY_ID,
  BRANCH_ID,
  USER,
  agencyBranchFixture,
  fakeDataStore,
  viewerFor,
} from '../../test-support/fakes.js'
import { createBranch } from './create-branch.js'

const INPUT = { name: 'Uptown Clinic', address: '1 Up Street', timezone: 'America/New_York' }

describe('createBranch', () => {
  it('creates under the agency with the viewer id and re-reads the branch', async () => {
    const viewer = viewerFor(ADMIN_PROFILE)
    const branch = agencyBranchFixture({ name: INPUT.name })
    const store = fakeDataStore({
      createBranch: async () => ({ outcome: 'created', entityId: BRANCH_ID }),
      getAgencyBranch: async () => branch,
    })

    await expect(createBranch({ store }, viewer, AGENCY_ID, INPUT)).resolves.toEqual({ ok: true, branch })
    expect(store.createBranch).toHaveBeenCalledWith(USER.id, AGENCY_ID, INPUT)
    expect(store.getAgencyBranch).toHaveBeenCalledWith(viewer, AGENCY_ID, BRANCH_ID)
  })

  it.each<Exclude<CreateBranchOutcome, 'created'>>([
    'actor_not_allowed',
    'agency_not_found',
    'agency_inactive',
    'name_taken',
  ])('returns %s without re-reading', async (outcome) => {
    const store = fakeDataStore({ createBranch: async () => ({ outcome, entityId: null }) })
    await expect(createBranch({ store }, viewerFor(ADMIN_PROFILE), AGENCY_ID, INPUT)).resolves.toEqual({
      ok: false,
      outcome,
    })
    expect(store.getAgencyBranch).not.toHaveBeenCalled()
  })

  it('returns branch_not_found when the created branch is not visible on re-read', async () => {
    const store = fakeDataStore({
      createBranch: async () => ({ outcome: 'created', entityId: BRANCH_ID }),
      getAgencyBranch: async () => null,
    })
    await expect(createBranch({ store }, viewerFor(ADMIN_PROFILE), AGENCY_ID, INPUT)).resolves.toEqual({
      ok: false,
      outcome: 'branch_not_found',
    })
  })
})
