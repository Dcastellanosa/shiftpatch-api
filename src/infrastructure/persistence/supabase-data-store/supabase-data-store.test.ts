import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataStoreError, DataUnavailableError } from '../../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../../domain/viewer/viewer.js'
import { DB_SCHEMA, createSupabaseDataStore } from './supabase-data-store.js'

type Result = { data: unknown; error: { code?: string } | null }

/** A chainable PostgREST query double: records every call and resolves to `result` when awaited. */
function fakeQuery(result: Result) {
  const calls: unknown[][] = []
  const query: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject)
        }
        return (...args: unknown[]) => {
          calls.push([prop, ...args])
          return query
        }
      },
    },
  )
  return { query, calls }
}

const supabase = vi.hoisted(() => ({ createClient: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: supabase.createClient }))

let queries: ReturnType<typeof fakeQuery>[]
let pending: Result[]
/** Every table or RPC touched, in order, prefixed by the client that touched it (`user:` or `service:`). */
let touched: string[]
let rpcs: [string, Record<string, unknown> | undefined][]

/** Queues the results the next queries (tables and RPCs alike) resolve to, in order. */
function respond(...results: Result[]) {
  pending.push(...results)
}

beforeEach(() => {
  vi.resetAllMocks()
  queries = []
  pending = []
  touched = []
  rpcs = []
  supabase.createClient.mockImplementation((_url: string, key: string) => {
    const kind = key === 'service-key' ? 'service' : 'user'
    const next = (label: string) => {
      touched.push(`${kind}:${label}`)
      const q = fakeQuery(pending.shift() ?? { data: [], error: null })
      queries.push(q)
      return q.query
    }
    return {
      from: (table: string) => next(table),
      rpc: (fn: string, args?: Record<string, unknown>) => {
        rpcs.push([fn, args])
        return next(`rpc ${fn}`)
      },
    }
  })
})

const CONFIG = { url: 'https://ref.supabase.co', publishableKey: 'sb_publishable_test' }
const SERVICE = { ...CONFIG, serviceRoleKey: 'service-key' }
const AGENCY_UUID = 'a1000000-0000-4000-8000-000000000001'
const AGENCY_SLUG = 'agency-a'
const NURSE_UUID = '7c1e0d52-0000-4000-8000-000000000001'
const NURSE_SLUG = 'nurse-1'
const SHIFT_UUID = 'e1000000-0000-4000-8000-0000000000aa'
const SHIFT_SLUG = 'shift-1'
const BRANCH_ID = 'b1000000-0000-4000-8000-000000000001'
const EVENT_ID = 'f1000000-0000-4000-8000-000000000001'

const base = { agencyIds: [] as string[], agencySlugs: [] as string[], agencyId: null, agencySlug: null }
const nurse: Viewer = { ...base, id: NURSE_UUID, slug: NURSE_SLUG, fullName: 'Ava', role: 'nurse', accessToken: 'jwt-nurse' }
const agency: Viewer = {
  id: NURSE_UUID,
  slug: 'agency-a-user',
  fullName: 'Riley',
  role: 'agency',
  agencyIds: [AGENCY_UUID],
  agencySlugs: [AGENCY_SLUG],
  agencyId: AGENCY_UUID,
  agencySlug: AGENCY_SLUG,
  accessToken: 'jwt',
}
const admin: Viewer = { ...base, id: NURSE_UUID, slug: 'admin-1', fullName: 'Morgan', role: 'admin', accessToken: 'jwt' }
const NO_AGENCY: Viewer = { ...agency, agencyIds: [], agencySlugs: [], agencyId: null, agencySlug: null }

/** One row of `list_shifts_marketplace`. 12:00Z in January is 07:00 in New York. */
const MARKET_ROW = {
  id: SHIFT_UUID,
  slug: SHIFT_SLUG,
  title: 'ICU RN',
  starts_at: '2030-01-10 12:00:00+00',
  ends_at: '2030-01-10 20:00:00+00',
  status: 'claimed',
  created_at: '2029-12-01 00:00:00+00',
  updated_at: '2029-12-02 00:00:00+00',
  branch_id: BRANCH_ID,
  branch_name: 'Downtown',
  branch_address: '120 Main',
  branch_timezone: 'America/New_York',
  branch_status: 'active',
  agency_id: AGENCY_UUID,
  agency_slug: AGENCY_SLUG,
  agency_name: 'Northwind',
  agency_status: 'active',
  assigned_nurse_id: NURSE_UUID,
  assigned_nurse_slug: NURSE_SLUG,
  assigned_nurse_name: 'Ava Thompson',
}

const SHIFT = {
  id: SHIFT_SLUG,
  agencyId: AGENCY_SLUG,
  agencyName: 'Northwind',
  role: 'ICU RN',
  date: '2030-01-10',
  startTime: '07:00',
  endTime: '15:00',
  status: 'filled',
  claimedBy: NURSE_SLUG,
  claimedByName: 'Ava Thompson',
  branch: { id: BRANCH_ID, name: 'Downtown', address: '120 Main', timezone: 'America/New_York', status: 'active' },
  startsAt: '2030-01-10T12:00:00.000Z',
  endsAt: '2030-01-10T20:00:00.000Z',
  createdAt: '2029-12-01T00:00:00.000Z',
  updatedAt: '2029-12-02T00:00:00.000Z',
}

const OPEN_ROW = { ...MARKET_ROW, status: 'open', assigned_nurse_id: null, assigned_nurse_slug: null, assigned_nurse_name: null }
const OPEN_SHIFT = { ...SHIFT, status: 'open', claimedBy: null, claimedByName: null }

const ok = (data: unknown): Result => ({ data, error: null })
const methods = (index = 0) => queries[index]!.calls.map(([name]) => name)
const call = (name: string, index = 0) => queries[index]!.calls.filter(([n]) => n === name).map((c) => c.slice(1))
const MARKET_ARGS = { p_agency_slug: null, p_shift_slug: null }

describe('createSupabaseDataStore', () => {
  it('reads with a request-scoped client carrying the caller JWT and the shiftpatch schema', async () => {
    const store = createSupabaseDataStore(CONFIG)
    await store.listShifts(admin, {})

    expect(supabase.createClient).toHaveBeenCalledWith(CONFIG.url, CONFIG.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: DB_SCHEMA },
      global: { headers: { Authorization: 'Bearer jwt' } },
    })
  })

  it('creates the service client only when a service-role key is configured', () => {
    createSupabaseDataStore(CONFIG)
    expect(supabase.createClient).not.toHaveBeenCalled()

    createSupabaseDataStore(SERVICE)
    expect(supabase.createClient).toHaveBeenCalledWith(CONFIG.url, 'service-key', expect.anything())
  })

  describe('getProfile', () => {
    const profileRow = (role: string, memberships: { agency_id: string; status: string; agency: { slug: string } | null }[]) =>
      ok({ id: NURSE_UUID, slug: role === 'nurse' ? NURSE_SLUG : 'agency-a-user', full_name: 'Riley', role, agency_memberships: memberships })

    it('returns null when no profile row is visible', async () => {
      respond(ok(null))
      await expect(createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_UUID)).resolves.toBeNull()
      expect(touched).toEqual(['user:profiles'])
      expect(call('eq')).toEqual([['id', NURSE_UUID]])
    })

    it('collects every active membership with its public id for agency users', async () => {
      respond(
        profileRow('agency', [
          { agency_id: 'a2000000-0000-4000-8000-000000000002', status: 'inactive', agency: { slug: 'agency-b' } },
          { agency_id: AGENCY_UUID, status: 'active', agency: { slug: AGENCY_SLUG } },
          { agency_id: 'a3000000-0000-4000-8000-000000000003', status: 'active', agency: { slug: 'agency-c' } },
        ]),
      )
      await expect(createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_UUID)).resolves.toEqual({
        id: NURSE_UUID,
        slug: 'agency-a-user',
        fullName: 'Riley',
        role: 'agency',
        agencyIds: [AGENCY_UUID, 'a3000000-0000-4000-8000-000000000003'],
        agencySlugs: [AGENCY_SLUG, 'agency-c'],
        agencyId: AGENCY_UUID,
        agencySlug: AGENCY_SLUG,
      })
    })

    it('returns a null agency for an agency user without an active membership', async () => {
      respond(profileRow('agency', [{ agency_id: AGENCY_UUID, status: 'inactive', agency: { slug: AGENCY_SLUG } }]))
      const profile = await createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_UUID)
      expect(profile).toMatchObject({ agencyId: null, agencySlug: null, agencyIds: [], agencySlugs: [] })
    })

    it('ignores memberships for non-agency roles', async () => {
      respond(profileRow('nurse', [{ agency_id: AGENCY_UUID, status: 'active', agency: { slug: AGENCY_SLUG } }]))
      const profile = await createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_UUID)
      expect(profile).toMatchObject({ slug: NURSE_SLUG, agencyId: null, agencySlugs: [] })
    })

    it('rejects an unexpected row shape', async () => {
      respond(profileRow('superuser', []))
      await expect(createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_UUID)).rejects.toThrow(
        new DataStoreError('profile lookup returned an unexpected shape'),
      )
    })

    it('reports only the step and PostgREST code on query errors', async () => {
      respond({ data: null, error: { code: '42501', message: 'secret detail' } as never })
      const error = await createSupabaseDataStore(CONFIG)
        .getProfile('jwt', NURSE_UUID)
        .catch((e: unknown) => e)
      expect(error).toEqual(new DataStoreError('profile lookup failed (42501)'))
    })

    it('omits the code when PostgREST gives none', async () => {
      respond({ data: null, error: {} })
      await expect(createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_UUID)).rejects.toThrow(
        new DataStoreError('profile lookup failed'),
      )
    })
  })

  describe('listShifts (the marketplace projection)', () => {
    it('reads every shift through list_shifts_marketplace as the caller and maps rows to the contract shape', async () => {
      respond(ok([MARKET_ROW, OPEN_ROW]))
      const shifts = await createSupabaseDataStore(CONFIG).listShifts(nurse, {})

      expect(shifts).toEqual([SHIFT, OPEN_SHIFT])
      expect(touched).toEqual(['user:rpc list_shifts_marketplace'])
      expect(rpcs).toEqual([['list_shifts_marketplace', MARKET_ARGS]])
      expect(call('order')).toEqual([['starts_at'], ['id']])
      expect(call('limit')).toEqual([[500]])
      expect(call('eq')).toEqual([])
      expect(call('in')).toEqual([])
    })

    it('derives date and times in the branch time zone', async () => {
      respond(ok([{ ...OPEN_ROW, branch_timezone: 'UTC', starts_at: '2026-10-02 19:00:00+00', ends_at: '2026-10-03 07:00:00+00' }]))
      const [shift] = await createSupabaseDataStore(CONFIG).listShifts(nurse, {})
      expect(shift).toMatchObject({ date: '2026-10-02', startTime: '19:00', endTime: '07:00' })
    })

    it('treats a null data payload as an empty list', async () => {
      respond(ok(null))
      await expect(createSupabaseDataStore(CONFIG).listShifts(admin, {})).resolves.toEqual([])
    })

    it('does not pin agency users: the marketplace spans every agency', async () => {
      await createSupabaseDataStore(CONFIG).listShifts(agency, {})
      expect(call('in')).toEqual([])
      expect(rpcs).toEqual([['list_shifts_marketplace', MARKET_ARGS]])
    })

    it('applies every optional filter, translating the contract status word', async () => {
      await createSupabaseDataStore(CONFIG).listShifts(admin, {
        status: 'filled',
        branchId: BRANCH_ID,
        agencyId: 'agency-b',
        from: '2030-01-01T00:00:00Z',
        to: '2030-02-01T00:00:00Z',
      })
      expect(rpcs).toEqual([['list_shifts_marketplace', { p_agency_slug: 'agency-b', p_shift_slug: null }]])
      expect(call('eq')).toEqual([
        ['status', 'claimed'],
        ['branch_id', BRANCH_ID],
      ])
      expect(call('gte')).toEqual([['starts_at', '2030-01-01T00:00:00Z']])
      expect(call('lt')).toEqual([['starts_at', '2030-02-01T00:00:00Z']])
    })

    it('rejects rows that do not match the expected shape', async () => {
      respond(ok([{ ...MARKET_ROW, status: 'unknown' }]))
      await expect(createSupabaseDataStore(CONFIG).listShifts(admin, {})).rejects.toThrow(
        new DataStoreError('list shifts returned an unexpected shape'),
      )
    })
  })

  describe('getShift', () => {
    it('looks one shift up by its public id', async () => {
      respond(ok(MARKET_ROW))
      await expect(createSupabaseDataStore(CONFIG).getShift(admin, SHIFT_SLUG)).resolves.toEqual(SHIFT)
      expect(rpcs).toEqual([['list_shifts_marketplace', { p_agency_slug: null, p_shift_slug: SHIFT_SLUG }]])
      expect(methods()).toContain('maybeSingle')
    })

    it('returns null when the shift does not exist', async () => {
      respond(ok(null))
      await expect(createSupabaseDataStore(CONFIG).getShift(admin, SHIFT_SLUG)).resolves.toBeNull()
    })
  })

  it('listAssignedShifts narrows the marketplace to the viewer as assigned nurse', async () => {
    respond(ok([MARKET_ROW]))
    await expect(createSupabaseDataStore(CONFIG).listAssignedShifts(nurse)).resolves.toEqual([SHIFT])
    expect(call('eq')).toEqual([['assigned_nurse_id', NURSE_UUID]])
  })

  describe('listShiftEvents', () => {
    const eventRow = {
      id: EVENT_ID,
      actor_id: NURSE_UUID,
      event_type: 'claimed',
      previous_status: 'open',
      new_status: 'claimed',
      reason: null,
      occurred_at: '2030-01-01 10:00:00+00',
      actor: { full_name: 'Ava Thompson' },
    }

    it('resolves the public id under RLS and maps events in chronological order with the contract status words', async () => {
      respond(ok({ id: SHIFT_UUID }), ok([eventRow, { ...eventRow, actor: null }]))
      const events = await createSupabaseDataStore(CONFIG).listShiftEvents(nurse, SHIFT_SLUG)

      const expected = {
        id: EVENT_ID,
        eventType: 'claimed',
        previousStatus: 'open',
        newStatus: 'filled',
        reason: null,
        occurredAt: '2030-01-01T10:00:00.000Z',
        actor: { id: NURSE_UUID, fullName: 'Ava Thompson' },
      }
      expect(events).toEqual([expected, { ...expected, actor: { id: NURSE_UUID, fullName: null } }])
      expect(touched).toEqual(['user:shifts', 'user:shift_events'])
      expect(call('eq', 0)).toEqual([['slug', SHIFT_SLUG]])
      expect(call('eq', 1)).toEqual([['shift_id', SHIFT_UUID]])
      expect(call('order', 1)).toEqual([['occurred_at'], ['id']])
    })

    it('returns no events for a shift the caller cannot read', async () => {
      respond(ok(null))
      await expect(createSupabaseDataStore(CONFIG).listShiftEvents(nurse, SHIFT_SLUG)).resolves.toEqual([])
      expect(touched).toEqual(['user:shifts'])
    })
  })

  describe('listBranches', () => {
    const row = {
      id: BRANCH_ID,
      name: 'Downtown',
      address: '120 Main',
      timezone: 'America/New_York',
      status: 'active' as const,
      agency: { id: AGENCY_UUID, slug: AGENCY_SLUG, name: 'Northwind' },
    }
    const branch = { ...row, agency: { id: AGENCY_SLUG, name: 'Northwind' } }

    it('lists every visible branch for admins with public agency ids', async () => {
      respond(ok([row]))
      await expect(createSupabaseDataStore(CONFIG).listBranches(admin)).resolves.toEqual([branch])
      expect(touched).toEqual(['user:agency_branches'])
      expect(call('eq')).toEqual([])
    })

    it('pins agency users to their agency', async () => {
      await createSupabaseDataStore(CONFIG).listBranches(agency)
      expect(call('in')).toEqual([['agency_id', [AGENCY_UUID]]])
    })

    it('pins an agency viewer without an agency to a uuid that matches nothing', async () => {
      await createSupabaseDataStore(CONFIG).listBranches(NO_AGENCY)
      expect(call('in')).toEqual([['agency_id', ['00000000-0000-0000-0000-000000000000']]])
    })
  })

  describe('workflow commands', () => {
    const COMMAND = { branchId: BRANCH_ID, title: 'ICU RN', startsAt: '2030-01-10T12:00:00Z', endsAt: '2030-01-10T20:00:00Z' }

    it('throws DataUnavailableError without a service-role key', async () => {
      const store = createSupabaseDataStore(CONFIG)
      await expect(store.createShift(NURSE_UUID, COMMAND)).rejects.toBeInstanceOf(DataUnavailableError)
      await expect(store.claimShift(NURSE_UUID, SHIFT_SLUG)).rejects.toBeInstanceOf(DataUnavailableError)
      await expect(store.cancelClaim(NURSE_UUID, SHIFT_SLUG, 'advance')).rejects.toBeInstanceOf(DataUnavailableError)
    })

    it('calls create_shift with the verified actor id and reports the new shift by its public id', async () => {
      respond(ok({ outcome: 'created', shift_id: SHIFT_UUID, event_id: EVENT_ID }), ok({ slug: SHIFT_SLUG }))
      await expect(createSupabaseDataStore(SERVICE).createShift(NURSE_UUID, COMMAND)).resolves.toEqual({
        outcome: 'created',
        shiftId: SHIFT_SLUG,
        eventId: EVENT_ID,
      })
      expect(rpcs).toEqual([
        ['create_shift', { p_actor_id: NURSE_UUID, p_branch_id: BRANCH_ID, p_title: 'ICU RN', p_starts_at: COMMAND.startsAt, p_ends_at: COMMAND.endsAt }],
      ])
      expect(touched).toEqual(['service:rpc create_shift', 'service:shifts'])
      expect(call('eq', 1)).toEqual([['id', SHIFT_UUID]])
    })

    it('resolves the public id before calling claim_shift and returns a typed outcome', async () => {
      respond(ok({ id: SHIFT_UUID }), ok({ outcome: 'shift_not_open', shift_id: SHIFT_UUID, event_id: null }))
      await expect(createSupabaseDataStore(SERVICE).claimShift(NURSE_UUID, SHIFT_SLUG)).resolves.toEqual({
        outcome: 'shift_not_open',
        shiftId: SHIFT_SLUG,
        eventId: null,
      })
      expect(touched).toEqual(['service:shifts', 'service:rpc claim_shift'])
      expect(call('eq', 0)).toEqual([['slug', SHIFT_SLUG]])
      expect(rpcs).toEqual([['claim_shift', { p_shift_id: SHIFT_UUID, p_nurse_id: NURSE_UUID }]])
    })

    it('answers shift_not_found for an unknown public id without calling the command', async () => {
      respond(ok(null))
      await expect(createSupabaseDataStore(SERVICE).claimShift(NURSE_UUID, 'shift-404')).resolves.toEqual({ outcome: 'shift_not_found', shiftId: null, eventId: null })
      expect(rpcs).toEqual([])
    })

    it('cancels a claim through cancel_shift_claim and reports who held the shift', async () => {
      respond(ok({ id: SHIFT_UUID }), ok({ outcome: 'cancelled', shift_id: SHIFT_UUID, event_id: EVENT_ID, previous_nurse_id: NURSE_UUID, previous_nurse_slug: NURSE_SLUG }))
      await expect(createSupabaseDataStore(SERVICE).cancelClaim(AGENCY_UUID, SHIFT_SLUG, 'no-show')).resolves.toEqual({
        outcome: 'cancelled',
        shiftId: SHIFT_SLUG,
        eventId: EVENT_ID,
        previousNurseId: NURSE_UUID,
        previousNurseSlug: NURSE_SLUG,
      })
      expect(rpcs).toEqual([['cancel_shift_claim', { p_actor_id: AGENCY_UUID, p_shift_id: SHIFT_UUID, p_reason: 'no-show' }]])
    })

    it('rejects an unexpected RPC result shape', async () => {
      respond(ok({ id: SHIFT_UUID }), ok({ outcome: 'claimed' }))
      await expect(createSupabaseDataStore(SERVICE).claimShift(NURSE_UUID, SHIFT_SLUG)).rejects.toThrow(
        new DataStoreError('claim_shift returned an unexpected shape'),
      )
    })

    it('maps an RPC error to DataStoreError', async () => {
      respond({ data: null, error: { code: 'P0001' } })
      await expect(createSupabaseDataStore(SERVICE).createShift(NURSE_UUID, COMMAND)).rejects.toThrow(
        new DataStoreError('create_shift failed (P0001)'),
      )
    })
  })
})

describe('agency administration', () => {
  const AGENCY_ROW = {
    id: AGENCY_UUID,
    slug: AGENCY_SLUG,
    name: 'Northwind',
    status: 'active',
    created_at: '2029-11-01 00:00:00+00',
    updated_at: '2029-11-02 00:00:00+00',
    agency_branches: [{ count: 2 }],
  }
  const AGENCY = {
    id: AGENCY_SLUG,
    name: 'Northwind',
    status: 'active',
    branchCount: 2,
    createdAt: '2029-11-01T00:00:00.000Z',
    updatedAt: '2029-11-02T00:00:00.000Z',
  }
  const BRANCH_ROW = {
    id: BRANCH_ID,
    name: 'Downtown',
    address: '120 Main',
    timezone: 'America/New_York',
    status: 'inactive',
    created_at: '2029-11-01 00:00:00+00',
    updated_at: '2029-11-02 00:00:00+00',
    agency: { id: AGENCY_UUID, slug: AGENCY_SLUG },
  }
  const BRANCH = {
    id: BRANCH_ID,
    agencyId: AGENCY_SLUG,
    name: 'Downtown',
    address: '120 Main',
    timezone: 'America/New_York',
    status: 'inactive',
    createdAt: '2029-11-01T00:00:00.000Z',
    updatedAt: '2029-11-02T00:00:00.000Z',
  }

  it('lists agencies by public id with their branch counts as the viewer', async () => {
    respond(ok([AGENCY_ROW]))
    await expect(createSupabaseDataStore(CONFIG).listAgencies(admin)).resolves.toEqual([AGENCY])
    expect(touched).toEqual(['user:agencies'])
    expect(call('select')).toEqual([['id, slug, name, status, created_at, updated_at, agency_branches (count)']])
  })

  it('reads one agency by public id with its branches, or null', async () => {
    respond(ok(AGENCY_ROW), ok([BRANCH_ROW]))
    await expect(createSupabaseDataStore(CONFIG).getAgency(admin, AGENCY_SLUG)).resolves.toEqual({ agency: AGENCY, branches: [BRANCH] })
    expect(touched).toEqual(['user:agencies', 'user:agency_branches'])
    expect(call('eq', 0)).toEqual([['slug', AGENCY_SLUG]])
    expect(call('eq', 1)).toEqual([['agency_id', AGENCY_UUID]])

    respond(ok(null))
    await expect(createSupabaseDataStore(CONFIG).getAgency(admin, AGENCY_SLUG)).resolves.toBeNull()
  })

  it('reads a branch only through its agency', async () => {
    respond(ok(BRANCH_ROW))
    await expect(createSupabaseDataStore(CONFIG).getAgencyBranch(admin, AGENCY_SLUG, BRANCH_ID)).resolves.toEqual(BRANCH)
    expect(call('eq')).toEqual([['id', BRANCH_ID], ['agency.slug', AGENCY_SLUG]])
  })

  it('resolves public ids for the admin commands, runs them as the service role and reports public ids back', async () => {
    const store = createSupabaseDataStore(SERVICE)
    respond(ok({ id: AGENCY_UUID }), ok({ outcome: 'updated', entity_id: AGENCY_UUID }))
    await expect(store.updateAgency(NURSE_UUID, AGENCY_SLUG, { status: 'inactive' })).resolves.toEqual({ outcome: 'updated', entityId: AGENCY_SLUG })
    expect(rpcs.at(-1)).toEqual(['update_agency', { p_actor_id: NURSE_UUID, p_agency_id: AGENCY_UUID, p_name: null, p_status: 'inactive' }])

    respond(ok({ outcome: 'created', entity_id: AGENCY_UUID }), ok({ slug: 'agency-3' }))
    await expect(store.createAgency(NURSE_UUID, { name: 'Summit' })).resolves.toEqual({ outcome: 'created', entityId: 'agency-3' })
    expect(rpcs.at(-1)).toEqual(['create_agency', { p_actor_id: NURSE_UUID, p_name: 'Summit' }])

    respond(ok({ id: AGENCY_UUID }), ok({ outcome: 'created', entity_id: BRANCH_ID }))
    await expect(store.createBranch(NURSE_UUID, AGENCY_SLUG, { name: 'Up', address: '1 Up', timezone: 'UTC' })).resolves.toEqual({ outcome: 'created', entityId: BRANCH_ID })
    expect(rpcs.at(-1)).toEqual(['create_branch', { p_actor_id: NURSE_UUID, p_agency_id: AGENCY_UUID, p_name: 'Up', p_address: '1 Up', p_timezone: 'UTC' }])

    respond(ok({ outcome: 'updated', entity_id: BRANCH_ID }))
    await store.updateBranch(NURSE_UUID, BRANCH_ID, { name: 'Renamed' })
    expect(rpcs.at(-1)).toEqual(['update_branch', { p_actor_id: NURSE_UUID, p_branch_id: BRANCH_ID, p_name: 'Renamed', p_address: null, p_timezone: null, p_status: null }])

    respond(ok({ id: AGENCY_UUID }), ok({ outcome: 'deleted', entity_id: AGENCY_UUID }))
    await expect(store.deleteAgency(NURSE_UUID, AGENCY_SLUG)).resolves.toEqual({ outcome: 'deleted', entityId: AGENCY_SLUG })
  })

  it('answers agency_not_found for an unknown public id without running the command', async () => {
    respond(ok(null))
    await expect(createSupabaseDataStore(SERVICE).updateAgency(NURSE_UUID, 'agency-404', { status: 'inactive' })).resolves.toEqual({ outcome: 'agency_not_found', entityId: null })
    expect(rpcs).toEqual([])
  })

  it('refuses admin commands without the service-role key', async () => {
    await expect(createSupabaseDataStore(CONFIG).createAgency(NURSE_UUID, { name: 'x' })).rejects.toBeInstanceOf(DataUnavailableError)
    expect(rpcs).toEqual([])
  })

  it('rejects an unexpected command shape', async () => {
    respond(ok({ outcome: 'created' }))
    await expect(createSupabaseDataStore(SERVICE).createAgency(NURSE_UUID, { name: 'x' })).rejects.toBeInstanceOf(DataStoreError)
  })
})

describe('user administration', () => {
  const USER_ROW = {
    id: NURSE_UUID,
    email: 'ava@example.test',
    full_name: 'Ava Thompson',
    role: 'nurse',
    invited_at: '2030-01-01 00:00:00+00',
    confirmed_at: null,
    last_sign_in_at: null,
  }
  const AGENCY_USER_UUID = 'c1000000-0000-4000-8000-000000000002'
  const AGENCY_REF = { id: AGENCY_UUID, slug: AGENCY_SLUG, name: 'Northwind' }

  it('assembles users (by public id) from the admin listing, profile slugs, active memberships and eligibility', async () => {
    respond(
      ok([USER_ROW, { ...USER_ROW, id: AGENCY_USER_UUID, role: 'agency', confirmed_at: '2030-01-02 00:00:00+00', last_sign_in_at: '2030-01-03 00:00:00+00' }]),
      ok([{ id: NURSE_UUID, slug: NURSE_SLUG }, { id: AGENCY_USER_UUID, slug: 'agency-a-user' }]),
      ok([{ profile_id: AGENCY_USER_UUID, agency: AGENCY_REF }]),
      ok([{ nurse_id: NURSE_UUID, status: 'active', branch: { id: BRANCH_ID, name: 'Downtown', agency: AGENCY_REF } }]),
    )

    const users = await createSupabaseDataStore(CONFIG).listUsers(admin)

    expect(touched).toEqual(['user:rpc list_users_admin', 'user:profiles', 'user:agency_memberships', 'user:branch_nurse_eligibility'])
    expect(call('eq', 2)).toEqual([['status', 'active']])
    expect(users).toEqual([
      {
        id: NURSE_SLUG,
        email: 'ava@example.test',
        fullName: 'Ava Thompson',
        role: 'nurse',
        status: 'invited',
        invitedAt: '2030-01-01T00:00:00.000Z',
        lastSignInAt: null,
        agencies: [],
        eligibleBranches: [{ id: BRANCH_ID, name: 'Downtown', agency: { id: AGENCY_SLUG, name: 'Northwind' }, status: 'active' }],
      },
      {
        id: 'agency-a-user',
        email: 'ava@example.test',
        fullName: 'Ava Thompson',
        role: 'agency',
        status: 'active',
        invitedAt: '2030-01-01T00:00:00.000Z',
        lastSignInAt: '2030-01-03T00:00:00.000Z',
        agencies: [{ id: AGENCY_SLUG, name: 'Northwind' }],
        eligibleBranches: [],
      },
    ])
    expect(JSON.stringify(users)).not.toContain(NURSE_UUID)
  })

  it('finds one user by public id or by Auth UUID, or null', async () => {
    const listing = () => respond(ok([USER_ROW]), ok([{ id: NURSE_UUID, slug: NURSE_SLUG }]), ok([]), ok([]))
    respond(ok({ id: NURSE_UUID, slug: NURSE_SLUG }))
    listing()
    await expect(createSupabaseDataStore(CONFIG).getUser(admin, NURSE_SLUG)).resolves.toMatchObject({ id: NURSE_SLUG })
    expect(call('or', 0)).toEqual([[`slug.eq.${NURSE_SLUG},id.eq.00000000-0000-0000-0000-000000000000`]])

    respond(ok({ id: NURSE_UUID, slug: NURSE_SLUG }))
    listing()
    await expect(createSupabaseDataStore(CONFIG).getUser(admin, NURSE_UUID)).resolves.toMatchObject({ id: NURSE_SLUG })

    respond(ok(null))
    await expect(createSupabaseDataStore(CONFIG).getUser(admin, 'nurse-404')).resolves.toBeNull()
  })

  it('provisions through the service role, translating agency public ids to UUIDs', async () => {
    const store = createSupabaseDataStore(SERVICE)
    respond(ok({ outcome: 'provisioned', entity_id: NURSE_UUID }))
    await expect(store.provisionUser(AGENCY_UUID, NURSE_UUID, { email: 'x@example.test', fullName: 'Nina', role: 'nurse', branchId: BRANCH_ID })).resolves.toEqual({ outcome: 'provisioned', entityId: NURSE_UUID })
    expect(rpcs.at(-1)).toEqual(['provision_user', { p_actor_id: AGENCY_UUID, p_user_id: NURSE_UUID, p_full_name: 'Nina', p_role: 'nurse', p_agency_ids: null, p_branch_id: BRANCH_ID }])

    respond(ok([{ id: AGENCY_UUID, slug: AGENCY_SLUG }]), ok({ outcome: 'provisioned', entity_id: NURSE_UUID }))
    await store.provisionUser(AGENCY_UUID, NURSE_UUID, { email: 'x@example.test', fullName: 'Pat', role: 'agency', agencyIds: [AGENCY_SLUG] })
    expect(rpcs.at(-1)).toEqual(['provision_user', { p_actor_id: AGENCY_UUID, p_user_id: NURSE_UUID, p_full_name: 'Pat', p_role: 'agency', p_agency_ids: [AGENCY_UUID], p_branch_id: null }])

    respond(ok({ outcome: 'provisioned', entity_id: NURSE_UUID }))
    await store.provisionUser(AGENCY_UUID, NURSE_UUID, { email: 'x@example.test', fullName: 'Sam', role: 'admin' })
    expect(rpcs.at(-1)).toEqual(['provision_user', { p_actor_id: AGENCY_UUID, p_user_id: NURSE_UUID, p_full_name: 'Sam', p_role: 'admin', p_agency_ids: null, p_branch_id: null }])
  })

  it('answers agency_not_found when an agency public id does not exist, without provisioning', async () => {
    respond(ok([]))
    await expect(createSupabaseDataStore(SERVICE).provisionUser(AGENCY_UUID, NURSE_UUID, { email: 'x@example.test', fullName: 'Pat', role: 'agency', agencyIds: ['agency-404'] })).resolves.toEqual({ outcome: 'agency_not_found', entityId: null })
    expect(rpcs).toEqual([])
  })

  it('deletes by public id and reports the Auth UUID the command removed', async () => {
    respond(ok({ id: NURSE_UUID }), ok({ outcome: 'deleted', entity_id: NURSE_UUID }))
    await expect(createSupabaseDataStore(SERVICE).deleteUser(AGENCY_UUID, NURSE_SLUG)).resolves.toEqual({ outcome: 'deleted', entityId: NURSE_UUID })
    expect(rpcs).toEqual([['delete_user', { p_actor_id: AGENCY_UUID, p_user_id: NURSE_UUID }]])
    respond(ok(null))
    await expect(createSupabaseDataStore(SERVICE).deleteUser(AGENCY_UUID, 'nurse-404')).resolves.toEqual({ outcome: 'user_not_found', entityId: null })
  })
})

describe('nurse eligibility', () => {
  const ROW = (nurseId: string, slug: string, fullName: string, branchId: string, branchName: string, status: string) => ({
    nurse_id: nurseId,
    status,
    activated_at: status === 'active' ? '2030-01-01 00:00:00+00' : null,
    nurse: { id: nurseId, slug, full_name: fullName },
    branch: { id: branchId, name: branchName, agency: { id: AGENCY_UUID, slug: AGENCY_SLUG, name: 'Northwind' } },
  })
  const BEN_UUID = 'c1000000-0000-4000-8000-000000000012'
  const AGENCY_REF = { id: AGENCY_SLUG, name: 'Northwind' }

  it('groups eligibility rows by nurse with public ids, pinned to the agency viewer agencies', async () => {
    respond(ok([ROW(NURSE_UUID, NURSE_SLUG, 'Ava', BRANCH_ID, 'Riverside', 'active'), ROW(NURSE_UUID, NURSE_SLUG, 'Ava', 'b1000000-0000-4000-8000-000000000002', 'Downtown', 'suspended'), ROW(BEN_UUID, 'nurse-2', 'Ben', BRANCH_ID, 'Riverside', 'pending')]))
    const nurses = await createSupabaseDataStore(CONFIG).listAgencyNurses(agency)
    expect(touched).toEqual(['user:branch_nurse_eligibility'])
    expect(call('in')).toEqual([['branch.agency_id', [AGENCY_UUID]]])
    expect(nurses).toEqual([
      {
        nurse: { id: NURSE_SLUG, fullName: 'Ava' },
        branches: [
          { branch: { id: 'b1000000-0000-4000-8000-000000000002', name: 'Downtown', agency: AGENCY_REF }, status: 'suspended', activatedAt: null },
          { branch: { id: BRANCH_ID, name: 'Riverside', agency: AGENCY_REF }, status: 'active', activatedAt: '2030-01-01T00:00:00.000Z' },
        ],
      },
      {
        nurse: { id: 'nurse-2', fullName: 'Ben' },
        branches: [{ branch: { id: BRANCH_ID, name: 'Riverside', agency: AGENCY_REF }, status: 'pending', activatedAt: null }],
      },
    ])
  })

  it('does not pin admins', async () => {
    respond(ok([]))
    await createSupabaseDataStore(CONFIG).listAgencyNurses(admin)
    expect(call('in')).toEqual([])
  })

  it('reads one eligibility row by the nurse public id, or null', async () => {
    respond(ok({ branch_id: BRANCH_ID, status: 'active', activated_at: '2030-01-01 00:00:00+00', nurse: { slug: NURSE_SLUG } }))
    await expect(createSupabaseDataStore(CONFIG).getEligibility(agency, NURSE_SLUG, BRANCH_ID)).resolves.toEqual({ nurseId: NURSE_SLUG, branchId: BRANCH_ID, status: 'active', activatedAt: '2030-01-01T00:00:00.000Z' })
    expect(call('eq')).toEqual([['nurse.slug', NURSE_SLUG], ['branch_id', BRANCH_ID]])
    respond(ok(null))
    await expect(createSupabaseDataStore(CONFIG).getEligibility(agency, NURSE_SLUG, BRANCH_ID)).resolves.toBeNull()
  })

  it('sets eligibility through the service role after resolving the nurse public id', async () => {
    respond(ok({ id: NURSE_UUID }), ok({ outcome: 'updated', entity_id: 'f1000000-0000-4000-8000-000000000001' }))
    await expect(createSupabaseDataStore(SERVICE).setBranchEligibility(AGENCY_UUID, NURSE_SLUG, BRANCH_ID, 'suspended')).resolves.toEqual({ outcome: 'updated', entityId: 'f1000000-0000-4000-8000-000000000001' })
    expect(rpcs).toEqual([['set_branch_eligibility', { p_actor_id: AGENCY_UUID, p_nurse_id: NURSE_UUID, p_branch_id: BRANCH_ID, p_status: 'suspended' }]])
    respond(ok(null))
    await expect(createSupabaseDataStore(SERVICE).setBranchEligibility(AGENCY_UUID, 'nurse-404', BRANCH_ID, 'active')).resolves.toEqual({ outcome: 'nurse_not_found', entityId: null })
  })
})
