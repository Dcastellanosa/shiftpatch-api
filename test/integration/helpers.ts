import pg from 'pg'
import request from 'supertest'
import { afterAll, inject } from 'vitest'
import { BRANCHES, USERS, type SeedUser } from '../../scripts/seed-data.js'
import { parseEnv } from '../../src/config/env.js'
import { createApp } from '../../src/create-app.js'

export { AGENCIES, BRANCHES, SHIFTS, USERS } from '../../scripts/seed-data.js'

export const ALLOWED_ORIGIN = 'http://localhost:5173'
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** A pool connected as the local `postgres` superuser. Closed after the file. */
export function openPool() {
  const pool = new pg.Pool({ connectionString: inject('stack').dbUrl, max: 12 })
  afterAll(() => pool.end())
  return pool
}

export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>

/**
 * Runs `fn` inside a transaction that impersonates a Supabase user the way
 * PostgREST does (role + JWT claims), then rolls everything back.
 * `userId: null` impersonates `anon`.
 */
export async function asUser<T>(pool: pg.Pool, userId: string | null, fn: (db: Queryable) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const role = userId ? 'authenticated' : 'anon'
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ])
    await client.query(`set local role ${role}`)
    return await fn(client)
  } finally {
    await client.query('rollback')
    client.release()
  }
}

/** Runs `fn` in a transaction that is always rolled back. */
export async function inRollback<T>(pool: pg.Pool, fn: (db: Queryable) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    return await fn(client)
  } finally {
    await client.query('rollback')
    client.release()
  }
}

/** Expects `promise` to reject with the given SQLSTATE. */
export async function expectSqlState(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { code?: string },
  )
  if (!error) throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`)
  if (error.code !== code) throw new Error(`expected SQLSTATE ${code}, got ${error.code}`)
}

/**
 * Returns a generator of non-overlapping future windows, one day apart,
 * starting `firstDay` days from now. Each test file uses its own range so
 * fixtures never overlap across files (the database is reset once per run).
 */
export function windows(firstDay: number) {
  let slot = 0
  return (hours = 8) => {
    const day = new Date(Date.now() + (firstDay + slot++) * DAY_MS)
    const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12)
    return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + hours * HOUR_MS).toISOString() }
  }
}

export interface FixtureShift {
  id: string
  startsAt: string
  endsAt: string
}

/** Creates an open shift through `create_shift` as the branch's agency user. */
export async function createShift(
  db: Queryable,
  options: { branchId?: string; actorId?: string; window: { startsAt: string; endsAt: string }; title?: string },
): Promise<FixtureShift> {
  const window = options.window
  const { rows } = await db.query(
    'select outcome, shift_id from public.create_shift($1, $2, $3, $4, $5)',
    [
      options.actorId ?? USERS.northwindAgency.id,
      options.branchId ?? BRANCHES.downtown.id,
      options.title ?? 'Integration fixture',
      window.startsAt,
      window.endsAt,
    ],
  )
  if (rows[0].outcome !== 'created') throw new Error(`fixture create_shift returned ${rows[0].outcome}`)
  return { id: rows[0].shift_id as string, ...window }
}

export async function claim(db: Queryable, shiftId: string, nurseId: string): Promise<string> {
  const { rows } = await db.query('select outcome from public.claim_shift($1, $2)', [shiftId, nurseId])
  return rows[0].outcome as string
}

// ---------------------------------------------------------------------------
// HTTP: the real Express app wired to the local Supabase stack
// ---------------------------------------------------------------------------

export function buildRealApp() {
  const stack = inject('stack')
  const env = parseEnv({
    NODE_ENV: 'test',
    CORS_ORIGINS: ALLOWED_ORIGIN,
    SUPABASE_URL: stack.apiUrl,
    SUPABASE_PUBLISHABLE_KEY: stack.publishableKey,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
  })
  return createApp(env)
}

/** A Supertest agent signed in as a seeded user (cookie jar persists the session). */
export async function signIn(app: ReturnType<typeof buildRealApp>, user: SeedUser) {
  const agent = request.agent(app)
  const res = await agent
    .post('/auth/login')
    .set('Origin', ALLOWED_ORIGIN)
    .send({ email: user.email, password: inject('seedPassword') })
  if (res.status !== 200) throw new Error(`sign-in for ${user.role} failed with ${res.status}`)
  return agent
}
