import { describe, expect, it } from 'vitest'
import { AGENCY_PROFILE, fakeDataStore, nurseEligibilityFixture, viewerFor } from '../../test-support/fakes.js'
import { listAgencyNurses } from './list-agency-nurses.js'

describe('listAgencyNurses', () => {
  it('returns the nurses connected to the viewer agencies', async () => {
    const viewer = viewerFor(AGENCY_PROFILE)
    const nurses = [nurseEligibilityFixture()]
    const store = fakeDataStore({ listAgencyNurses: async () => nurses })
    await expect(listAgencyNurses({ store }, viewer)).resolves.toEqual(nurses)
    expect(store.listAgencyNurses).toHaveBeenCalledWith(viewer)
  })
})
