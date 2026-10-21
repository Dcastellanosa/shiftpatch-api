import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AGENCIES, BRANCHES, USERS, createShift, expectSqlState, inRollback, windows, openPool } from './helpers.js'

const pool = openPool()
const nextWindow = windows(30)

const APP_TABLES = [
  'profiles',
  'agencies',
  'agency_branches',
  'agency_memberships',
  'credential_types',
  'nurse_credentials',
  'branch_credential_requirements',
  'branch_nurse_eligibility',
  'shifts',
  'shift_events',
  'audit_events',
]

describe('schema', () => {
  it('enables RLS on every application table', async () => {
    const { rows } = await pool.query(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'shiftpatch' and c.relkind = 'r'`,
    )
    const tables = new Map(rows.map((r) => [r.relname as string, r.relrowsecurity as boolean]))
    for (const table of APP_TABLES) expect(tables.get(table), table).toBe(true)
  })

  it('declares the agreed enum types', async () => {
    const { rows } = await pool.query(
      `select t.typname, array_agg(e.enumlabel order by e.enumsortorder)::text[] as labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'shiftpatch' group by t.typname`,
    )
    const types = Object.fromEntries(rows.map((r) => [r.typname, r.labels]))
    expect(types).toMatchObject({
      app_role: ['admin', 'agency', 'nurse'],
      membership_status: ['active', 'suspended'],
      eligibility_status: ['pending', 'active', 'suspended'],
      shift_status: ['open', 'claimed', 'cancelled', 'completed', 'no_show'],
      credential_status: ['valid', 'expired', 'revoked'],
      shift_event_type: ['created', 'claimed', 'cancelled', 'completed', 'no_show'],
      audit_entity_type: ['agency', 'agency_branch', 'agency_membership', 'branch_nurse_eligibility', 'profile'],
      audit_action: ['created', 'updated', 'activated', 'deactivated', 'invited', 'eligibility_activated', 'eligibility_suspended', 'deleted'],
    })
  })

  it('seeds the required credential types', async () => {
    const { rows } = await pool.query('select code from shiftpatch.credential_types order by code')
    expect(rows.map((r) => r.code)).toEqual(expect.arrayContaining(['nursing_license', 'tb_test']))
  })

  it('stores no comma-separated or array columns in application tables', async () => {
    const { rows } = await pool.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'shiftpatch' and data_type = 'ARRAY' and table_name = any($1)`,
      [APP_TABLES],
    )
    expect(rows).toEqual([])
  })
})

describe('shift constraints', () => {
  const insertShift = (overrides: Record<string, unknown>) =>
    inRollback(pool, (db) => {
      const window = nextWindow()
      const row = {
        branch_id: BRANCHES.downtown.id,
        title: 'Constraint check',
        starts_at: window.startsAt,
        ends_at: window.endsAt,
        status: 'open',
        assigned_nurse_id: null,
        created_by_id: USERS.northwindAgency.id,
        ...overrides,
      }
      const columns = Object.keys(row)
      return db.query(
        `insert into shiftpatch.shifts (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      )
    })

  it('rejects ends_at <= starts_at', async () => {
    const window = nextWindow()
    await expectSqlState(insertShift({ starts_at: window.endsAt, ends_at: window.startsAt }), '23514')
  })

  it('rejects an open shift with an assigned nurse', async () => {
    await expectSqlState(insertShift({ assigned_nurse_id: USERS.ava.id }), '23514')
  })

  it.each(['claimed', 'completed', 'no_show'])('rejects a %s shift without a nurse', async (status) => {
    await expectSqlState(insertShift({ status }), '23514')
  })

  it('rejects assigning a non-nurse', async () => {
    await expectSqlState(insertShift({ status: 'claimed', assigned_nurse_id: USERS.northwindAgency.id }), '23514')
  })

  it('rejects a nurse as shift creator', async () => {
    await expectSqlState(insertShift({ created_by_id: USERS.ava.id }), '23514')
  })

  it('rejects a branch that does not exist', async () => {
    await expectSqlState(insertShift({ branch_id: randomUUID() }), '23503')
  })

  it('rejects two overlapping claimed shifts for the same nurse', async () => {
    await inRollback(pool, async (db) => {
      const window = nextWindow()
      const insert = (start: string, end: string) =>
        db.query(
          `insert into shiftpatch.shifts (branch_id, title, starts_at, ends_at, status, assigned_nurse_id, created_by_id)
           values ($1, 'Overlap', $2, $3, 'claimed', $4, $5)`,
          [BRANCHES.downtown.id, start, end, USERS.ava.id, USERS.northwindAgency.id],
        )
      await insert(window.startsAt, window.endsAt)
      await expectSqlState(insert(window.startsAt, window.endsAt), '23P01')
    })
  })
})

describe('bridge-table uniqueness', () => {
  it('rejects a duplicate nurse–branch eligibility pair', async () => {
    await expectSqlState(
      inRollback(pool, (db) =>
        db.query(`insert into shiftpatch.branch_nurse_eligibility (nurse_id, branch_id) values ($1, $2)`, [
          USERS.ava.id,
          BRANCHES.downtown.id,
        ]),
      ),
      '23505',
    )
  })

  it('rejects a duplicate profile–agency membership', async () => {
    await expectSqlState(
      inRollback(pool, (db) =>
        db.query(`insert into shiftpatch.agency_memberships (profile_id, agency_id) values ($1, $2)`, [
          USERS.northwindAgency.id,
          AGENCIES.northwind.id,
        ]),
      ),
      '23505',
    )
  })

  it('allows an agency user to hold several active memberships', async () => {
    await inRollback(pool, async (db) => {
      await db.query(`insert into shiftpatch.agency_memberships (profile_id, agency_id, status) values ($1, $2, 'active')`, [
        USERS.northwindAgency.id,
        AGENCIES.harbor.id,
      ])
      const { rows } = await db.query(
        `select agency_id from shiftpatch.agency_memberships where profile_id = $1 and status = 'active' order by agency_id`,
        [USERS.northwindAgency.id],
      )
      expect(rows.map((r) => r.agency_id)).toEqual([AGENCIES.northwind.id, AGENCIES.harbor.id])
    })
  })

  it('rejects a duplicate branch name within an agency', async () => {
    await expectSqlState(
      inRollback(pool, (db) =>
        db.query(
          `insert into shiftpatch.agency_branches (agency_id, name, address, timezone) values ($1, $2, 'x', 'UTC')`,
          [AGENCIES.northwind.id, BRANCHES.downtown.name],
        ),
      ),
      '23505',
    )
  })

  it('rejects a duplicate branch credential requirement', async () => {
    await expectSqlState(
      inRollback(pool, (db) =>
        db.query(
          `insert into shiftpatch.branch_credential_requirements (branch_id, credential_type_id)
           select $1, id from shiftpatch.credential_types where code = 'tb_test'`,
          [BRANCHES.downtown.id],
        ),
      ),
      '23505',
    )
  })

  it('rejects memberships and credentials for the wrong role', async () => {
    await expectSqlState(
      inRollback(pool, (db) =>
        db.query(`insert into shiftpatch.agency_memberships (profile_id, agency_id) values ($1, $2)`, [
          USERS.ava.id,
          AGENCIES.harbor.id,
        ]),
      ),
      '23514',
    )
    await expectSqlState(
      inRollback(pool, (db) =>
        db.query(
          `insert into shiftpatch.nurse_credentials (nurse_id, credential_type_id, expires_at)
           select $1, id, '2030-01-01' from shiftpatch.credential_types where code = 'tb_test'`,
          [USERS.harborAgency.id],
        ),
      ),
      '23514',
    )
  })
})

describe('shift_events is append-only', () => {
  it('blocks UPDATE and DELETE even for the superuser', async () => {
    await inRollback(pool, async (db) => {
      const shift = await createShift(db, { window: nextWindow() })
      await db.query('savepoint s')
      await expectSqlState(db.query(`update shiftpatch.shift_events set reason = 'x' where shift_id = $1`, [shift.id]), '42501')
      await db.query('rollback to savepoint s')
      await expectSqlState(db.query(`delete from shiftpatch.shift_events where shift_id = $1`, [shift.id]), '42501')
    })
  })

  it('denies UPDATE and DELETE privileges to the service role', async () => {
    const { rows } = await pool.query(
      `select has_table_privilege('service_role', 'shiftpatch.shift_events', 'UPDATE') as upd,
              has_table_privilege('service_role', 'shiftpatch.shift_events', 'DELETE') as del,
              has_table_privilege('service_role', 'shiftpatch.shift_events', 'INSERT') as ins`,
    )
    expect(rows[0]).toEqual({ upd: false, del: false, ins: true })
  })
})

describe('function privileges', () => {
  it.each([
    'claim_shift(uuid, uuid)',
    'create_shift(uuid, uuid, text, timestamptz, timestamptz)',
    'create_agency(uuid, text)',
    'update_agency(uuid, uuid, text, text)',
    'create_branch(uuid, uuid, text, text, text)',
    'update_branch(uuid, uuid, text, text, text, text)',
    'provision_user(uuid, uuid, text, shiftpatch.app_role, uuid[], uuid)',
    'set_branch_eligibility(uuid, uuid, uuid, shiftpatch.eligibility_status)',
    'delete_agency(uuid, uuid)',
    'delete_user(uuid, uuid)',
    'cancel_shift_claim(uuid, uuid, text)',
  ])(
    '%s is executable only by service_role',
    async (signature) => {
      const { rows } = await pool.query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') as service_role`,
        [`shiftpatch.${signature}`],
      )
      expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: true })
    },
  )

  it('client roles have no write privileges on any application table', async () => {
    const { rows } = await pool.query(
      `select t, r, p from unnest($1::text[]) t, unnest(array['anon','authenticated']) r,
              unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
       where has_table_privilege(r, 'shiftpatch.' || t, p)`,
      [APP_TABLES],
    )
    expect(rows).toEqual([])
  })
})

describe('profile provisioning trigger', () => {
  const insertAuthUser = (db: Parameters<Parameters<typeof inRollback>[1]>[0], appMeta: object, userMeta: object) => {
    const id = randomUUID()
    return db
      .query(
        `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values ($1, $2, $3, $4)`,
        [id, `${id}@shiftpatch.test`, appMeta, userMeta],
      )
      .then(() => db.query('select full_name, role from shiftpatch.profiles where id = $1', [id]))
  }

  it('creates a profile from the service-controlled app_metadata role', async () => {
    await inRollback(pool, async (db) => {
      const { rows } = await insertAuthUser(db, { role: 'nurse' }, { full_name: 'New Nurse' })
      expect(rows).toEqual([{ full_name: 'New Nurse', role: 'nurse' }])
    })
  })

  it('ignores a role chosen in user_metadata', async () => {
    await inRollback(pool, async (db) => {
      const { rows } = await insertAuthUser(db, {}, { role: 'admin', full_name: 'Self Promoter' })
      expect(rows).toEqual([])
    })
  })
})

describe('agency administration schema', () => {
  it('gives branches a status with the same contract as agencies', async () => {
    const { rows } = await pool.query(
      `select column_name, column_default, is_nullable from information_schema.columns
       where table_schema = 'shiftpatch' and table_name = 'agency_branches' and column_name = 'status'`,
    )
    expect(rows).toEqual([{ column_name: 'status', column_default: "'active'::text", is_nullable: 'NO' }])
    await expectSqlState(
      inRollback(pool, (db) => db.query(`update shiftpatch.agency_branches set status = 'closed' where id = $1`, [BRANCHES.downtown.id])),
      '23514',
    )
    await expectSqlState(
      inRollback(pool, (db) => db.query(`update shiftpatch.agencies set status = 'closed' where id = $1`, [AGENCIES.northwind.id])),
      '23514',
    )
  })

  it('seeds an inactive agency with an inactive branch', async () => {
    const { rows } = await pool.query(
      `select a.status as agency_status, b.status as branch_status
       from shiftpatch.agency_branches b join shiftpatch.agencies a on a.id = b.agency_id where b.id = $1`,
      [BRANCHES.lakesideClinic.id],
    )
    expect(rows).toEqual([{ agency_status: 'inactive', branch_status: 'inactive' }])
  })

  it('declares admin_command_result as a composite type, not a table', async () => {
    const { rows } = await pool.query(
      `select t.typtype, c.relkind from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       left join pg_class c on c.oid = t.typrelid
       where n.nspname = 'shiftpatch' and t.typname = 'admin_command_result'`,
    )
    expect(rows).toEqual([{ typtype: 'c', relkind: 'c' }])
    const { rows: attrs } = await pool.query(
      `select a.attname, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a
       join pg_type t on t.typrelid = a.attrelid join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'shiftpatch' and t.typname = 'admin_command_result' and a.attnum > 0 order by a.attnum`,
    )
    expect(attrs).toEqual([
      { attname: 'outcome', type: 'text' },
      { attname: 'entity_id', type: 'uuid' },
    ])
  })

  it('exposes list_users_admin to signed-in users only (it rejects non-admins itself)', async () => {
    const { rows } = await pool.query(
      `select has_function_privilege('anon', 'shiftpatch.list_users_admin()', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'shiftpatch.list_users_admin()', 'EXECUTE') as authenticated`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true })
  })
})

describe('audit_events is write-only', () => {
  it('grants no table privilege to any client role, including service_role', async () => {
    const { rows } = await pool.query(
      `select r, p from unnest(array['anon','authenticated','service_role']) r,
              unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
       where has_table_privilege(r, 'shiftpatch.audit_events', p)`,
    )
    expect(rows).toEqual([])
  })

  it('has RLS enabled with no policies', async () => {
    const { rows } = await pool.query(
      `select c.relrowsecurity as rls, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'shiftpatch' and c.relname = 'audit_events'`,
    )
    expect(rows).toEqual([{ rls: true, policies: 0 }])
  })

  it('blocks UPDATE and DELETE even for the superuser', async () => {
    await inRollback(pool, async (db) => {
      const { rows } = await db.query(
        `insert into shiftpatch.audit_events (actor_id, entity_type, entity_id, action, previous_status, new_status)
         values ($1, 'agency', $2, 'updated', 'active', 'active') returning id`,
        [USERS.admin.id, AGENCIES.northwind.id],
      )
      await db.query('savepoint s')
      await expectSqlState(db.query(`update shiftpatch.audit_events set action = 'created' where id = $1`, [rows[0].id]), '42501')
      await db.query('rollback to savepoint s')
      await expectSqlState(db.query(`delete from shiftpatch.audit_events where id = $1`, [rows[0].id]), '42501')
    })
  })

  it('cannot be written through the record_audit helper by any client role', async () => {
    const { rows } = await pool.query(
      `select r from unnest(array['anon','authenticated','service_role']) r
       where has_function_privilege(r, 'shiftpatch.record_audit(uuid, shiftpatch.audit_entity_type, uuid, shiftpatch.audit_action, text, text)', 'EXECUTE')`,
    )
    expect(rows).toEqual([])
  })
})
