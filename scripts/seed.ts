/**
 * Idempotent development seed: `pnpm seed`.
 *
 * Provisions Auth users through the Admin API (role in app_metadata, which
 * only the service role can write) and upserts deterministic business data.
 * Re-running it resets reference data and moves still-open seeded shifts back
 * into the future, but never rewrites claimed shifts or shift history.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SEED_USER_PASSWORD.
 * Refuses to run with NODE_ENV=production.
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseSeedEnv } from '../src/config/env.js'
import { DB_SCHEMA } from '../src/data/supabase-data-store.js'
import {
  AGENCIES,
  BRANCHES,
  CREDENTIALS,
  ELIGIBILITY,
  MEMBERSHIPS,
  SHIFTS,
  USERS,
  type SeedShift,
  type SeedUser,
} from './seed-data.js'

export interface SeedOptions {
  url: string
  serviceRoleKey: string
  password: string
  now?: Date
}

const HOUR_MS = 60 * 60 * 1000

function check<R extends { data: unknown; error: { message: string } | null }>(result: R, step: string): R['data'] {
  if (result.error) throw new Error(`Seed step "${step}" failed: ${result.error.message}`)
  return result.data
}

function shiftTimes(shift: SeedShift, now: Date) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const start = today + (shift.dayOffset * 24 + shift.startHourUtc) * HOUR_MS
  return {
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(start + shift.hours * HOUR_MS).toISOString(),
  }
}

async function upsertAuthUser(client: SupabaseClient, user: SeedUser, password: string) {
  const attributes = {
    password,
    email_confirm: true,
    app_metadata: { role: user.role },
    user_metadata: { full_name: user.fullName },
  }
  const existing = await client.auth.admin.getUserById(user.id)
  if (existing.data.user) {
    check(await client.auth.admin.updateUserById(user.id, { email: user.email, ...attributes }), `update ${user.email}`)
    return
  }
  check(await client.auth.admin.createUser({ id: user.id, email: user.email, ...attributes }), `create ${user.email}`)
}

export async function seedDatabase(options: SeedOptions) {
  const now = options.now ?? new Date()
  const client = createClient(options.url, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const db = (table: string) => client.schema(DB_SCHEMA).from(table)

  for (const user of Object.values(USERS)) {
    await upsertAuthUser(client, user, options.password)
  }
  check(
    await db('profiles').upsert(
      Object.values(USERS).map((u) => ({ id: u.id, full_name: u.fullName, role: u.role })),
    ),
    'profiles',
  )

  check(
    await db('agencies').upsert(Object.values(AGENCIES).map((a) => ({ id: a.id, name: a.name, status: 'active' }))),
    'agencies',
  )
  check(
    await db('agency_branches').upsert(
      Object.values(BRANCHES).map((b) => ({
        id: b.id,
        agency_id: b.agencyId,
        name: b.name,
        address: b.address,
        timezone: b.timezone,
      })),
    ),
    'agency_branches',
  )
  check(
    await db('agency_memberships').upsert(
      MEMBERSHIPS.map((m) => ({ profile_id: m.profileId, agency_id: m.agencyId, status: 'active' })),
      { onConflict: 'profile_id,agency_id' },
    ),
    'agency_memberships',
  )

  const types = check(await db('credential_types').select('id, code'), 'credential_types') as {
    id: string
    code: string
  }[]
  const typeId = (code: string) => {
    const found = types.find((t) => t.code === code)
    if (!found) throw new Error(`Missing credential type ${code}; apply migrations first`)
    return found.id
  }

  check(
    await db('branch_credential_requirements').upsert(
      Object.values(BRANCHES).flatMap((b) =>
        b.requires.map((code) => ({ branch_id: b.id, credential_type_id: typeId(code), is_required: true })),
      ),
    ),
    'branch_credential_requirements',
  )
  check(
    await db('nurse_credentials').upsert(
      CREDENTIALS.map((c) => ({
        id: c.id,
        nurse_id: c.nurseId,
        credential_type_id: typeId(c.code),
        issued_at: c.issuedAt,
        expires_at: c.expiresAt,
        status: c.status,
      })),
    ),
    'nurse_credentials',
  )
  check(
    await db('branch_nurse_eligibility').upsert(
      ELIGIBILITY.map((e) => ({
        nurse_id: e.nurseId,
        branch_id: e.branchId,
        status: e.status,
        activated_at: e.status === 'active' ? '2026-01-01T00:00:00Z' : null,
      })),
      { onConflict: 'nurse_id,branch_id' },
    ),
    'branch_nurse_eligibility',
  )

  // Shifts: insert once; afterwards only still-open seeded shifts move.
  const existing = check(
    await db('shifts').select('id, status').in('id', SHIFTS.map((s) => s.id)),
    'shifts lookup',
  ) as { id: string; status: string }[]
  const existingIds = new Set(existing.map((s) => s.id))

  const fresh = SHIFTS.filter((s) => !existingIds.has(s.id))
  if (fresh.length > 0) {
    check(
      await db('shifts').insert(
        fresh.map((s) => ({
          id: s.id,
          branch_id: s.branchId,
          title: s.title,
          ...shiftTimes(s, now),
          status: s.status,
          assigned_nurse_id: s.assignedNurseId ?? null,
          created_by_id: s.createdById,
        })),
      ),
      'shifts insert',
    )
    check(await db('shift_events').insert(fresh.flatMap((s) => seedEvents(s, now))), 'shift_events insert')
  }

  for (const shift of SHIFTS) {
    const row = existing.find((s) => s.id === shift.id)
    if (row && row.status === 'open' && shift.status === 'open') {
      check(await db('shifts').update(shiftTimes(shift, now)).eq('id', shift.id), `refresh ${shift.id}`)
    }
  }

  return { users: Object.keys(USERS).length, shiftsInserted: fresh.length }
}

/** History for a freshly inserted seeded shift, consistent with its status. */
interface SeedEvent {
  shift_id: string
  actor_id: string
  event_type: 'created' | 'claimed' | 'completed'
  previous_status: 'open' | 'claimed' | null
  new_status: 'open' | 'claimed' | 'completed'
  occurred_at: string
}

function seedEvents(shift: SeedShift, now: Date): SeedEvent[] {
  // Posted five days before the shift (never in the future), claimed two hours later.
  const { starts_at } = shiftTimes(shift, now)
  const posted = Math.min(Date.parse(starts_at) - 5 * 24 * HOUR_MS, now.getTime() - 3 * HOUR_MS)
  const created = new Date(posted + SHIFTS.indexOf(shift) * 60_000)
  const events: SeedEvent[] = [
    {
      shift_id: shift.id,
      actor_id: shift.createdById,
      event_type: 'created',
      previous_status: null,
      new_status: 'open',
      occurred_at: created.toISOString(),
    },
  ]
  if (shift.assignedNurseId) {
    events.push({
      shift_id: shift.id,
      actor_id: shift.assignedNurseId,
      event_type: 'claimed',
      previous_status: 'open',
      new_status: 'claimed',
      occurred_at: new Date(created.getTime() + 2 * HOUR_MS).toISOString(),
    })
  }
  if (shift.status === 'completed') {
    events.push({
      shift_id: shift.id,
      actor_id: shift.createdById,
      event_type: 'completed',
      previous_status: 'claimed',
      new_status: 'completed',
      occurred_at: shiftTimes(shift, now).ends_at,
    })
  }
  return events
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const env = parseSeedEnv(process.env)
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed with NODE_ENV=production')
  }
  const summary = await seedDatabase({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    password: env.SEED_USER_PASSWORD,
  })
  console.log(`Seed complete: ${summary.users} accounts, ${summary.shiftsInserted} new shifts.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Seed failed')
    process.exitCode = 1
  })
}
