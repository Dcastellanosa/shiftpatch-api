import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataStoreError, DataUnavailableError } from '../../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../../domain/identity/identity.js'
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
let tables: string[]
const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<Result>>()

/** Queues the results the next `.from()` queries resolve to, in order. */
function respond(...results: Result[]) {
  pending.push(...results)
}

beforeEach(() => {
  vi.resetAllMocks()
  queries = []
  pending = []
  tables = []
  supabase.createClient.mockImplementation(() => ({
    from(table: string) {
      tables.push(table)
      const next = fakeQuery(pending.shift() ?? { data: [], error: null })
      queries.push(next)
      return next.query
    },
    rpc,
  }))
})

const CONFIG = { url: 'https://ref.supabase.co', publishableKey: 'sb_publishable_test' }
const AGENCY_ID = 'a1000000-0000-4000-8000-000000000001'
const NURSE_ID = '7c1e0d52-0000-4000-8000-000000000001'
const SHIFT_ID = 'e1000000-0000-4000-8000-0000000000aa'
const BRANCH_ID = 'b1000000-0000-4000-8000-000000000001'
const EVENT_ID = 'f1000000-0000-4000-8000-000000000001'

const nurse: Viewer = { id: NURSE_ID, fullName: 'Ava', role: 'nurse', agencyId: null, accessToken: 'jwt-nurse' }
const agency: Viewer = { id: NURSE_ID, fullName: 'Riley', role: 'agency', agencyId: AGENCY_ID, accessToken: 'jwt' }
const admin: Viewer = { id: NURSE_ID, fullName: 'Morgan', role: 'admin', agencyId: null, accessToken: 'jwt' }

const SHIFT_ROW = {
  id: SHIFT_ID,
  title: 'ICU RN',
  starts_at: '2030-01-10 12:00:00+00',
  ends_at: '2030-01-10 20:00:00+00',
  status: 'claimed',
  created_at: '2029-12-01 00:00:00+00',
  updated_at: '2029-12-02 00:00:00+00',
  branch: {
    id: BRANCH_ID,
    name: 'Downtown',
    address: '120 Main',
    timezone: 'America/New_York',
    agency: { id: AGENCY_ID, name: 'Northwind' },
  },
  assigned_nurse: { id: NURSE_ID, full_name: 'Ava Thompson' },
}

const SHIFT = {
  id: SHIFT_ID,
  title: 'ICU RN',
  startsAt: '2030-01-10T12:00:00.000Z',
  endsAt: '2030-01-10T20:00:00.000Z',
  status: 'claimed',
  branch: { id: BRANCH_ID, name: 'Downtown', address: '120 Main', timezone: 'America/New_York' },
  agency: { id: AGENCY_ID, name: 'Northwind' },
  assignedNurse: { id: NURSE_ID, fullName: 'Ava Thompson' },
  createdAt: '2029-12-01T00:00:00.000Z',
  updatedAt: '2029-12-02T00:00:00.000Z',
}

const ok = (data: unknown): Result => ({ data, error: null })
const methods = (index = 0) => queries[index]!.calls.map(([name]) => name)
const call = (name: string, index = 0) => queries[index]!.calls.filter(([n]) => n === name).map((c) => c.slice(1))

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

    createSupabaseDataStore({ ...CONFIG, serviceRoleKey: 'service-key' })
    expect(supabase.createClient).toHaveBeenCalledWith(CONFIG.url, 'service-key', expect.anything())
  })

  describe('getProfile', () => {
    const profileRow = (role: string, memberships: { agency_id: string; status: string }[]) =>
      ok({ id: NURSE_ID, full_name: 'Riley', role, agency_memberships: memberships })

    it('returns null when no profile row is visible', async () => {
      respond(ok(null))
      await expect(createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_ID)).resolves.toBeNull()
      expect(tables).toEqual(['profiles'])
      expect(call('eq')).toEqual([['id', NURSE_ID]])
    })

    it('uses the active membership agency for agency users', async () => {
      respond(
        profileRow('agency', [
          { agency_id: 'a2000000-0000-4000-8000-000000000002', status: 'inactive' },
          { agency_id: AGENCY_ID, status: 'active' },
        ]),
      )
      await expect(createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_ID)).resolves.toEqual({
        id: NURSE_ID,
        fullName: 'Riley',
        role: 'agency',
        agencyId: AGENCY_ID,
      })
    })

    it('returns a null agency for an agency user without an active membership', async () => {
      respond(profileRow('agency', [{ agency_id: AGENCY_ID, status: 'inactive' }]))
      const profile = await createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_ID)
      expect(profile?.agencyId).toBeNull()
    })

    it('ignores memberships for non-agency roles', async () => {
      respond(profileRow('nurse', [{ agency_id: AGENCY_ID, status: 'active' }]))
      const profile = await createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_ID)
      expect(profile?.agencyId).toBeNull()
    })

    it('rejects an unexpected row shape', async () => {
      respond(profileRow('superuser', []))
      await expect(createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_ID)).rejects.toThrow(
        new DataStoreError('profile lookup returned an unexpected shape'),
      )
    })

    it('reports only the step and PostgREST code on query errors', async () => {
      respond({ data: null, error: { code: '42501', message: 'secret detail' } as never })
      const error = await createSupabaseDataStore(CONFIG)
        .getProfile('jwt', NURSE_ID)
        .catch((e: unknown) => e)
      expect(error).toEqual(new DataStoreError('profile lookup failed (42501)'))
    })

    it('omits the code when PostgREST gives none', async () => {
      respond({ data: null, error: {} })
      await expect(createSupabaseDataStore(CONFIG).getProfile('jwt', NURSE_ID)).rejects.toThrow(
        new DataStoreError('profile lookup failed'),
      )
    })
  })

  describe('listShifts', () => {
    it('maps rows to ISO-normalised shifts ordered by start time', async () => {
      respond(ok([SHIFT_ROW, { ...SHIFT_ROW, assigned_nurse: null, status: 'open' }]))
      const shifts = await createSupabaseDataStore(CONFIG).listShifts(admin, {})

      expect(shifts).toEqual([SHIFT, { ...SHIFT, status: 'open', assignedNurse: null }])
      expect(tables).toEqual(['shifts'])
      expect(call('order')).toEqual([['starts_at'], ['id']])
      expect(call('limit')).toEqual([[500]])
      expect(call('eq')).toEqual([])
    })

    it('treats a null data payload as an empty list', async () => {
      respond(ok(null))
      await expect(createSupabaseDataStore(CONFIG).listShifts(admin, {})).resolves.toEqual([])
    })

    it('pins agency users to their own agency', async () => {
      await createSupabaseDataStore(CONFIG).listShifts(agency, {})
      expect(call('eq')).toEqual([['branch.agency_id', AGENCY_ID]])
    })

    it('pins an agency viewer without an agency to a uuid that matches nothing', async () => {
      await createSupabaseDataStore(CONFIG).listShifts({ ...agency, agencyId: null }, {})
      expect(call('eq')).toEqual([['branch.agency_id', '00000000-0000-0000-0000-000000000000']])
    })

    it('shows nurses only open shifts that have not started', async () => {
      await createSupabaseDataStore(CONFIG).listShifts(nurse, {})
      expect(call('eq')).toEqual([['status', 'open']])
      expect(call('gt')).toEqual([['starts_at', expect.any(String)]])
      expect(methods()).not.toContain('or')
    })

    it('adds the nurse own assigned shifts when includeAssigned is set', async () => {
      await createSupabaseDataStore(CONFIG).listShifts(nurse, { includeAssigned: true })
      const [[filter]] = call('or') as [[string]]
      expect(filter).toMatch(/^and\(status\.eq\.open,starts_at\.gt\."[^"]+"\),assigned_nurse_id\.eq\./)
      expect(filter).toContain(NURSE_ID)
    })

    it('applies every optional filter', async () => {
      await createSupabaseDataStore(CONFIG).listShifts(admin, {
        status: 'claimed',
        branchId: BRANCH_ID,
        from: '2030-01-01T00:00:00Z',
        to: '2030-02-01T00:00:00Z',
      })
      expect(call('eq')).toEqual([
        ['status', 'claimed'],
        ['branch_id', BRANCH_ID],
      ])
      expect(call('gte')).toEqual([['starts_at', '2030-01-01T00:00:00Z']])
      expect(call('lt')).toEqual([['starts_at', '2030-02-01T00:00:00Z']])
    })

    it('rejects rows that do not match the expected shape', async () => {
      respond(ok([{ ...SHIFT_ROW, status: 'unknown' }]))
      await expect(createSupabaseDataStore(CONFIG).listShifts(admin, {})).rejects.toThrow(
        new DataStoreError('list shifts returned an unexpected shape'),
      )
    })
  })

  describe('getShift', () => {
    it('returns the mapped shift', async () => {
      respond(ok(SHIFT_ROW))
      await expect(createSupabaseDataStore(CONFIG).getShift(admin, SHIFT_ID)).resolves.toEqual(SHIFT)
      expect(call('eq')).toEqual([['id', SHIFT_ID]])
      expect(methods()).toContain('maybeSingle')
    })

    it('returns null when the shift is not visible', async () => {
      respond(ok(null))
      await expect(createSupabaseDataStore(CONFIG).getShift(admin, SHIFT_ID)).resolves.toBeNull()
    })
  })

  it('listAssignedShifts filters by the viewer as assigned nurse', async () => {
    respond(ok([SHIFT_ROW]))
    await expect(createSupabaseDataStore(CONFIG).listAssignedShifts(nurse)).resolves.toEqual([SHIFT])
    expect(call('eq')).toEqual([['assigned_nurse_id', NURSE_ID]])
  })

  describe('listShiftEvents', () => {
    const eventRow = {
      id: EVENT_ID,
      actor_id: NURSE_ID,
      event_type: 'claimed',
      previous_status: 'open',
      new_status: 'claimed',
      reason: null,
      occurred_at: '2030-01-01 10:00:00+00',
      actor: { full_name: 'Ava Thompson' },
    }

    it('maps events in chronological order', async () => {
      respond(ok([eventRow, { ...eventRow, actor: null }]))
      const events = await createSupabaseDataStore(CONFIG).listShiftEvents(nurse, SHIFT_ID)

      const expected = {
        id: EVENT_ID,
        eventType: 'claimed',
        previousStatus: 'open',
        newStatus: 'claimed',
        reason: null,
        occurredAt: '2030-01-01T10:00:00.000Z',
        actor: { id: NURSE_ID, fullName: 'Ava Thompson' },
      }
      expect(events).toEqual([expected, { ...expected, actor: { id: NURSE_ID, fullName: null } }])
      expect(tables).toEqual(['shift_events'])
      expect(call('eq')).toEqual([['shift_id', SHIFT_ID]])
      expect(call('order')).toEqual([['occurred_at'], ['id']])
    })
  })

  describe('listBranches', () => {
    const branch = {
      id: BRANCH_ID,
      name: 'Downtown',
      address: '120 Main',
      timezone: 'America/New_York',
      agency: { id: AGENCY_ID, name: 'Northwind' },
    }

    it('lists every visible branch for admins', async () => {
      respond(ok([branch]))
      await expect(createSupabaseDataStore(CONFIG).listBranches(admin)).resolves.toEqual([branch])
      expect(tables).toEqual(['agency_branches'])
      expect(call('eq')).toEqual([])
    })

    it('pins agency users to their agency', async () => {
      await createSupabaseDataStore(CONFIG).listBranches(agency)
      expect(call('eq')).toEqual([['agency_id', AGENCY_ID]])
    })

    it('pins an agency viewer without an agency to a uuid that matches nothing', async () => {
      await createSupabaseDataStore(CONFIG).listBranches({ ...agency, agencyId: null })
      expect(call('eq')).toEqual([['agency_id', '00000000-0000-0000-0000-000000000000']])
    })
  })

  describe('workflow commands', () => {
    const withService = () => createSupabaseDataStore({ ...CONFIG, serviceRoleKey: 'service-key' })
    const INPUT = {
      branchId: BRANCH_ID,
      title: 'ICU RN',
      startsAt: '2030-01-10T12:00:00Z',
      endsAt: '2030-01-10T20:00:00Z',
    }

    it('throws DataUnavailableError without a service-role key', async () => {
      const store = createSupabaseDataStore(CONFIG)
      await expect(store.createShift(NURSE_ID, INPUT)).rejects.toBeInstanceOf(DataUnavailableError)
      await expect(store.claimShift(NURSE_ID, SHIFT_ID)).rejects.toBeInstanceOf(DataUnavailableError)
    })

    it('calls create_shift with the verified actor id', async () => {
      rpc.mockResolvedValue(ok({ outcome: 'created', shift_id: SHIFT_ID, event_id: EVENT_ID }))
      await expect(withService().createShift(NURSE_ID, INPUT)).resolves.toEqual({
        outcome: 'created',
        shiftId: SHIFT_ID,
        eventId: EVENT_ID,
      })
      expect(rpc).toHaveBeenCalledWith('create_shift', {
        p_actor_id: NURSE_ID,
        p_branch_id: BRANCH_ID,
        p_title: 'ICU RN',
        p_starts_at: INPUT.startsAt,
        p_ends_at: INPUT.endsAt,
      })
    })

    it('calls claim_shift and returns a typed failure outcome', async () => {
      rpc.mockResolvedValue(ok({ outcome: 'shift_not_open', shift_id: null, event_id: null }))
      await expect(withService().claimShift(NURSE_ID, SHIFT_ID)).resolves.toEqual({
        outcome: 'shift_not_open',
        shiftId: null,
        eventId: null,
      })
      expect(rpc).toHaveBeenCalledWith('claim_shift', { p_shift_id: SHIFT_ID, p_nurse_id: NURSE_ID })
    })

    it('rejects an unexpected RPC result shape', async () => {
      rpc.mockResolvedValue(ok({ outcome: 'claimed' }))
      await expect(withService().claimShift(NURSE_ID, SHIFT_ID)).rejects.toThrow(
        new DataStoreError('claim_shift returned an unexpected shape'),
      )
    })

    it('maps an RPC error to DataStoreError', async () => {
      rpc.mockResolvedValue({ data: null, error: { code: 'P0001' } })
      await expect(withService().createShift(NURSE_ID, INPUT)).rejects.toThrow(
        new DataStoreError('create_shift failed (P0001)'),
      )
    })
  })
})
