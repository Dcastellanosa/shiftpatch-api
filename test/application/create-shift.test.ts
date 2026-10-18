import { describe, expect, it } from 'vitest'
import { createShift } from '../../src/application/create-shift.js'
import type { CreateOutcome } from '../../src/data/data-store.js'
import type { CreateShiftInput } from '../../src/shifts/contracts.js'
import {
  ADMIN_PROFILE,
  AGENCY_PROFILE,
  BRANCH_ID,
  SHIFT_ID,
  USER,
  fakeDataStore,
  shiftFixture,
  viewerFor,
} from '../helpers.js'

const INPUT: CreateShiftInput = {
  branchId: BRANCH_ID,
  title: 'ICU RN — Night',
  startsAt: '2030-01-10T23:00:00Z',
  endsAt: '2030-01-11T07:00:00Z',
}

describe('createShift', () => {
  it.each([AGENCY_PROFILE, ADMIN_PROFILE])('creates as $role with the viewer id and re-reads the shift', async (profile) => {
    const viewer = viewerFor(profile)
    const created = shiftFixture({ title: INPUT.title })
    const store = fakeDataStore({
      createShift: async () => ({ outcome: 'created', shiftId: SHIFT_ID, eventId: SHIFT_ID }),
      getShift: async () => created,
    })

    const result = await createShift({ store }, viewer, INPUT)

    expect(result).toEqual({ ok: true, shift: created })
    expect(store.createShift).toHaveBeenCalledWith(USER.id, INPUT)
    expect(store.getShift).toHaveBeenCalledWith(viewer, SHIFT_ID)
  })

  it.each<Exclude<CreateOutcome, 'created'>>([
    'actor_not_allowed',
    'branch_not_found',
    'invalid_time_range',
    'shift_in_past',
  ])('returns %s without re-reading', async (outcome) => {
    const store = fakeDataStore({ createShift: async () => ({ outcome, shiftId: null, eventId: null }) })

    const result = await createShift({ store }, viewerFor(AGENCY_PROFILE), INPUT)

    expect(result).toEqual({ ok: false, outcome })
    expect(store.getShift).not.toHaveBeenCalled()
  })

  it('returns shift_not_found when the created shift is not visible on re-read', async () => {
    const store = fakeDataStore({
      createShift: async () => ({ outcome: 'created', shiftId: SHIFT_ID, eventId: SHIFT_ID }),
      getShift: async () => null,
    })

    const result = await createShift({ store }, viewerFor(AGENCY_PROFILE), INPUT)

    expect(result).toEqual({ ok: false, outcome: 'shift_not_found' })
  })
})
