/**
 * Idempotent seed: `pnpm seed` loads the trial dataset (`seed-data.ts`).
 *
 * Provisions Auth users through the Admin API (role in app_metadata, which
 * only the service role can write) and upserts the business data. Re-running
 * it resets reference data; dated shifts stay as listed, relative fixture
 * shifts that are still open move back into the future. Claimed shifts and
 * history are never rewritten.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SEED_USER_PASSWORD.
 * Refuses to run with NODE_ENV=production.
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseSeedEnv } from '../src/infrastructure/config/env/env.js'
import { DB_SCHEMA } from '../src/infrastructure/persistence/supabase-data-store/supabase-data-store.js'
import { SPEC_DATASET, type SeedDataset, type SeedShift, type SeedUser } from './seed-data.js'

export interface SeedOptions {
  url: string
  serviceRoleKey: string
  password: string
  /** Defaults to the trial dataset. Integration tests add their fixtures through this. */
  dataset?: SeedDataset
  now?: Date
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function check<R extends { data: unknown; error: { message: string } | null }>(result: R, step: string): R['data'] {
  if (result.error) throw new Error(`Seed step "${step}" failed: ${result.error.message}`)
  return result.data
}

const isDated = (when: SeedShift['when']): when is { date: string; startTime: string; endTime: string } =>
  'date' in when

/**
 * Dated shifts are facility-local; seeded branches use UTC so the wall clock
 * is the instant. An end time at or before the start means the next day.
 */
export function shiftTimes(shift: SeedShift, now: Date) {
  const when = shift.when
  if (isDated(when)) {
    const start = Date.parse(`${when.date}T${when.startTime}:00Z`)
    let end = Date.parse(`${when.date}T${when.endTime}:00Z`)
    if (end <= start) end += DAY_MS
    return { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() }
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const start = today + (when.dayOffset * 24 + when.startHourUtc) * HOUR_MS
  return { starts_at: new Date(start).toISOString(), ends_at: new Date(start + when.hours * HOUR_MS).toISOString() }
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
  const data = options.dataset ?? SPEC_DATASET
  const client = createClient(options.url, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const db = (table: string) => client.schema(DB_SCHEMA).from(table)

  for (const user of data.users) {
    await upsertAuthUser(client, user, options.password)
  }
  check(
    await db('profiles').upsert(
      data.users.map((u) => ({ id: u.id, slug: u.slug, full_name: u.fullName, role: u.role })),
    ),
    'profiles',
  )

  check(
    await db('agencies').upsert(data.agencies.map((a) => ({ id: a.id, slug: a.slug, name: a.name, status: a.status }))),
    'agencies',
  )
  check(
    await db('agency_branches').upsert(
      data.branches.map((b) => ({
        id: b.id,
        agency_id: b.agencyId,
        name: b.name,
        address: b.address,
        timezone: b.timezone,
        status: b.status,
      })),
    ),
    'agency_branches',
  )
  check(
    await db('agency_memberships').upsert(
      data.memberships.map((m) => ({ profile_id: m.profileId, agency_id: m.agencyId, status: 'active' })),
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
      data.branches.flatMap((b) =>
        b.requires.map((code) => ({ branch_id: b.id, credential_type_id: typeId(code), is_required: true })),
      ),
    ),
    'branch_credential_requirements',
  )
  check(
    await db('nurse_credentials').upsert(
      data.credentials.map((c) => ({
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
      data.eligibility.map((e) => ({
        nurse_id: e.nurseId,
        branch_id: e.branchId,
        status: e.status,
        activated_at: e.status === 'active' ? '2026-01-01T00:00:00Z' : null,
      })),
      { onConflict: 'nurse_id,branch_id' },
    ),
    'branch_nurse_eligibility',
  )

  // Shifts: insert once; afterwards only still-open relative shifts move.
  const existing = check(
    await db('shifts')
      .select('id, status')
      .in(
        'id',
        data.shifts.map((s) => s.id),
      ),
    'shifts lookup',
  ) as { id: string; status: string }[]
  const existingIds = new Set(existing.map((s) => s.id))

  const fresh = data.shifts.filter((s) => !existingIds.has(s.id))
  if (fresh.length > 0) {
    check(
      await db('shifts').insert(
        fresh.map((s) => ({
          id: s.id,
          slug: s.slug,
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
    check(await db('shift_events').insert(fresh.flatMap((s) => seedEvents(data, s, now))), 'shift_events insert')
  }

  for (const shift of data.shifts) {
    const row = existing.find((s) => s.id === shift.id)
    if (row && row.status === 'open' && shift.status === 'open' && !isDated(shift.when)) {
      check(await db('shifts').update(shiftTimes(shift, now)).eq('id', shift.id), `refresh ${shift.id}`)
    }
  }

  return { users: data.users.length, shiftsInserted: fresh.length }
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

function seedEvents(data: SeedDataset, shift: SeedShift, now: Date): SeedEvent[] {
  // Posted five days before the shift (never in the future), claimed two hours later.
  const { starts_at, ends_at } = shiftTimes(shift, now)
  const posted = Math.min(Date.parse(starts_at) - 5 * DAY_MS, now.getTime() - 3 * HOUR_MS)
  const created = new Date(posted + data.shifts.indexOf(shift) * 60_000)
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
      occurred_at: ends_at,
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
