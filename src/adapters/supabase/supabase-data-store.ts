import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  DataStoreError,
  DataUnavailableError,
  type CommandResult,
  type DataStore,
} from '../../application/ports/data-store.js'
import type { Viewer } from '../../domain/identity.js'
import {
  APP_ROLES,
  SHIFT_EVENT_TYPES,
  SHIFT_STATUSES,
  type ClaimOutcome,
  type CreateOutcome,
  type Shift,
  type ShiftEvent,
} from '../../domain/shift.js'

interface SupabaseDataConfig {
  url: string
  publishableKey: string
  /** Server-only. Without it, reads work but shift commands return 503. */
  serviceRoleKey?: string
}

/** Postgres schema holding the staffing tables and functions (exposed through PostgREST). */
export const DB_SCHEMA = 'shiftpatch'

const CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: DB_SCHEMA },
} as const

const LIST_LIMIT = 500
// Matches nothing; used if an agency viewer somehow has no agency.
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

// PostgREST embeds. `!inner` drops a shift whose branch or agency the caller
// cannot see under RLS instead of returning it half-populated.
const SHIFT_COLUMNS = `
  id, title, starts_at, ends_at, status, created_at, updated_at,
  branch:agency_branches!inner (id, name, address, timezone, agency_id, agency:agencies!inner (id, name)),
  assigned_nurse:profiles!shifts_assigned_nurse_id_fkey (id, full_name)
`

const appRoleSchema = z.enum(APP_ROLES)
const shiftStatusSchema = z.enum(SHIFT_STATUSES)
const shiftEventTypeSchema = z.enum(SHIFT_EVENT_TYPES)

const shiftRow = z.object({
  id: z.uuid(),
  title: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  status: shiftStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  branch: z.object({
    id: z.uuid(),
    name: z.string(),
    address: z.string(),
    timezone: z.string(),
    agency: z.object({ id: z.uuid(), name: z.string() }),
  }),
  assigned_nurse: z.object({ id: z.uuid(), full_name: z.string() }).nullable(),
})

const eventRow = z.object({
  id: z.uuid(),
  actor_id: z.uuid(),
  event_type: shiftEventTypeSchema,
  previous_status: shiftStatusSchema.nullable(),
  new_status: shiftStatusSchema,
  reason: z.string().nullable(),
  occurred_at: z.string(),
  actor: z.object({ full_name: z.string() }).nullable(),
})

const branchRow = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  agency: z.object({ id: z.uuid(), name: z.string() }),
})

const profileRow = z.object({
  id: z.uuid(),
  full_name: z.string(),
  role: appRoleSchema,
  agency_memberships: z.array(z.object({ agency_id: z.uuid(), status: z.string() })),
})

const commandRow = z.object({
  outcome: z.string(),
  shift_id: z.uuid().nullable(),
  event_id: z.uuid().nullable(),
})

const iso = (value: string) => new Date(value).toISOString()

function toShift(row: z.infer<typeof shiftRow>): Shift {
  return {
    id: row.id,
    title: row.title,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    status: row.status,
    branch: { id: row.branch.id, name: row.branch.name, address: row.branch.address, timezone: row.branch.timezone },
    agency: { id: row.branch.agency.id, name: row.branch.agency.name },
    assignedNurse: row.assigned_nurse ? { id: row.assigned_nurse.id, fullName: row.assigned_nurse.full_name } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function toEvent(row: z.infer<typeof eventRow>): ShiftEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    reason: row.reason,
    occurredAt: iso(row.occurred_at),
    actor: { id: row.actor_id, fullName: row.actor?.full_name ?? null },
  }
}

/**
 * Unwraps a Supabase response. Only the step name and PostgREST error code are
 * kept; the raw error (which can echo query values) is never propagated.
 */
function unwrap<T>(result: { data: T | null; error: { code?: string } | null }, step: string): T {
  if (result.error) {
    throw new DataStoreError(`${step} failed${result.error.code ? ` (${result.error.code})` : ''}`)
  }
  return result.data as T
}

function parseRows<S extends z.ZodType>(schema: S, rows: unknown, step: string): z.infer<S>[] {
  const parsed = z.array(schema).safeParse(rows ?? [])
  if (!parsed.success) throw new DataStoreError(`${step} returned an unexpected shape`)
  return parsed.data
}

/** PostgREST `or=` values containing reserved characters must be quoted. */
const quoted = (value: string) => `"${value}"`

export function createSupabaseDataStore(config: SupabaseDataConfig): DataStore {
  // Request-scoped client carrying the caller's JWT: queries run as the
  // `authenticated` role, so Row Level Security applies to every read.
  const asUser = (accessToken: string) =>
    createClient(config.url, config.publishableKey, {
      ...CLIENT_OPTIONS,
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })

  // Used only for the two workflow RPCs, which client roles cannot execute.
  const serviceClient = config.serviceRoleKey
    ? createClient(config.url, config.serviceRoleKey, CLIENT_OPTIONS)
    : null

  async function runCommand<Outcome extends string>(
    fn: 'create_shift' | 'claim_shift',
    args: Record<string, unknown>,
  ): Promise<CommandResult<Outcome>> {
    if (!serviceClient) throw new DataUnavailableError()
    const data = unwrap(await serviceClient.rpc(fn, args), fn)
    const parsed = commandRow.safeParse(data)
    if (!parsed.success) throw new DataStoreError(`${fn} returned an unexpected shape`)
    return {
      outcome: parsed.data.outcome as Outcome,
      shiftId: parsed.data.shift_id,
      eventId: parsed.data.event_id,
    }
  }

  function shiftQuery(viewer: Viewer) {
    let query = asUser(viewer.accessToken).from('shifts').select(SHIFT_COLUMNS)
    // Defense in depth on top of RLS: agency users are pinned to their agency.
    if (viewer.role === 'agency') query = query.eq('branch.agency_id', viewer.agencyId ?? NIL_UUID)
    return query
  }

  return {
    async getProfile(accessToken, userId) {
      const data = unwrap(
        await asUser(accessToken)
          .from('profiles')
          .select('id, full_name, role, agency_memberships (agency_id, status)')
          .eq('id', userId)
          .maybeSingle(),
        'profile lookup',
      )
      if (!data) return null
      const [row] = parseRows(profileRow, [data], 'profile lookup')
      const active = row!.agency_memberships.find((m) => m.status === 'active')
      return {
        id: row!.id,
        fullName: row!.full_name,
        role: row!.role,
        agencyId: row!.role === 'agency' ? (active?.agency_id ?? null) : null,
      }
    },

    async listShifts(viewer, filters) {
      let query = shiftQuery(viewer)
      if (viewer.role === 'nurse') {
        const now = new Date().toISOString()
        query = filters.includeAssigned
          ? query.or(`and(status.eq.open,starts_at.gt.${quoted(now)}),assigned_nurse_id.eq.${viewer.id}`)
          : query.eq('status', 'open').gt('starts_at', now)
      }
      if (filters.status) query = query.eq('status', filters.status)
      if (filters.branchId) query = query.eq('branch_id', filters.branchId)
      if (filters.from) query = query.gte('starts_at', filters.from)
      if (filters.to) query = query.lt('starts_at', filters.to)
      const rows = unwrap(await query.order('starts_at').order('id').limit(LIST_LIMIT), 'list shifts')
      return parseRows(shiftRow, rows, 'list shifts').map(toShift)
    },

    async getShift(viewer, shiftId) {
      const row = unwrap(await shiftQuery(viewer).eq('id', shiftId).maybeSingle(), 'get shift')
      return row ? toShift(parseRows(shiftRow, [row], 'get shift')[0]!) : null
    },

    async listAssignedShifts(viewer) {
      const rows = unwrap(
        await shiftQuery(viewer)
          .eq('assigned_nurse_id', viewer.id)
          .order('starts_at')
          .limit(LIST_LIMIT),
        'list assigned shifts',
      )
      return parseRows(shiftRow, rows, 'list assigned shifts').map(toShift)
    },

    async listShiftEvents(viewer, shiftId) {
      const rows = unwrap(
        await asUser(viewer.accessToken)
          .from('shift_events')
          .select(
            'id, actor_id, event_type, previous_status, new_status, reason, occurred_at, actor:profiles!shift_events_actor_id_fkey (full_name)',
          )
          .eq('shift_id', shiftId)
          .order('occurred_at')
          .order('id'),
        'list shift events',
      )
      return parseRows(eventRow, rows, 'list shift events').map(toEvent)
    },

    async listBranches(viewer) {
      let query = asUser(viewer.accessToken)
        .from('agency_branches')
        .select('id, name, address, timezone, agency:agencies!inner (id, name)')
      if (viewer.role === 'agency') query = query.eq('agency_id', viewer.agencyId ?? NIL_UUID)
      const rows = unwrap(await query.order('name').limit(LIST_LIMIT), 'list branches')
      return parseRows(branchRow, rows, 'list branches')
    },

    createShift(actorId, input) {
      return runCommand<CreateOutcome>('create_shift', {
        p_actor_id: actorId,
        p_branch_id: input.branchId,
        p_title: input.title,
        p_starts_at: input.startsAt,
        p_ends_at: input.endsAt,
      })
    },

    claimShift(nurseId, shiftId) {
      return runCommand<ClaimOutcome>('claim_shift', { p_shift_id: shiftId, p_nurse_id: nurseId })
    },
  }
}
