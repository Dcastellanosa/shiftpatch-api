import { describe, expect, it } from 'vitest'
import { ADMIN_PROFILE, SHIFT_ID, fakeDataStore, shiftFixture, viewerFor } from '../../test-support/fakes.js'
import { getShift } from './get-shift.js'

describe('getShift', () => {
  const viewer = viewerFor(ADMIN_PROFILE)

  it('returns a visible shift', async () => {
    const store = fakeDataStore({ getShift: async () => shiftFixture() })
    await expect(getShift({ store }, viewer, SHIFT_ID)).resolves.toEqual({ ok: true, shift: shiftFixture() })
    expect(store.getShift).toHaveBeenCalledWith(viewer, SHIFT_ID)
  })

  it('fails with shift_not_found when the shift is not visible', async () => {
    const store = fakeDataStore({ getShift: async () => null })
    await expect(getShift({ store }, viewer, SHIFT_ID)).resolves.toEqual({ ok: false, outcome: 'shift_not_found' })
  })
})
