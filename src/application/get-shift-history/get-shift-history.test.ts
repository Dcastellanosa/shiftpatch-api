import { describe, expect, it } from 'vitest'
import { getShiftHistory } from './get-shift-history.js'
import type { ShiftEvent } from '../../domain/shift/shift.js'
import {
  ADMIN_PROFILE,
  AGENCY_PROFILE,
  NURSE_PROFILE,
  SHIFT_ID,
  USER,
  fakeDataStore,
  shiftFixture,
  viewerFor,
} from '../../test-support/fakes.js'

const EVENT: ShiftEvent = {
  id: 'f1000000-0000-4000-8000-000000000001',
  eventType: 'created',
  previousStatus: null,
  newStatus: 'open',
  reason: null,
  occurredAt: '2029-12-01T00:00:00.000Z',
  actor: { id: USER.id, fullName: null },
}

const OTHER_NURSE_ID = '7c1e0d52-0000-4000-8000-000000000099'

describe('getShiftHistory', () => {
  it('returns history to the assigned nurse', async () => {
    const nurse = viewerFor(NURSE_PROFILE)
    const store = fakeDataStore({
      getShift: async () => shiftFixture({ status: 'claimed', assignedNurse: { id: USER.id, fullName: 'Ava' } }),
      listShiftEvents: async () => [EVENT],
    })

    const result = await getShiftHistory({ store }, nurse, SHIFT_ID)

    expect(result).toEqual({ ok: true, events: [EVENT] })
    expect(store.getShift).toHaveBeenCalledWith(nurse, SHIFT_ID)
    expect(store.listShiftEvents).toHaveBeenCalledWith(nurse, SHIFT_ID)
  })

  it.each([
    ['an open shift', shiftFixture()],
    ['a shift assigned to another nurse', shiftFixture({ status: 'claimed', assignedNurse: { id: OTHER_NURSE_ID, fullName: 'Sam' } })],
  ])('hides %s from a nurse without listing events', async (_label, shift) => {
    const store = fakeDataStore({ getShift: async () => shift })

    const result = await getShiftHistory({ store }, viewerFor(NURSE_PROFILE), SHIFT_ID)

    expect(result).toEqual({ ok: false, outcome: 'shift_not_found' })
    expect(store.listShiftEvents).not.toHaveBeenCalled()
  })

  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('returns history to $role for a visible shift', async (profile) => {
    const store = fakeDataStore({ getShift: async () => shiftFixture(), listShiftEvents: async () => [EVENT] })

    const result = await getShiftHistory({ store }, viewerFor(profile), SHIFT_ID)

    expect(result).toEqual({ ok: true, events: [EVENT] })
  })

  it.each([NURSE_PROFILE, AGENCY_PROFILE, ADMIN_PROFILE])(
    'returns shift_not_found to $role when the shift is not visible',
    async (profile) => {
      const store = fakeDataStore({ getShift: async () => null })

      const result = await getShiftHistory({ store }, viewerFor(profile), SHIFT_ID)

      expect(result).toEqual({ ok: false, outcome: 'shift_not_found' })
      expect(store.listShiftEvents).not.toHaveBeenCalled()
    },
  )
})
