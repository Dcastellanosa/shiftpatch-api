import { describe, expect, it } from 'vitest'
import { createShift } from './create-shift.js'
import type { CreateOutcome } from '../../domain/outcomes/outcomes.js'
import type { Branch, CreateShiftInput } from '../../domain/shift/shift.js'
import {
  ADMIN_PROFILE,
  AGENCY_ID,
  AGENCY_PROFILE,
  BRANCH_ID,
  SHIFT_ID,
  USER,
  fakeDataStore,
  shiftFixture,
  viewerFor,
} from '../../test-support/fakes.js'

const OTHER_BRANCH_ID = 'b1000000-0000-4000-8000-000000000002'

const branch = (overrides: Partial<Branch> = {}): Branch => ({
  id: BRANCH_ID,
  name: 'Main',
  address: 'Sunrise Health Staffing',
  timezone: 'UTC',
  status: 'active',
  agency: { id: AGENCY_ID, name: 'Sunrise Health Staffing' },
  ...overrides,
})

/** The contract's example: role, facility-local date and times, no branch. */
const INPUT: CreateShiftInput = { role: 'RN', date: '2026-10-05', startTime: '07:00', endTime: '19:00' }

const created = () => ({
  outcome: 'created' as const,
  shiftId: SHIFT_ID,
  eventId: 'f1000000-0000-4000-8000-000000000001',
})

describe('createShift', () => {
  it('posts on the caller’s single active branch with UTC instants built from the facility-local times', async () => {
    const viewer = viewerFor(AGENCY_PROFILE)
    const shift = shiftFixture({ role: 'RN' })
    const store = fakeDataStore({
      listBranches: async () => [branch()],
      createShift: async () => created(),
      getShift: async () => shift,
    })

    const result = await createShift({ store }, viewer, INPUT)

    expect(result).toEqual({ ok: true, shift })
    expect(store.createShift).toHaveBeenCalledWith(USER.id, {
      branchId: BRANCH_ID,
      title: 'RN',
      startsAt: '2026-10-05T07:00:00.000Z',
      endsAt: '2026-10-05T19:00:00.000Z',
    })
    expect(store.getShift).toHaveBeenCalledWith(viewer, SHIFT_ID)
  })

  it('rolls an end time at or before the start time to the next day (an overnight shift)', async () => {
    const store = fakeDataStore({
      listBranches: async () => [branch()],
      createShift: async () => created(),
      getShift: async () => shiftFixture(),
    })

    await createShift({ store }, viewerFor(AGENCY_PROFILE), {
      ...INPUT,
      date: '2026-10-02',
      startTime: '19:00',
      endTime: '07:00',
    })

    expect(store.createShift.mock.calls[0]![1]).toMatchObject({
      startsAt: '2026-10-02T19:00:00.000Z',
      endsAt: '2026-10-03T07:00:00.000Z',
    })
  })

  it('converts from the branch’s own time zone', async () => {
    const store = fakeDataStore({
      listBranches: async () => [branch({ timezone: 'America/New_York' })],
      createShift: async () => created(),
      getShift: async () => shiftFixture(),
    })

    await createShift({ store }, viewerFor(AGENCY_PROFILE), INPUT)

    expect(store.createShift.mock.calls[0]![1]).toMatchObject({
      startsAt: '2026-10-05T11:00:00.000Z',
      endsAt: '2026-10-05T23:00:00.000Z',
    })
  })

  it('uses the named branch when the caller has several', async () => {
    const store = fakeDataStore({
      listBranches: async () => [branch(), branch({ id: OTHER_BRANCH_ID, name: 'North' })],
      createShift: async () => created(),
      getShift: async () => shiftFixture(),
    })

    await createShift({ store }, viewerFor(ADMIN_PROFILE), { ...INPUT, branchId: OTHER_BRANCH_ID })

    expect(store.createShift.mock.calls[0]![1]).toMatchObject({ branchId: OTHER_BRANCH_ID })
  })

  it('asks for a branch when none is named and the caller has several (or none) active', async () => {
    const several = fakeDataStore({ listBranches: async () => [branch(), branch({ id: OTHER_BRANCH_ID })] })
    await expect(createShift({ store: several }, viewerFor(ADMIN_PROFILE), INPUT)).resolves.toEqual({
      ok: false,
      outcome: 'branch_required',
    })
    const inactiveOnly = fakeDataStore({ listBranches: async () => [branch({ status: 'inactive' })] })
    await expect(createShift({ store: inactiveOnly }, viewerFor(AGENCY_PROFILE), INPUT)).resolves.toEqual({
      ok: false,
      outcome: 'branch_required',
    })
    expect(several.createShift).not.toHaveBeenCalled()
  })

  it('answers branch_not_found for a branch the caller cannot see', async () => {
    const store = fakeDataStore({ listBranches: async () => [branch()] })
    await expect(
      createShift({ store }, viewerFor(AGENCY_PROFILE), { ...INPUT, branchId: OTHER_BRANCH_ID }),
    ).resolves.toEqual({
      ok: false,
      outcome: 'branch_not_found',
    })
    expect(store.createShift).not.toHaveBeenCalled()
  })

  it.each<Exclude<CreateOutcome, 'created'>>([
    'actor_not_allowed',
    'branch_not_found',
    'agency_inactive',
    'branch_inactive',
    'invalid_time_range',
  ])('returns %s from the command without re-reading', async (outcome) => {
    const store = fakeDataStore({
      listBranches: async () => [branch()],
      createShift: async () => ({ outcome, shiftId: null, eventId: null }),
    })

    await expect(createShift({ store }, viewerFor(AGENCY_PROFILE), INPUT)).resolves.toEqual({ ok: false, outcome })
    expect(store.getShift).not.toHaveBeenCalled()
  })

  it('returns shift_not_found when the created shift is not visible on re-read', async () => {
    const store = fakeDataStore({
      listBranches: async () => [branch()],
      createShift: async () => created(),
      getShift: async () => null,
    })
    await expect(createShift({ store }, viewerFor(AGENCY_PROFILE), INPUT)).resolves.toEqual({
      ok: false,
      outcome: 'shift_not_found',
    })
  })
})
