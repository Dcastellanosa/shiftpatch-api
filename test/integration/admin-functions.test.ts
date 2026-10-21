import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AGENCIES, BRANCHES, USERS, expectSqlState, inRollback, openPool, type Queryable } from './helpers.js'

const pool = openPool()

interface Result {
  outcome: string
  entity_id: string | null
}

/** Calls an admin command the way the API does: as the service role. */
async function run(db: Queryable, call: string, params: unknown[]): Promise<Result> {
  await db.query('set local role service_role')
  const { rows } = await db.query(`select outcome, entity_id from shiftpatch.${call}`, params)
  return rows[0] as Result
}

/** Audit rows for one entity, read as the superuser (no client role can). */
/** Audit rows written for `entityId` in the current (rolled-back) transaction; rows committed by other files are ignored. */
async function audits(db: Queryable, entityId: string) {
  await db.query('reset role')
  const { rows } = await db.query(
    'select entity_type, action, previous_status, new_status, actor_id from shiftpatch.audit_events where entity_id = $1 and occurred_at >= now() order by occurred_at, id',
    [entityId],
  )
  return rows as { entity_type: string; action: string; previous_status: string | null; new_status: string | null; actor_id: string }[]
}

/** Inserts an Auth user without a role (so the trigger creates no profile) and returns its id. */
async function newAuthUser(db: Queryable) {
  const id = randomUUID()
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@shiftpatch.test`])
  return id
}

/** A nurse profile with no eligibility anywhere. */
async function newNurse(db: Queryable) {
  const id = await newAuthUser(db)
  await db.query(`insert into shiftpatch.profiles (id, full_name, role) values ($1, 'Fresh Nurse', 'nurse')`, [id])
  return id
}

const ADMIN = USERS.admin.id
const NORTHWIND = USERS.northwindAgency.id
const HARBOR = USERS.harborAgency.id

describe('create_agency', () => {
  it('creates an active agency and records an audit row', async () => {
    await inRollback(pool, async (db) => {
      const result = await run(db, 'create_agency($1, $2)', [ADMIN, '  Summit Nursing  '])
      expect(result.outcome).toBe('created')
      await db.query('reset role')
      const { rows } = await db.query('select name, status from shiftpatch.agencies where id = $1', [result.entity_id])
      expect(rows).toEqual([{ name: 'Summit Nursing', status: 'active' }])
      expect(await audits(db, result.entity_id!)).toEqual([
        { entity_type: 'agency', action: 'created', previous_status: null, new_status: 'active', actor_id: ADMIN },
      ])
    })
  })

  it('reports a taken name without a pre-check', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'create_agency($1, $2)', [ADMIN, AGENCIES.northwind.name])).toEqual({ outcome: 'name_taken', entity_id: null })
    })
  })

  it.each([
    ['agency user', NORTHWIND],
    ['nurse', USERS.ava.id],
    ['unknown profile', randomUUID()],
  ])('refuses a %s actor', async (_label, actor) => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'create_agency($1, $2)', [actor, 'Nope Staffing'])).toEqual({ outcome: 'actor_not_allowed', entity_id: null })
      await db.query('reset role')
      const { rows } = await db.query(`select 1 from shiftpatch.agencies where name = 'Nope Staffing'`)
      expect(rows).toEqual([])
    })
  })

  it('lets exactly one of two concurrent creations win the name', async () => {
    const name = `Race Staffing ${Date.now()}`
    const attempt = async () => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await run(client, 'create_agency($1, $2)', [ADMIN, name])
        await client.query('commit')
        return result.outcome
      } finally {
        client.release()
      }
    }
    try {
      const outcomes = await Promise.all([attempt(), attempt()])
      expect(outcomes.sort()).toEqual(['created', 'name_taken'])
    } finally {
      await pool.query('delete from shiftpatch.agencies where name = $1', [name])
    }
  })
})

describe('update_agency', () => {
  it('renames and deactivates, leaving null arguments unchanged, and audits each change', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'update_agency($1, $2, $3, $4)', [ADMIN, AGENCIES.harbor.id, 'Harbor Health Group', null])).toEqual({ outcome: 'updated', entity_id: AGENCIES.harbor.id })
      expect(await run(db, 'update_agency($1, $2, $3, $4)', [ADMIN, AGENCIES.harbor.id, null, 'inactive'])).toEqual({ outcome: 'updated', entity_id: AGENCIES.harbor.id })
      await db.query('reset role')
      const { rows } = await db.query('select name, status from shiftpatch.agencies where id = $1', [AGENCIES.harbor.id])
      expect(rows).toEqual([{ name: 'Harbor Health Group', status: 'inactive' }])
      expect((await audits(db, AGENCIES.harbor.id)).map((a) => [a.action, a.previous_status, a.new_status])).toEqual([
        ['updated', 'active', 'active'],
        ['deactivated', 'active', 'inactive'],
      ])
    })
  })

  it('reactivates an inactive agency', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'update_agency($1, $2, $3, $4)', [ADMIN, AGENCIES.lakeside.id, null, 'active'])).toMatchObject({ outcome: 'updated' })
      expect((await audits(db, AGENCIES.lakeside.id)).map((a) => a.action)).toEqual(['activated'])
    })
  })

  it('writes no audit row when nothing changes', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'update_agency($1, $2, $3, $4)', [ADMIN, AGENCIES.harbor.id, AGENCIES.harbor.name, 'active'])).toMatchObject({ outcome: 'updated' })
      expect(await audits(db, AGENCIES.harbor.id)).toEqual([])
    })
  })

  it('reports unknown agencies and taken names', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'update_agency($1, $2, $3, $4)', [ADMIN, randomUUID(), 'x', null])).toEqual({ outcome: 'agency_not_found', entity_id: null })
      expect(await run(db, 'update_agency($1, $2, $3, $4)', [ADMIN, AGENCIES.harbor.id, AGENCIES.northwind.name, null])).toEqual({ outcome: 'name_taken', entity_id: null })
    })
  })

  it('refuses non-admin actors', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'update_agency($1, $2, $3, $4)', [NORTHWIND, AGENCIES.northwind.id, null, 'inactive'])).toEqual({ outcome: 'actor_not_allowed', entity_id: null })
    })
  })
})

describe('create_branch', () => {
  it('creates an active branch under an active agency and audits it', async () => {
    await inRollback(pool, async (db) => {
      const result = await run(db, 'create_branch($1, $2, $3, $4, $5)', [ADMIN, AGENCIES.northwind.id, ' Uptown Clinic ', ' 1 Up Street ', 'America/New_York'])
      expect(result.outcome).toBe('created')
      await db.query('reset role')
      const { rows } = await db.query('select agency_id, name, address, timezone, status from shiftpatch.agency_branches where id = $1', [result.entity_id])
      expect(rows).toEqual([{ agency_id: AGENCIES.northwind.id, name: 'Uptown Clinic', address: '1 Up Street', timezone: 'America/New_York', status: 'active' }])
      expect((await audits(db, result.entity_id!)).map((a) => a.action)).toEqual(['created'])
    })
  })

  it.each([
    ['unknown agency', randomUUID(), 'New Branch', 'agency_not_found'],
    ['inactive agency', AGENCIES.lakeside.id, 'New Branch', 'agency_inactive'],
    ['taken name within the agency', AGENCIES.northwind.id, BRANCHES.downtown.name, 'name_taken'],
  ])('reports %s', async (_label, agencyId, name, outcome) => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'create_branch($1, $2, $3, $4, $5)', [ADMIN, agencyId, name, 'Somewhere', 'UTC'])).toEqual({ outcome, entity_id: null })
    })
  })

  it('allows the same branch name under another agency', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'create_branch($1, $2, $3, $4, $5)', [ADMIN, AGENCIES.harbor.id, BRANCHES.downtown.name, 'Somewhere', 'UTC'])).toMatchObject({ outcome: 'created' })
    })
  })

  it('refuses non-admin actors', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'create_branch($1, $2, $3, $4, $5)', [NORTHWIND, AGENCIES.northwind.id, 'Mine', 'x', 'UTC'])).toEqual({ outcome: 'actor_not_allowed', entity_id: null })
    })
  })
})

describe('update_branch', () => {
  it('edits fields, deactivates and reactivates, auditing each change', async () => {
    await inRollback(pool, async (db) => {
      const call = 'update_branch($1, $2, $3, $4, $5, $6)'
      expect(await run(db, call, [ADMIN, BRANCHES.riverside.id, 'Riverside General', null, 'America/Chicago', null])).toMatchObject({ outcome: 'updated' })
      expect(await run(db, call, [ADMIN, BRANCHES.riverside.id, null, null, null, 'inactive'])).toMatchObject({ outcome: 'updated' })
      expect(await run(db, call, [ADMIN, BRANCHES.riverside.id, null, null, null, 'active'])).toMatchObject({ outcome: 'updated' })
      await db.query('reset role')
      const { rows } = await db.query('select name, address, timezone, status from shiftpatch.agency_branches where id = $1', [BRANCHES.riverside.id])
      expect(rows).toEqual([{ name: 'Riverside General', address: BRANCHES.riverside.address, timezone: 'America/Chicago', status: 'active' }])
      expect((await audits(db, BRANCHES.riverside.id)).map((a) => [a.action, a.previous_status, a.new_status])).toEqual([
        ['updated', 'active', 'active'],
        ['deactivated', 'active', 'inactive'],
        ['activated', 'inactive', 'active'],
      ])
    })
  })

  it('may activate a branch whose agency is inactive (availability still needs both)', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'update_branch($1, $2, $3, $4, $5, $6)', [ADMIN, BRANCHES.lakesideClinic.id, null, null, null, 'active'])).toMatchObject({ outcome: 'updated' })
    })
  })

  it('reports unknown branches and taken names', async () => {
    await inRollback(pool, async (db) => {
      const call = 'update_branch($1, $2, $3, $4, $5, $6)'
      expect(await run(db, call, [ADMIN, randomUUID(), 'x', null, null, null])).toEqual({ outcome: 'branch_not_found', entity_id: null })
      expect(await run(db, call, [ADMIN, BRANCHES.riverside.id, BRANCHES.downtown.name, null, null, null])).toEqual({ outcome: 'name_taken', entity_id: null })
    })
  })

  it('refuses non-admin actors', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, 'update_branch($1, $2, $3, $4, $5, $6)', [HARBOR, BRANCHES.bayview.id, null, null, null, 'inactive'])).toEqual({ outcome: 'actor_not_allowed', entity_id: null })
    })
  })
})

describe('provision_user', () => {
  const call = 'provision_user($1, $2, $3, $4, $5, $6)'

  it('provisions an agency user with one active membership per agency', async () => {
    await inRollback(pool, async (db) => {
      const userId = await newAuthUser(db)
      expect(await run(db, call, [ADMIN, userId, ' Pat Agency ', 'agency', [AGENCIES.northwind.id, AGENCIES.harbor.id, AGENCIES.harbor.id], null])).toEqual({ outcome: 'provisioned', entity_id: userId })
      await db.query('reset role')
      const { rows: profile } = await db.query('select full_name, role from shiftpatch.profiles where id = $1', [userId])
      expect(profile).toEqual([{ full_name: 'Pat Agency', role: 'agency' }])
      const { rows: memberships } = await db.query('select agency_id, status from shiftpatch.agency_memberships where profile_id = $1 order by agency_id', [userId])
      expect(memberships).toEqual([
        { agency_id: AGENCIES.northwind.id, status: 'active' },
        { agency_id: AGENCIES.harbor.id, status: 'active' },
      ])
      expect((await audits(db, userId)).map((a) => [a.entity_type, a.action, a.new_status])).toEqual([['profile', 'invited', 'agency']])
      const { rows: membershipAudits } = await db.query(`select count(*)::int as n from shiftpatch.audit_events where entity_type = 'agency_membership' and entity_id in (select id from shiftpatch.agency_memberships where profile_id = $1)`, [userId])
      expect(membershipAudits[0].n).toBe(2)
    })
  })

  it('provisions a nurse with one active eligibility, which derives their agency access', async () => {
    await inRollback(pool, async (db) => {
      const userId = await newAuthUser(db)
      expect(await run(db, call, [ADMIN, userId, 'Nina Nurse', 'nurse', null, BRANCHES.downtown.id])).toEqual({ outcome: 'provisioned', entity_id: userId })
      await db.query('reset role')
      const { rows } = await db.query('select branch_id, status, activated_at is not null as activated from shiftpatch.branch_nurse_eligibility where nurse_id = $1', [userId])
      expect(rows).toEqual([{ branch_id: BRANCHES.downtown.id, status: 'active', activated: true }])
      const { rows: visible } = await db.query(`select agency_id from shiftpatch.agency_branches b where b.id = $1`, [BRANCHES.downtown.id])
      expect(visible).toEqual([{ agency_id: AGENCIES.northwind.id }])
      const { rows: eligibilityAudits } = await db.query(`select action from shiftpatch.audit_events where entity_type = 'branch_nurse_eligibility' and entity_id in (select id from shiftpatch.branch_nurse_eligibility where nurse_id = $1)`, [userId])
      expect(eligibilityAudits).toEqual([{ action: 'eligibility_activated' }])
    })
  })

  it('provisions an admin with a profile only', async () => {
    await inRollback(pool, async (db) => {
      const userId = await newAuthUser(db)
      expect(await run(db, call, [ADMIN, userId, 'Sam Admin', 'admin', null, null])).toEqual({ outcome: 'provisioned', entity_id: userId })
      await db.query('reset role')
      const { rows } = await db.query('select role from shiftpatch.profiles where id = $1', [userId])
      expect(rows).toEqual([{ role: 'admin' }])
    })
  })

  it.each([
    ['an agency user without agencies', 'agency', [], null, 'invalid_assignment'],
    ['an agency user with a branch', 'agency', [AGENCIES.northwind.id], BRANCHES.downtown.id, 'invalid_assignment'],
    ['a nurse without a branch', 'nurse', null, null, 'invalid_assignment'],
    ['a nurse with agencies', 'nurse', [AGENCIES.northwind.id], BRANCHES.downtown.id, 'invalid_assignment'],
    ['an admin with an agency', 'admin', [AGENCIES.northwind.id], null, 'invalid_assignment'],
    ['an unknown agency', 'agency', [randomUUID()], null, 'agency_not_found'],
    ['an inactive agency', 'agency', [AGENCIES.northwind.id, AGENCIES.lakeside.id], null, 'agency_inactive'],
    ['an unknown branch', 'nurse', null, randomUUID(), 'branch_not_found'],
    ['a branch of an inactive agency', 'nurse', null, BRANCHES.lakesideClinic.id, 'agency_inactive'],
  ])('rejects %s and provisions nothing', async (_label, role, agencyIds, branchId, outcome) => {
    await inRollback(pool, async (db) => {
      const userId = await newAuthUser(db)
      expect(await run(db, call, [ADMIN, userId, 'Rejected', role, agencyIds, branchId])).toEqual({ outcome, entity_id: null })
      await db.query('reset role')
      const { rows } = await db.query('select 1 from shiftpatch.profiles where id = $1', [userId])
      expect(rows).toEqual([])
    })
  })

  it('rejects a nurse assignment to an inactive branch of an active agency', async () => {
    await inRollback(pool, async (db) => {
      const userId = await newAuthUser(db)
      expect(await run(db, 'update_branch($1, $2, $3, $4, $5, $6)', [ADMIN, BRANCHES.downtown.id, null, null, null, 'inactive'])).toMatchObject({ outcome: 'updated' })
      expect(await run(db, call, [ADMIN, userId, 'Rejected', 'nurse', null, BRANCHES.downtown.id])).toEqual({ outcome: 'branch_inactive', entity_id: null })
    })
  })

  it('rejects an existing profile, a missing Auth user and non-admin actors', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, call, [ADMIN, USERS.ava.id, 'Ava', 'nurse', null, BRANCHES.downtown.id])).toEqual({ outcome: 'profile_exists', entity_id: null })
      expect(await run(db, call, [ADMIN, randomUUID(), 'Ghost', 'admin', null, null])).toEqual({ outcome: 'auth_user_not_found', entity_id: null })
      const userId = await (async () => {
        await db.query('reset role')
        return newAuthUser(db)
      })()
      expect(await run(db, call, [NORTHWIND, userId, 'Pat', 'nurse', null, BRANCHES.downtown.id])).toEqual({ outcome: 'actor_not_allowed', entity_id: null })
    })
  })
})

describe('set_branch_eligibility', () => {
  const call = 'set_branch_eligibility($1, $2, $3, $4)'

  it('lets an agency user suspend and re-activate a connected nurse at its own branch', async () => {
    await inRollback(pool, async (db) => {
      const suspended = await run(db, call, [NORTHWIND, USERS.ava.id, BRANCHES.downtown.id, 'suspended'])
      expect(suspended.outcome).toBe('updated')
      await db.query('reset role')
      const { rows: afterSuspend } = await db.query('select status from shiftpatch.branch_nurse_eligibility where id = $1', [suspended.entity_id])
      expect(afterSuspend).toEqual([{ status: 'suspended' }])

      const activated = await run(db, call, [NORTHWIND, USERS.ava.id, BRANCHES.downtown.id, 'active'])
      expect(activated).toEqual(suspended)
      await db.query('reset role')
      const { rows: afterActivate } = await db.query(`select status, activated_at > now() - interval '1 minute' as fresh from shiftpatch.branch_nurse_eligibility where id = $1`, [suspended.entity_id])
      expect(afterActivate).toEqual([{ status: 'active', fresh: true }])
      expect((await audits(db, suspended.entity_id!)).map((a) => [a.action, a.previous_status, a.new_status, a.actor_id])).toEqual([
        ['eligibility_suspended', 'active', 'suspended', NORTHWIND],
        ['eligibility_activated', 'suspended', 'active', NORTHWIND],
      ])
    })
  })

  it('creates the eligibility row when a connected nurse is activated at another branch of the agency', async () => {
    await inRollback(pool, async (db) => {
      // Eli is connected to Northwind through Downtown, but has no row at Riverside yet.
      const result = await run(db, call, [NORTHWIND, USERS.eli.id, BRANCHES.riverside.id, 'active'])
      expect(result.outcome).toBe('updated')
      await db.query('reset role')
      const { rows } = await db.query('select nurse_id, branch_id, status from shiftpatch.branch_nurse_eligibility where id = $1', [result.entity_id])
      expect(rows).toEqual([{ nurse_id: USERS.eli.id, branch_id: BRANCHES.riverside.id, status: 'active' }])
      expect((await audits(db, result.entity_id!)).map((a) => [a.action, a.previous_status, a.new_status])).toEqual([['eligibility_activated', null, 'active']])
    })
  })

  it('is idempotent: repeating the same status writes no second audit row', async () => {
    await inRollback(pool, async (db) => {
      const first = await run(db, call, [NORTHWIND, USERS.ava.id, BRANCHES.downtown.id, 'active'])
      expect(first.outcome).toBe('updated')
      expect(await audits(db, first.entity_id!)).toEqual([])
    })
  })

  it('answers branch_not_found for a branch outside the actor’s agencies', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, call, [HARBOR, USERS.ava.id, BRANCHES.downtown.id, 'suspended'])).toEqual({ outcome: 'branch_not_found', entity_id: null })
      expect(await run(db, call, [NORTHWIND, USERS.ava.id, BRANCHES.bayview.id, 'suspended'])).toEqual({ outcome: 'branch_not_found', entity_id: null })
      expect(await run(db, call, [NORTHWIND, USERS.ava.id, randomUUID(), 'suspended'])).toEqual({ outcome: 'branch_not_found', entity_id: null })
      await db.query('reset role')
      const { rows } = await db.query('select status from shiftpatch.branch_nurse_eligibility where nurse_id = $1 and branch_id = $2', [USERS.ava.id, BRANCHES.downtown.id])
      expect(rows).toEqual([{ status: 'active' }])
    })
  })

  it('answers nurse_not_found for a nurse not connected to the actor’s agencies, while an admin may activate them', async () => {
    await inRollback(pool, async (db) => {
      const nurse = await newNurse(db)
      expect(await run(db, call, [NORTHWIND, nurse, BRANCHES.downtown.id, 'active'])).toEqual({ outcome: 'nurse_not_found', entity_id: null })
      expect(await run(db, call, [NORTHWIND, randomUUID(), BRANCHES.downtown.id, 'active'])).toEqual({ outcome: 'nurse_not_found', entity_id: null })
      expect(await run(db, call, [NORTHWIND, USERS.harborAgency.id, BRANCHES.downtown.id, 'active'])).toEqual({ outcome: 'nurse_not_found', entity_id: null })
      expect(await run(db, call, [ADMIN, nurse, BRANCHES.downtown.id, 'active'])).toMatchObject({ outcome: 'updated' })
    })
  })

  it('refuses changes at inactive agencies and branches', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, call, [ADMIN, USERS.ava.id, BRANCHES.lakesideClinic.id, 'suspended'])).toEqual({ outcome: 'agency_inactive', entity_id: null })
      expect(await run(db, 'update_branch($1, $2, $3, $4, $5, $6)', [ADMIN, BRANCHES.riverside.id, null, null, null, 'inactive'])).toMatchObject({ outcome: 'updated' })
      expect(await run(db, call, [NORTHWIND, USERS.ava.id, BRANCHES.riverside.id, 'suspended'])).toEqual({ outcome: 'branch_inactive', entity_id: null })
    })
  })

  it('refuses nurse actors and statuses other than active/suspended', async () => {
    await inRollback(pool, async (db) => {
      expect(await run(db, call, [USERS.ava.id, USERS.ava.id, BRANCHES.downtown.id, 'active'])).toEqual({ outcome: 'actor_not_allowed', entity_id: null })
    })
    await expectSqlState(
      inRollback(pool, (db) => run(db, call, [ADMIN, USERS.ava.id, BRANCHES.downtown.id, 'pending'])),
      '23514',
    )
  })
})
