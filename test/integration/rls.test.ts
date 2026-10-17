import { beforeAll, describe, expect, it } from 'vitest'
import {
  AGENCIES,
  BRANCHES,
  SHIFTS,
  USERS,
  asUser,
  claim,
  createShift,
  expectSqlState,
  openPool,
  windows,
  type FixtureShift,
} from './helpers.js'

const pool = openPool()
const nextWindow = windows(200)

const NORTHWIND_BRANCHES: string[] = [BRANCHES.downtown.id, BRANCHES.riverside.id]
const HARBOR_BRANCHES: string[] = [BRANCHES.bayview.id, BRANCHES.hillcrest.id]

const seeded = (id: string) => SHIFTS.find((s) => s.id === id)!
const OPEN_DOWNTOWN = seeded('e1000000-0000-4000-8000-000000000001')
const OPEN_HILLCREST = seeded('e1000000-0000-4000-8000-000000000004')
const AVA_CLAIMED_BAYVIEW = seeded('e1000000-0000-4000-8000-000000000007')

const visibleShifts = (userId: string | null) =>
  asUser(pool, userId, async (db) => {
    const { rows } = await db.query('select id, branch_id, status, assigned_nurse_id from public.shifts')
    return rows as { id: string; branch_id: string; status: string; assigned_nurse_id: string | null }[]
  })

let elisShift: FixtureShift

beforeAll(async () => {
  // A Hillcrest shift claimed by Eli: Ava must not see it.
  elisShift = await createShift(pool, { branchId: BRANCHES.hillcrest.id, actorId: USERS.harborAgency.id, window: nextWindow() })
  expect(await claim(pool, elisShift.id, USERS.eli.id)).toBe('claimed')
})

describe('admin', () => {
  it('reads every shift, agency and event', async () => {
    const shifts = await visibleShifts(USERS.admin.id)
    const branchIds = new Set(shifts.map((s) => s.branch_id))
    expect([...NORTHWIND_BRANCHES, ...HARBOR_BRANCHES].every((id) => branchIds.has(id))).toBe(true)

    await asUser(pool, USERS.admin.id, async (db) => {
      const { rows: agencies } = await db.query('select id from public.agencies')
      expect(agencies.map((a) => a.id)).toEqual(expect.arrayContaining([AGENCIES.northwind.id, AGENCIES.harbor.id]))
      const { rows: events } = await db.query('select count(*)::int as n from public.shift_events')
      const { rows: all } = await pool.query('select count(*)::int as n from public.shift_events')
      expect(events[0].n).toBe(all[0].n)
    })
  })
})

describe('agency isolation', () => {
  it.each([
    ['Northwind', USERS.northwindAgency.id, NORTHWIND_BRANCHES, AGENCIES.northwind.id],
    ['Harbor', USERS.harborAgency.id, HARBOR_BRANCHES, AGENCIES.harbor.id],
  ])('%s sees only its own agency, branches, shifts and events', async (_name, userId, ownBranches, agencyId) => {
    const shifts = await visibleShifts(userId)
    expect(shifts.length).toBeGreaterThan(0)
    expect(shifts.every((s) => ownBranches.includes(s.branch_id))).toBe(true)

    await asUser(pool, userId, async (db) => {
      const { rows: agencies } = await db.query('select id from public.agencies')
      expect(agencies.map((a) => a.id)).toEqual([agencyId])

      const { rows: branches } = await db.query('select id from public.agency_branches order by id')
      expect(branches.map((b) => b.id).sort()).toEqual([...ownBranches].sort())

      const { rows: events } = await db.query(
        'select s.branch_id from public.shift_events e join public.shifts s on s.id = e.shift_id',
      )
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((e) => ownBranches.includes(e.branch_id))).toBe(true)
    })
  })

  it('cannot see the other agency’s shift by id', async () => {
    await asUser(pool, USERS.northwindAgency.id, async (db) => {
      const { rows } = await db.query('select id from public.shifts where id = $1', [OPEN_HILLCREST.id])
      expect(rows).toEqual([])
    })
  })

  it('cannot update or delete any shift, including another agency’s', async () => {
    await expectSqlState(
      asUser(pool, USERS.northwindAgency.id, (db) =>
        db.query(`update public.shifts set title = 'hijacked' where id = $1`, [OPEN_HILLCREST.id]),
      ),
      '42501',
    )
    await expectSqlState(
      asUser(pool, USERS.northwindAgency.id, (db) =>
        db.query('delete from public.shifts where id = $1', [OPEN_DOWNTOWN.id]),
      ),
      '42501',
    )
  })

  it('cannot insert a shift directly (only through the backend function)', async () => {
    await expectSqlState(
      asUser(pool, USERS.northwindAgency.id, (db) =>
        db.query(
          `insert into public.shifts (branch_id, title, starts_at, ends_at, created_by_id)
           values ($1, 'x', now() + interval '1 day', now() + interval '2 days', $2)`,
          [BRANCHES.downtown.id, USERS.northwindAgency.id],
        ),
      ),
      '42501',
    )
  })
})

describe('nurse visibility', () => {
  it('sees open shifts only in actively eligible branches, plus own assigned shifts', async () => {
    const shifts = await visibleShifts(USERS.ava.id)
    const ids = shifts.map((s) => s.id)
    const avaBranches: string[] = [BRANCHES.downtown.id, BRANCHES.riverside.id, BRANCHES.bayview.id]

    expect(ids).toContain(OPEN_DOWNTOWN.id)
    expect(ids).toContain(AVA_CLAIMED_BAYVIEW.id)
    expect(ids).not.toContain(OPEN_HILLCREST.id) // not eligible at Hillcrest
    expect(ids).not.toContain(elisShift.id) // another nurse's claim
    for (const shift of shifts) {
      const own = shift.assigned_nurse_id === USERS.ava.id
      const openEligible = shift.status === 'open' && avaBranches.includes(shift.branch_id)
      expect(own || openEligible).toBe(true)
    }
  })

  it('sees no open shifts without active eligibility', async () => {
    const shifts = await visibleShifts(USERS.cora.id)
    expect(shifts).toEqual([])
  })

  it('reads only their own profile, credentials and eligibility records', async () => {
    await asUser(pool, USERS.cora.id, async (db) => {
      const { rows: profiles } = await db.query('select id from public.profiles')
      expect(profiles.map((p) => p.id)).toEqual([USERS.cora.id])

      const { rows: credentials } = await db.query('select nurse_id from public.nurse_credentials')
      expect(credentials.length).toBe(2)
      expect(credentials.every((c) => c.nurse_id === USERS.cora.id)).toBe(true)

      const { rows: eligibility } = await db.query('select nurse_id, status from public.branch_nurse_eligibility')
      expect(eligibility.map((e) => e.status).sort()).toEqual(['pending', 'suspended'])
      expect(eligibility.every((e) => e.nurse_id === USERS.cora.id)).toBe(true)

      const { rows: memberships } = await db.query('select id from public.agency_memberships')
      expect(memberships).toEqual([])
    })
  })

  it('reads events only for shifts assigned to them', async () => {
    await asUser(pool, USERS.ava.id, async (db) => {
      const { rows } = await db.query(
        'select distinct s.assigned_nurse_id from public.shift_events e join public.shifts s on s.id = e.shift_id',
      )
      expect(rows).toEqual([{ assigned_nurse_id: USERS.ava.id }])

      const { rows: openEvents } = await db.query('select id from public.shift_events where shift_id = $1', [
        OPEN_DOWNTOWN.id,
      ])
      expect(openEvents).toEqual([])
    })
  })

  it('cannot update shifts, insert events, or call claim_shift directly', async () => {
    await expectSqlState(
      asUser(pool, USERS.ava.id, (db) =>
        db.query(`update public.shifts set status = 'claimed', assigned_nurse_id = $1 where id = $2`, [
          USERS.ava.id,
          OPEN_DOWNTOWN.id,
        ]),
      ),
      '42501',
    )
    await expectSqlState(
      asUser(pool, USERS.ava.id, (db) =>
        db.query(
          `insert into public.shift_events (shift_id, actor_id, event_type, new_status) values ($1, $2, 'claimed', 'claimed')`,
          [OPEN_DOWNTOWN.id, USERS.ava.id],
        ),
      ),
      '42501',
    )
    await expectSqlState(
      asUser(pool, USERS.ava.id, (db) => db.query('select public.claim_shift($1, $2)', [OPEN_DOWNTOWN.id, USERS.ava.id])),
      '42501',
    )
  })
})

describe('self-service escalation is impossible', () => {
  it('a user cannot change their own role', async () => {
    await expectSqlState(
      asUser(pool, USERS.ava.id, (db) => db.query(`update public.profiles set role = 'admin' where id = $1`, [USERS.ava.id])),
      '42501',
    )
  })

  it('a user cannot grant themselves agency membership', async () => {
    await expectSqlState(
      asUser(pool, USERS.northwindAgency.id, (db) =>
        db.query(`insert into public.agency_memberships (profile_id, agency_id) values ($1, $2)`, [
          USERS.northwindAgency.id,
          AGENCIES.harbor.id,
        ]),
      ),
      '42501',
    )
  })

  it('a nurse cannot activate their own branch eligibility', async () => {
    await expectSqlState(
      asUser(pool, USERS.cora.id, (db) =>
        db.query(`update public.branch_nurse_eligibility set status = 'active', activated_at = now() where nurse_id = $1`, [
          USERS.cora.id,
        ]),
      ),
      '42501',
    )
  })

  it('a nurse cannot edit their own credentials', async () => {
    await expectSqlState(
      asUser(pool, USERS.ben.id, (db) =>
        db.query(`update public.nurse_credentials set expires_at = '2099-01-01' where nurse_id = $1`, [USERS.ben.id]),
      ),
      '42501',
    )
  })
})

describe('anonymous and unprovisioned callers', () => {
  it('anon has no table access at all', async () => {
    await expectSqlState(visibleShifts(null), '42501')
  })

  it('an authenticated user without a profile sees nothing', async () => {
    const shifts = await visibleShifts('99999999-0000-4000-8000-000000000000')
    expect(shifts).toEqual([])
  })
})
