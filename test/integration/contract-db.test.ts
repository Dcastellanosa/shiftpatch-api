import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SHIFTS as SPEC_SHIFTS, USERS as SPEC_USERS } from '../../scripts/seed-data.js'
import {
  AGENCIES,
  BRANCHES,
  USERS,
  asUser,
  claim,
  createShift,
  expectSqlState,
  inRollback,
  openPool,
  windows,
  type Queryable,
} from './helpers.js'

const pool = openPool()
const nextWindow = windows(1200)
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

async function asService<T>(db: Queryable, fn: () => Promise<T>) {
  await db.query('set local role service_role')
  try {
    return await fn()
  } finally {
    await db.query('reset role')
  }
}

describe('the trial dataset is seeded exactly', () => {
  it('holds agency-a, agency-b, admin-1, nurse-1, nurse-2 and shift-1..3 with the listed statuses', async () => {
    const { rows: agencies } = await pool.query(
      `select slug, name from shiftpatch.agencies where slug in ('agency-a', 'agency-b') order by slug`,
    )
    expect(agencies).toEqual([
      { slug: 'agency-a', name: 'Sunrise Health Staffing' },
      { slug: 'agency-b', name: 'Metro Care Partners' },
    ])
    const { rows: users } = await pool.query(
      `select p.slug, p.full_name, p.role, u.email from shiftpatch.profiles p join auth.users u on u.id = p.id
       where p.slug in ('admin-1', 'nurse-1', 'nurse-2') order by p.slug`,
    )
    expect(users).toEqual([
      { slug: 'admin-1', full_name: 'Alex Kim', role: 'admin', email: 'alex.kim@example.com' },
      { slug: 'nurse-1', full_name: 'Maria Lopez', role: 'nurse', email: 'maria.lopez@example.com' },
      { slug: 'nurse-2', full_name: 'James Cook', role: 'nurse', email: 'james.cook@example.com' },
    ])
    const { rows: shifts } = await pool.query(
      `select s.slug, a.slug as agency, s.title, s.starts_at, s.ends_at, s.status, n.slug as claimed_by
       from shiftpatch.shifts s join shiftpatch.agency_branches b on b.id = s.branch_id join shiftpatch.agencies a on a.id = b.agency_id
       left join shiftpatch.profiles n on n.id = s.assigned_nurse_id where s.slug in ('shift-1', 'shift-2', 'shift-3') order by s.slug`,
    )
    expect(
      shifts.map((s) => ({ ...s, starts_at: s.starts_at.toISOString(), ends_at: s.ends_at.toISOString() })),
    ).toEqual([
      {
        slug: 'shift-1',
        agency: 'agency-a',
        title: 'RN',
        starts_at: '2026-10-02T19:00:00.000Z',
        ends_at: '2026-10-03T07:00:00.000Z',
        status: 'open',
        claimed_by: null,
      },
      {
        slug: 'shift-2',
        agency: 'agency-a',
        title: 'LPN',
        starts_at: '2026-10-03T07:00:00.000Z',
        ends_at: '2026-10-03T19:00:00.000Z',
        status: 'claimed',
        claimed_by: 'nurse-1',
      },
      {
        slug: 'shift-3',
        agency: 'agency-b',
        title: 'RN',
        starts_at: '2026-10-04T19:00:00.000Z',
        ends_at: '2026-10-05T07:00:00.000Z',
        status: 'open',
        claimed_by: null,
      },
    ])
    expect(SPEC_SHIFTS.map((s) => s.slug)).toEqual(['shift-1', 'shift-2', 'shift-3'])
  })

  it('lets nurse-1 claim the dated shift-1 while nurse-2 is refused for an expired licence', async () => {
    await inRollback(pool, async (db) => {
      const shift1 = SPEC_SHIFTS[0]
      expect(await asService(db, () => claim(db, shift1.id, SPEC_USERS.james.id))).toBe('credential_expired')
      expect(await asService(db, () => claim(db, shift1.id, SPEC_USERS.maria.id))).toBe('claimed')
    })
  })
})

describe('public slugs', () => {
  it.each(['agencies', 'profiles', 'shifts'])('every row of %s carries a unique, well-formed slug', async (table) => {
    const { rows } = await pool.query(`select slug from shiftpatch.${table}`)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.slug).toMatch(SLUG)
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length)
  })

  it('assigns agency-N, shift-N and role-based profile slugs to new rows and keeps explicit ones', async () => {
    await inRollback(pool, async (db) => {
      const { rows: agency } = await db.query(
        `insert into shiftpatch.agencies (name) values ('Slug Agency') returning slug`,
      )
      expect(agency[0].slug).toMatch(/^agency-\d+$/)
      const { rows: explicit } = await db.query(
        `insert into shiftpatch.agencies (name, slug) values ('Explicit', 'agency-z') returning slug`,
      )
      expect(explicit[0].slug).toBe('agency-z')

      const window = nextWindow()
      const { rows: shift } = await db.query(
        `insert into shiftpatch.shifts (branch_id, title, starts_at, ends_at, created_by_id) values ($1, 'Slugged', $2, $3, $4) returning slug`,
        [BRANCHES.downtown.id, window.startsAt, window.endsAt, USERS.northwindAgency.id],
      )
      expect(shift[0].slug).toMatch(/^shift-\d+$/)

      const id = randomUUID()
      await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@shiftpatch.test`])
      const { rows: nurse } = await db.query(
        `insert into shiftpatch.profiles (id, full_name, role) values ($1, 'Slug Nurse', 'nurse') returning slug`,
        [id],
      )
      expect(nurse[0].slug).toMatch(/^nurse-\d+$/)
    })
  })

  it('skips slugs that were taken explicitly instead of failing', async () => {
    await inRollback(pool, async (db) => {
      const { rows: next } = await db.query(`select last_value, is_called from shiftpatch.agency_slug_seq`)
      const upcoming = Number(next[0].last_value) + (next[0].is_called ? 1 : 0)
      await db.query(`insert into shiftpatch.agencies (name, slug) values ('Taken', $1)`, [`agency-${upcoming}`])
      const { rows } = await db.query(`insert into shiftpatch.agencies (name) values ('After Taken') returning slug`)
      expect(rows[0].slug).toBe(`agency-${upcoming + 1}`)
    })
  })
})

describe('list_shifts_marketplace', () => {
  const list = (userId: string | null, args = 'null, null') =>
    asUser(pool, userId, async (db) => {
      const { rows } = await db.query(`select * from shiftpatch.list_shifts_marketplace(${args})`)
      return rows as {
        id: string
        slug: string
        status: string
        agency_slug: string
        assigned_nurse_slug: string | null
      }[]
    })

  it('shows every shift of every agency to a nurse without eligibility, claimed ones included', async () => {
    const { rows: all } = await pool.query('select count(*)::int as n from shiftpatch.shifts')
    const shifts = await list(USERS.cora.id)
    expect(shifts).toHaveLength(all[0].n)
    expect(shifts.some((s) => s.status === 'claimed' && s.assigned_nurse_slug)).toBe(true)
    expect(new Set(shifts.map((s) => s.agency_slug)).size).toBeGreaterThan(1)
  })

  it('shows every agency to agency users and admins, and narrows by agency slug', async () => {
    const { rows: northwind } = await pool.query('select slug from shiftpatch.agencies where id = $1', [
      AGENCIES.northwind.id,
    ])
    for (const user of [USERS.harborAgency.id, USERS.admin.id]) {
      const shifts = await list(user)
      expect(shifts.some((s) => s.agency_slug === northwind[0].slug)).toBe(true)
      const scoped = await list(user, `'${northwind[0].slug}', null`)
      expect(scoped.length).toBeGreaterThan(0)
      expect(scoped.every((s) => s.agency_slug === northwind[0].slug)).toBe(true)
    }
  })

  it('finds one shift by slug', async () => {
    const { rows } = await pool.query('select slug from shiftpatch.shifts limit 1')
    const found = await list(USERS.ava.id, `null, '${rows[0].slug}'`)
    expect(found.map((s) => s.slug)).toEqual([rows[0].slug])
  })

  it('refuses anonymous and unprovisioned callers', async () => {
    await expectSqlState(list(null), '42501')
    await expectSqlState(list('99999999-0000-4000-8000-000000000000'), '42501')
  })
})

describe('timing guards are gone', () => {
  it('create_shift accepts a start in the past and claim_shift accepts a shift that already started', async () => {
    await inRollback(pool, async (db) => {
      const { rows } = await db.query('select outcome, shift_id from shiftpatch.create_shift($1, $2, $3, $4, $5)', [
        USERS.northwindAgency.id,
        BRANCHES.downtown.id,
        'Yesterday',
        new Date(Date.now() - 26 * 3_600_000).toISOString(),
        new Date(Date.now() - 18 * 3_600_000).toISOString(),
      ])
      expect(rows[0].outcome).toBe('created')
      expect(await asService(db, () => claim(db, rows[0].shift_id, USERS.ava.id))).toBe('claimed')
    })
  })
})

describe('cancel_shift_claim', () => {
  const cancel = (db: Queryable, actor: string, shiftId: string, reason: string) =>
    asService(db, async () => {
      const { rows } = await db.query('select * from shiftpatch.cancel_shift_claim($1, $2, $3)', [
        actor,
        shiftId,
        reason,
      ])
      return rows[0] as {
        outcome: string
        shift_id: string | null
        event_id: string | null
        previous_nurse_id: string | null
        previous_nurse_slug: string | null
      }
    })

  async function claimedShift(db: Queryable) {
    const shift = await createShift(db, { window: nextWindow() })
    expect(await asService(db, () => claim(db, shift.id, USERS.ava.id))).toBe('claimed')
    return shift
  }

  it.each([
    ['the assigned nurse reporting a no-show', 'no-show', () => USERS.ava.id, 'reason_not_allowed'],
    ['another nurse', 'advance', () => USERS.ben.id, 'actor_not_allowed'],
    ['another agency', 'no-show', () => USERS.harborAgency.id, 'actor_not_allowed'],
    ['another agency, in advance', 'advance', () => USERS.harborAgency.id, 'actor_not_allowed'],
  ])('refuses %s with %s', async (_who, reason, actor, outcome) => {
    await inRollback(pool, async (db) => {
      const shift = await claimedShift(db)
      expect(await cancel(db, actor(), shift.id, reason)).toMatchObject({ outcome })
      const { rows } = await db.query('select status, assigned_nurse_id from shiftpatch.shifts where id = $1', [
        shift.id,
      ])
      expect(rows[0]).toEqual({ status: 'claimed', assigned_nurse_id: USERS.ava.id })
    })
  })

  it.each([
    ['the owning agency', 'no-show', 'no_show', () => USERS.northwindAgency.id],
    ['an admin', 'advance', 'cancelled', () => USERS.admin.id],
    ['the assigned nurse', 'advance', 'cancelled', () => USERS.ava.id],
  ])('lets %s reopen a claimed shift with reason %s and records a %s event', async (_who, reason, eventType, actor) => {
    await inRollback(pool, async (db) => {
      const shift = await claimedShift(db)
      const { rows: ava } = await db.query('select slug from shiftpatch.profiles where id = $1', [USERS.ava.id])

      const result = await cancel(db, actor(), shift.id, reason)

      expect(result).toMatchObject({
        outcome: 'cancelled',
        shift_id: shift.id,
        previous_nurse_id: USERS.ava.id,
        previous_nurse_slug: ava[0].slug,
      })
      const { rows } = await db.query('select status, assigned_nurse_id from shiftpatch.shifts where id = $1', [
        shift.id,
      ])
      expect(rows).toEqual([{ status: 'open', assigned_nurse_id: null }])
      const { rows: events } = await db.query(
        'select event_type, previous_status, new_status, reason, actor_id from shiftpatch.shift_events where id = $1',
        [result.event_id],
      )
      expect(events).toEqual([
        { event_type: eventType, previous_status: 'claimed', new_status: 'open', reason, actor_id: actor() },
      ])
    })
  })

  it('refuses other agencies, other nurses, unknown actors, open shifts, unknown shifts and bad reasons', async () => {
    await inRollback(pool, async (db) => {
      const shift = await claimedShift(db)
      expect((await cancel(db, USERS.harborAgency.id, shift.id, 'advance')).outcome).toBe('actor_not_allowed')
      expect((await cancel(db, USERS.eli.id, shift.id, 'advance')).outcome).toBe('actor_not_allowed')
      expect((await cancel(db, randomUUID(), shift.id, 'advance')).outcome).toBe('actor_not_allowed')
      expect((await cancel(db, USERS.admin.id, shift.id, 'late')).outcome).toBe('invalid_reason')
      expect((await cancel(db, USERS.admin.id, randomUUID(), 'advance')).outcome).toBe('shift_not_found')
      const open = await createShift(db, { window: nextWindow() })
      expect((await cancel(db, USERS.admin.id, open.id, 'advance')).outcome).toBe('shift_not_claimed')
      const { rows } = await db.query('select status, assigned_nurse_id from shiftpatch.shifts where id = $1', [
        shift.id,
      ])
      expect(rows).toEqual([{ status: 'claimed', assigned_nurse_id: USERS.ava.id }])
    })
  })

  it('lets the shift be claimed again after it was reopened', async () => {
    await inRollback(pool, async (db) => {
      const shift = await claimedShift(db)
      expect((await cancel(db, USERS.northwindAgency.id, shift.id, 'no-show')).outcome).toBe('cancelled')
      expect(await asService(db, () => claim(db, shift.id, USERS.eli.id))).toBe('claimed')
    })
  })

  it('is executable only by service_role, while the marketplace read is open to signed-in users', async () => {
    const { rows } = await pool.query(
      `select has_function_privilege('authenticated', 'shiftpatch.cancel_shift_claim(uuid, uuid, text)', 'EXECUTE') as cancel_auth,
              has_function_privilege('service_role', 'shiftpatch.cancel_shift_claim(uuid, uuid, text)', 'EXECUTE') as cancel_service,
              has_function_privilege('anon', 'shiftpatch.list_shifts_marketplace(text, text)', 'EXECUTE') as market_anon,
              has_function_privilege('authenticated', 'shiftpatch.list_shifts_marketplace(text, text)', 'EXECUTE') as market_auth`,
    )
    expect(rows[0]).toEqual({ cancel_auth: false, cancel_service: true, market_anon: false, market_auth: true })
  })
})
