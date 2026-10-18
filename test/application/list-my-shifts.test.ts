import { describe, expect, it } from 'vitest'
import { listMyShifts } from '../../src/application/list-my-shifts.js'
import { NURSE_PROFILE, fakeDataStore, shiftFixture, viewerFor } from '../helpers.js'

const NOW = Date.parse('2025-06-15T12:00:00.000Z')

const past1 = shiftFixture({
  id: 'e1000000-0000-4000-8000-000000000001',
  startsAt: '2020-01-01T08:00:00.000Z',
  endsAt: '2020-01-01T16:00:00.000Z',
  status: 'completed',
})
const past2 = shiftFixture({
  id: 'e1000000-0000-4000-8000-000000000002',
  startsAt: '2021-01-01T08:00:00.000Z',
  endsAt: '2021-01-01T16:00:00.000Z',
  status: 'completed',
})
const next1 = shiftFixture({
  id: 'e1000000-0000-4000-8000-000000000003',
  startsAt: '2030-01-10T12:00:00.000Z',
  endsAt: '2030-01-10T20:00:00.000Z',
  status: 'claimed',
})
const next2 = shiftFixture({
  id: 'e1000000-0000-4000-8000-000000000004',
  startsAt: '2031-01-10T12:00:00.000Z',
  endsAt: '2031-01-10T20:00:00.000Z',
  status: 'claimed',
})

describe('listMyShifts', () => {
  it('splits assigned shifts at `now`: upcoming in store order, past most recent first', async () => {
    const nurse = viewerFor(NURSE_PROFILE)
    const store = fakeDataStore({ listAssignedShifts: async () => [past1, past2, next1, next2] })

    const result = await listMyShifts({ store }, nurse, NOW)

    expect(result).toEqual({ upcoming: [next1, next2], past: [past2, past1] })
    expect(store.listAssignedShifts).toHaveBeenCalledWith(nurse)
  })

  it('treats a shift that ends exactly at `now` as past', async () => {
    const endingNow = shiftFixture({ endsAt: '2025-06-15T12:00:00.000Z', status: 'claimed' })
    const store = fakeDataStore({ listAssignedShifts: async () => [endingNow] })

    const result = await listMyShifts({ store }, viewerFor(NURSE_PROFILE), NOW)

    expect(result).toEqual({ upcoming: [], past: [endingNow] })
  })

  it('treats a shift still in progress as upcoming', async () => {
    const inProgress = shiftFixture({
      startsAt: '2025-06-15T08:00:00.000Z',
      endsAt: '2025-06-15T16:00:00.000Z',
      status: 'claimed',
    })
    const store = fakeDataStore({ listAssignedShifts: async () => [inProgress] })

    const result = await listMyShifts({ store }, viewerFor(NURSE_PROFILE), NOW)

    expect(result).toEqual({ upcoming: [inProgress], past: [] })
  })
})
