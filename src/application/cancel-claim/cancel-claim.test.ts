import { describe, expect, it } from 'vitest'
import { cancelClaim } from './cancel-claim.js'
import type { CancelOutcome } from '../../domain/outcomes/outcomes.js'
import {
  AGENCY_PROFILE,
  NURSE_PROFILE,
  NURSE_SLUG,
  SHIFT_ID,
  USER,
  fakeDataStore,
  shiftFixture,
  viewerFor,
} from '../../test-support/fakes.js'

const cancelled = () => ({
  outcome: 'cancelled' as const,
  shiftId: SHIFT_ID,
  eventId: 'f1000000-0000-4000-8000-000000000002',
  previousNurseId: '7c1e0d52-0000-4000-8000-000000000011',
  previousNurseSlug: NURSE_SLUG,
})

describe('cancelClaim', () => {
  it('cancels with the viewer id and returns the reopened shift plus who held it', async () => {
    const viewer = viewerFor(AGENCY_PROFILE)
    const reopened = shiftFixture({ status: 'open', claimedBy: null })
    const store = fakeDataStore({ cancelClaim: async () => cancelled(), getShift: async () => reopened })

    const result = await cancelClaim({ store }, viewer, SHIFT_ID, 'no-show')

    expect(result).toEqual({
      ok: true,
      shift: reopened,
      cancellation: { reason: 'no-show', previousNurseId: NURSE_SLUG },
    })
    expect(store.cancelClaim).toHaveBeenCalledWith(USER.id, SHIFT_ID, 'no-show')
    expect(store.getShift).toHaveBeenCalledWith(viewer, SHIFT_ID)
  })

  it('refuses a no-show from a nurse before touching the store (nurses only cancel in advance)', async () => {
    const store = fakeDataStore()
    await expect(cancelClaim({ store }, viewerFor(NURSE_PROFILE), SHIFT_ID, 'no-show')).resolves.toEqual({
      ok: false,
      outcome: 'reason_not_allowed',
    })
    expect(store.cancelClaim).not.toHaveBeenCalled()
  })

  it('lets a nurse cancel in advance through the store, which checks the shift is theirs', async () => {
    const reopened = shiftFixture({ status: 'open', claimedBy: null })
    const store = fakeDataStore({ cancelClaim: async () => cancelled(), getShift: async () => reopened })
    await expect(cancelClaim({ store }, viewerFor(NURSE_PROFILE), SHIFT_ID, 'advance')).resolves.toMatchObject({
      ok: true,
    })
    expect(store.cancelClaim).toHaveBeenCalledWith(USER.id, SHIFT_ID, 'advance')
  })

  it.each<Exclude<CancelOutcome, 'cancelled'>>([
    'actor_not_allowed',
    'reason_not_allowed',
    'invalid_reason',
    'shift_not_found',
    'shift_not_claimed',
  ])('returns %s without re-reading', async (outcome) => {
    const store = fakeDataStore({
      cancelClaim: async () => ({
        outcome,
        shiftId: null,
        eventId: null,
        previousNurseId: null,
        previousNurseSlug: null,
      }),
    })

    await expect(cancelClaim({ store }, viewerFor(AGENCY_PROFILE), SHIFT_ID, 'advance')).resolves.toEqual({
      ok: false,
      outcome,
    })
    expect(store.getShift).not.toHaveBeenCalled()
  })

  it('returns shift_not_found when the reopened shift is not visible', async () => {
    const store = fakeDataStore({ cancelClaim: async () => cancelled(), getShift: async () => null })
    await expect(cancelClaim({ store }, viewerFor(AGENCY_PROFILE), SHIFT_ID, 'advance')).resolves.toEqual({
      ok: false,
      outcome: 'shift_not_found',
    })
  })
})
