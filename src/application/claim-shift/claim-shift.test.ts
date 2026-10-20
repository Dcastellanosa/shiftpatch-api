import { describe, expect, it } from 'vitest'
import { claimShift } from './claim-shift.js'
import type { ClaimOutcome } from '../../domain/shift/shift.js'
import { NURSE_PROFILE, SHIFT_ID, USER, fakeDataStore, shiftFixture, viewerFor } from '../../test-support/fakes.js'

const nurse = viewerFor(NURSE_PROFILE)

describe('claimShift', () => {
  it('claims with the viewer id and returns the re-read shift', async () => {
    const claimed = shiftFixture({ status: 'claimed', assignedNurse: { id: USER.id, fullName: 'Ava Thompson' } })
    const store = fakeDataStore({
      claimShift: async () => ({ outcome: 'claimed', shiftId: SHIFT_ID, eventId: SHIFT_ID }),
      getShift: async () => claimed,
    })

    const result = await claimShift({ store }, nurse, SHIFT_ID)

    expect(result).toEqual({ ok: true, shift: claimed })
    expect(store.claimShift).toHaveBeenCalledWith(USER.id, SHIFT_ID)
    expect(store.getShift).toHaveBeenCalledWith(nurse, SHIFT_ID)
  })

  it.each<Exclude<ClaimOutcome, 'claimed'>>([
    'shift_not_found',
    'not_a_nurse',
    'shift_not_open',
    'schedule_conflict',
    'shift_started',
    'eligibility_inactive',
    'credential_missing',
    'credential_expired',
    'credential_revoked',
  ])('returns %s without re-reading the shift', async (outcome) => {
    const store = fakeDataStore({ claimShift: async () => ({ outcome, shiftId: SHIFT_ID, eventId: null }) })

    const result = await claimShift({ store }, nurse, SHIFT_ID)

    expect(result).toEqual({ ok: false, outcome })
    expect(store.getShift).not.toHaveBeenCalled()
  })

  it('returns shift_not_found when the claimed shift is no longer visible', async () => {
    const store = fakeDataStore({
      claimShift: async () => ({ outcome: 'claimed', shiftId: SHIFT_ID, eventId: SHIFT_ID }),
      getShift: async () => null,
    })

    const result = await claimShift({ store }, nurse, SHIFT_ID)

    expect(result).toEqual({ ok: false, outcome: 'shift_not_found' })
  })
})
