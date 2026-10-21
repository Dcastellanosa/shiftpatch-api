import { describe, expect, it } from 'vitest'
import {
  AGENCIES,
  BRANCHES,
  USERS,
  claim,
  createShift,
  inRollback,
  windows,
  openPool,
  type Queryable,
} from './helpers.js'

const pool = openPool()
const nextWindow = windows(400)

/** Calls claim_shift the way the API does: as the service role. */
async function claimAsService(db: Queryable, shiftId: string, nurseId: string) {
  await db.query('set local role service_role')
  return claim(db, shiftId, nurseId)
}

async function shiftRow(shiftId: string) {
  const { rows } = await pool.query('select status, assigned_nurse_id from shiftpatch.shifts where id = $1', [shiftId])
  return rows[0] as { status: string; assigned_nurse_id: string | null }
}

async function events(shiftId: string) {
  const { rows } = await pool.query(
    'select event_type, actor_id, previous_status, new_status from shiftpatch.shift_events where shift_id = $1 order by occurred_at, id',
    [shiftId],
  )
  return rows
}

describe('claim_shift: success', () => {
  it('assigns the nurse, transitions to claimed and appends a claimed event', async () => {
    const shift = await createShift(pool, { window: nextWindow() })

    const outcome = await inRollbackCommit((db) => claimAsService(db, shift.id, USERS.ava.id))

    expect(outcome).toBe('claimed')
    expect(await shiftRow(shift.id)).toEqual({ status: 'claimed', assigned_nurse_id: USERS.ava.id })
    expect(await events(shift.id)).toEqual([
      { event_type: 'created', actor_id: USERS.northwindAgency.id, previous_status: null, new_status: 'open' },
      { event_type: 'claimed', actor_id: USERS.ava.id, previous_status: 'open', new_status: 'claimed' },
    ])
  })

  it('accepts a credential that expires on the shift date (UTC)', async () => {
    await inRollback(pool, async (db) => {
      const shift = await createShift(db, { window: nextWindow() })
      await db.query(
        `update shiftpatch.nurse_credentials c set expires_at = ($1::timestamptz at time zone 'UTC')::date
         from shiftpatch.credential_types t where t.id = c.credential_type_id and t.code = 'tb_test' and c.nurse_id = $2`,
        [shift.startsAt, USERS.eli.id],
      )
      expect(await claimAsService(db, shift.id, USERS.eli.id)).toBe('claimed')
    })
  })
})

/** Runs `fn` in a transaction and commits it. */
async function inRollbackCommit<T>(fn: (db: Queryable) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

describe('claim_shift: rule failures leave the shift untouched', () => {
  it.each([
    ['expired credential', USERS.ben.id, 'credential_expired'],
    ['inactive eligibility (pending)', USERS.cora.id, 'eligibility_inactive'],
    ['missing required credential', USERS.dev.id, 'credential_missing'],
    ['non-nurse actor', USERS.northwindAgency.id, 'not_a_nurse'],
  ])('rejects %s', async (_label, nurseId, expected) => {
    const shift = await createShift(pool, { window: nextWindow() })

    expect(await inRollbackCommit((db) => claimAsService(db, shift.id, nurseId))).toBe(expected)
    expect(await shiftRow(shift.id)).toEqual({ status: 'open', assigned_nurse_id: null })
    expect((await events(shift.id)).map((e) => e.event_type)).toEqual(['created'])
  })

  it('rejects inactive (suspended) eligibility', async () => {
    const shift = await createShift(pool, {
      branchId: BRANCHES.bayview.id,
      actorId: USERS.harborAgency.id,
      window: nextWindow(),
    })
    expect(await inRollbackCommit((db) => claimAsService(db, shift.id, USERS.cora.id))).toBe('eligibility_inactive')
  })

  it('rejects a nurse with no eligibility record at the branch', async () => {
    const shift = await createShift(pool, {
      branchId: BRANCHES.hillcrest.id,
      actorId: USERS.harborAgency.id,
      window: nextWindow(),
    })
    expect(await inRollbackCommit((db) => claimAsService(db, shift.id, USERS.ava.id))).toBe('eligibility_inactive')
  })

  it('rejects a credential whose status is expired even if its date is in the future', async () => {
    await inRollback(pool, async (db) => {
      const shift = await createShift(db, { window: nextWindow() })
      await db.query(`update shiftpatch.nurse_credentials set status = 'expired' where nurse_id = $1`, [USERS.eli.id])
      expect(await claimAsService(db, shift.id, USERS.eli.id)).toBe('credential_expired')
    })
  })

  it('rejects a credential that expires the day before the shift', async () => {
    await inRollback(pool, async (db) => {
      const shift = await createShift(db, { window: nextWindow() })
      await db.query(
        `update shiftpatch.nurse_credentials c set expires_at = ($1::timestamptz at time zone 'UTC')::date - 1
         from shiftpatch.credential_types t where t.id = c.credential_type_id and t.code = 'tb_test' and c.nurse_id = $2`,
        [shift.startsAt, USERS.eli.id],
      )
      expect(await claimAsService(db, shift.id, USERS.eli.id)).toBe('credential_expired')
    })
  })

  it('rejects a revoked credential', async () => {
    await inRollback(pool, async (db) => {
      const shift = await createShift(db, { window: nextWindow() })
      await db.query(`update shiftpatch.nurse_credentials set status = 'revoked' where nurse_id = $1`, [USERS.eli.id])
      expect(await claimAsService(db, shift.id, USERS.eli.id)).toBe('credential_revoked')
    })
  })

  it('rejects a shift that does not exist', async () => {
    await inRollback(pool, async (db) => {
      expect(await claimAsService(db, '00000000-0000-4000-8000-000000000000', USERS.ava.id)).toBe('shift_not_found')
    })
  })

  it('rejects a shift that is already claimed', async () => {
    const shift = await createShift(pool, { window: nextWindow() })
    expect(await inRollbackCommit((db) => claimAsService(db, shift.id, USERS.eli.id))).toBe('claimed')
    expect(await inRollbackCommit((db) => claimAsService(db, shift.id, USERS.ava.id))).toBe('shift_not_open')
    expect(await shiftRow(shift.id)).toEqual({ status: 'claimed', assigned_nurse_id: USERS.eli.id })
  })
})

describe('claim_shift: schedule conflicts', () => {
  it('rejects an overlapping shift and allows a back-to-back one', async () => {
    const window = nextWindow(8)
    const first = await createShift(pool, { window })
    const overlapping = await createShift(pool, {
      branchId: BRANCHES.riverside.id,
      window: {
        startsAt: new Date(Date.parse(window.startsAt) + 4 * 3_600_000).toISOString(),
        endsAt: new Date(Date.parse(window.endsAt) + 4 * 3_600_000).toISOString(),
      },
    })
    const backToBack = await createShift(pool, {
      window: { startsAt: window.endsAt, endsAt: new Date(Date.parse(window.endsAt) + 4 * 3_600_000).toISOString() },
    })

    expect(await inRollbackCommit((db) => claimAsService(db, first.id, USERS.ava.id))).toBe('claimed')
    expect(await inRollbackCommit((db) => claimAsService(db, overlapping.id, USERS.ava.id))).toBe('schedule_conflict')
    expect(await inRollbackCommit((db) => claimAsService(db, backToBack.id, USERS.ava.id))).toBe('claimed')
    expect(await shiftRow(overlapping.id)).toEqual({ status: 'open', assigned_nurse_id: null })
  })
})

describe('claim_shift: concurrency', () => {
  it('serializes two claims on the same shift: the second waits for the lock and loses', async () => {
    const shift = await createShift(pool, { window: nextWindow() })
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      await first.query('begin')
      expect(await claimAsService(first, shift.id, USERS.ava.id)).toBe('claimed')

      // Ava's transaction still holds the row lock, so Eli's claim must block.
      await second.query('begin')
      let settled = false
      const pending = claimAsService(second, shift.id, USERS.eli.id).finally(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(settled).toBe(false)

      await first.query('commit')
      expect(await pending).toBe('shift_not_open')
      await second.query('commit')
    } finally {
      first.release()
      second.release()
    }

    expect(await shiftRow(shift.id)).toEqual({ status: 'claimed', assigned_nurse_id: USERS.ava.id })
    expect((await events(shift.id)).filter((e) => e.event_type === 'claimed')).toHaveLength(1)
  })

  it('produces exactly one winner when many claims race on separate connections', async () => {
    const shift = await createShift(pool, { window: nextWindow() })
    const nurses = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? USERS.ava.id : USERS.eli.id))

    const outcomes = await Promise.all(
      nurses.map((nurseId) => inRollbackCommit((db) => claimAsService(db, shift.id, nurseId))),
    )

    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'shift_not_open')).toHaveLength(nurses.length - 1)
    expect((await events(shift.id)).filter((e) => e.event_type === 'claimed')).toHaveLength(1)
  })

  it('never double-books a nurse who races to claim two overlapping shifts', async () => {
    const window = nextWindow(8)
    const a = await createShift(pool, { window })
    const b = await createShift(pool, { branchId: BRANCHES.riverside.id, window })

    const outcomes = await Promise.all([
      inRollbackCommit((db) => claimAsService(db, a.id, USERS.ava.id)),
      inRollbackCommit((db) => claimAsService(db, b.id, USERS.ava.id)),
    ])

    expect(outcomes.sort()).toEqual(['claimed', 'schedule_conflict'])
  })
})

/** Runs an admin command as the API would: as the service role, inside the given transaction. */
async function command(db: Queryable, sql: string, params: unknown[]) {
  const { rows } = await db.query(`select outcome, entity_id from ${sql}`, params)
  return rows[0] as { outcome: string; entity_id: string | null }
}

describe('claim_shift: inactive agencies and branches', () => {
  const LAKESIDE_SHIFT = 'e1000000-0000-4000-8000-000000000009'

  it('rejects a shift at a branch of an inactive agency', async () => {
    await inRollback(pool, async (db) => {
      expect(await claimAsService(db, LAKESIDE_SHIFT, USERS.ava.id)).toBe('agency_inactive')
    })
    expect(await shiftRow(LAKESIDE_SHIFT)).toEqual({ status: 'open', assigned_nurse_id: null })
  })

  it('rejects claims and creations at a deactivated branch, and allows them again after reactivation', async () => {
    await inRollback(pool, async (db) => {
      const shift = await createShift(db, { window: nextWindow() })
      await db.query('set local role service_role')
      expect(
        await command(db, 'shiftpatch.update_branch($1, $2, null, null, null, $3)', [
          USERS.admin.id,
          BRANCHES.downtown.id,
          'inactive',
        ]),
      ).toMatchObject({ outcome: 'updated' })
      expect(await claim(db, shift.id, USERS.ava.id)).toBe('branch_inactive')
      const window = nextWindow()
      const { rows } = await db.query('select outcome from shiftpatch.create_shift($1, $2, $3, $4, $5)', [
        USERS.northwindAgency.id,
        BRANCHES.downtown.id,
        'Blocked',
        window.startsAt,
        window.endsAt,
      ])
      expect(rows[0].outcome).toBe('branch_inactive')
      expect(
        await command(db, 'shiftpatch.update_branch($1, $2, null, null, null, $3)', [
          USERS.admin.id,
          BRANCHES.downtown.id,
          'active',
        ]),
      ).toMatchObject({ outcome: 'updated' })
      expect(await claim(db, shift.id, USERS.ava.id)).toBe('claimed')
    })
  })

  it('rejects claims and creations at every branch of a deactivated agency', async () => {
    await inRollback(pool, async (db) => {
      const shift = await createShift(db, { branchId: BRANCHES.riverside.id, window: nextWindow() })
      await db.query('set local role service_role')
      expect(
        await command(db, 'shiftpatch.update_agency($1, $2, null, $3)', [
          USERS.admin.id,
          AGENCIES.northwind.id,
          'inactive',
        ]),
      ).toMatchObject({ outcome: 'updated' })
      expect(await claim(db, shift.id, USERS.ava.id)).toBe('agency_inactive')
      const window = nextWindow()
      const { rows } = await db.query('select outcome from shiftpatch.create_shift($1, $2, $3, $4, $5)', [
        USERS.admin.id,
        BRANCHES.downtown.id,
        'Blocked',
        window.startsAt,
        window.endsAt,
      ])
      expect(rows[0].outcome).toBe('agency_inactive')
      expect(
        await command(db, 'shiftpatch.update_agency($1, $2, null, $3)', [
          USERS.admin.id,
          AGENCIES.northwind.id,
          'active',
        ]),
      ).toMatchObject({ outcome: 'updated' })
      expect(await claim(db, shift.id, USERS.ava.id)).toBe('claimed')
    })
  })

  it('rejects a claim after the agency suspends the nurse, and accepts it after re-activation', async () => {
    await inRollback(pool, async (db) => {
      const shift = await createShift(db, { window: nextWindow() })
      await db.query('set local role service_role')
      expect(
        await command(db, 'shiftpatch.set_branch_eligibility($1, $2, $3, $4)', [
          USERS.northwindAgency.id,
          USERS.ava.id,
          BRANCHES.downtown.id,
          'suspended',
        ]),
      ).toMatchObject({ outcome: 'updated' })
      expect(await claim(db, shift.id, USERS.ava.id)).toBe('eligibility_inactive')
      expect(
        await command(db, 'shiftpatch.set_branch_eligibility($1, $2, $3, $4)', [
          USERS.northwindAgency.id,
          USERS.ava.id,
          BRANCHES.downtown.id,
          'active',
        ]),
      ).toMatchObject({ outcome: 'updated' })
      expect(await claim(db, shift.id, USERS.ava.id)).toBe('claimed')
    })
  })

  it('makes a branch deactivation wait for an in-flight claim; later claims then see the inactive branch', async () => {
    const first = await createShift(pool, { window: nextWindow() })
    const second = await createShift(pool, { window: nextWindow() })
    const claiming = await pool.connect()
    const deactivating = await pool.connect()
    try {
      await claiming.query('begin')
      expect(await claimAsService(claiming, first.id, USERS.ava.id)).toBe('claimed')

      // The claim holds a share lock on the branch; the deactivation must block until it commits.
      await deactivating.query('begin')
      await deactivating.query('set local role service_role')
      let settled = false
      const pending = command(deactivating, 'shiftpatch.update_branch($1, $2, null, null, null, $3)', [
        USERS.admin.id,
        BRANCHES.downtown.id,
        'inactive',
      ]).finally(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(settled).toBe(false)

      await claiming.query('commit')
      expect(await pending).toMatchObject({ outcome: 'updated' })
      await deactivating.query('commit')

      expect(await inRollbackCommit((db) => claimAsService(db, second.id, USERS.eli.id))).toBe('branch_inactive')
      expect(await shiftRow(first.id)).toEqual({ status: 'claimed', assigned_nurse_id: USERS.ava.id })
      expect(await shiftRow(second.id)).toEqual({ status: 'open', assigned_nurse_id: null })
    } finally {
      claiming.release()
      deactivating.release()
      await pool.query(`update shiftpatch.agency_branches set status = 'active' where id = $1`, [BRANCHES.downtown.id])
    }
  })
})
