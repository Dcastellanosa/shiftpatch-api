import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  DataStoreError,
  DataUnavailableError,
  type DataStore,
} from '../../../domain/ports/data-store/data-store.js'
import { ELIGIBILITY_STATUSES, type AdminUser, type EligibilityRecord, type NurseEligibility } from '../../../domain/admin/admin.js'
import {
  ENTITY_STATUSES,
  type Agency,
  type AgencyBranch,
  type AgencyDetail,
} from '../../../domain/agency/agency.js'
import type {
  AdminCommandResult,
  ClaimOutcome,
  CommandResult,
  CreateAgencyOutcome,
  CreateBranchOutcome,
  CreateOutcome,
  ProvisionOutcome,
  SetEligibilityOutcome,
  UpdateAgencyOutcome,
  UpdateBranchOutcome,
} from '../../../domain/outcomes/outcomes.js'
import type { Viewer } from '../../../domain/viewer/viewer.js'
import {
  APP_ROLES,
  SHIFT_EVENT_TYPES,
  SHIFT_STATUSES,
  type Shift,
  type ShiftEvent,
} from '../../../domain/shift/shift.js'

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

/** Agencies an agency viewer is pinned to (defense in depth on top of RLS). */
const agencyScope = (viewer: Viewer) => (viewer.agencyIds.length > 0 ? viewer.agencyIds : [NIL_UUID])

// PostgREST embeds. `!inner` drops a shift whose branch or agency the caller
// cannot see under RLS instead of returning it half-populated.
const SHIFT_COLUMNS = `
  id, title, starts_at, ends_at, status, created_at, updated_at,
  branch:agency_branches!inner (id, name, address, timezone, status, agency_id, agency:agencies!inner (id, name)),
  assigned_nurse:profiles!shifts_assigned_nurse_id_fkey (id, full_name)
`

const appRoleSchema = z.enum(APP_ROLES)
const shiftStatusSchema = z.enum(SHIFT_STATUSES)
const shiftEventTypeSchema = z.enum(SHIFT_EVENT_TYPES)
const entityStatusSchema = z.enum(ENTITY_STATUSES)

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
    status: entityStatusSchema,
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
  status: entityStatusSchema,
  agency: z.object({ id: z.uuid(), name: z.string() }),
})

const agencyRow = z.object({
  id: z.uuid(),
  name: z.string(),
  status: entityStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  agency_branches: z.array(z.object({ count: z.number() })),
})

const agencyBranchRow = z.object({
  id: z.uuid(),
  agency_id: z.uuid(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  status: entityStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
})

const adminUserRow = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  full_name: z.string(),
  role: appRoleSchema,
  invited_at: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  last_sign_in_at: z.string().nullable(),
})

const membershipRow = z.object({
  profile_id: z.uuid(),
  agency: z.object({ id: z.uuid(), name: z.string() }),
})

const eligibilityRow = z.object({
  nurse_id: z.uuid(),
  status: z.enum(ELIGIBILITY_STATUSES),
  branch: z.object({ id: z.uuid(), name: z.string(), agency: z.object({ id: z.uuid(), name: z.string() }) }),
})

const nurseEligibilityRow = z.object({
  nurse_id: z.uuid(),
  status: z.enum(ELIGIBILITY_STATUSES),
  activated_at: z.string().nullable(),
  nurse: z.object({ id: z.uuid(), full_name: z.string() }),
  branch: z.object({ id: z.uuid(), name: z.string(), agency: z.object({ id: z.uuid(), name: z.string() }) }),
})

const eligibilityRecordRow = z.object({
  nurse_id: z.uuid(),
  branch_id: z.uuid(),
  status: z.enum(ELIGIBILITY_STATUSES),
  activated_at: z.string().nullable(),
})

const NURSE_ELIGIBILITY_COLUMNS = `
  nurse_id, status, activated_at,
  nurse:profiles!branch_nurse_eligibility_nurse_id_fkey!inner (id, full_name),
  branch:agency_branches!inner (id, name, agency_id, agency:agencies!inner (id, name))
`

const AGENCY_COLUMNS = 'id, name, status, created_at, updated_at, agency_branches (count)'
const AGENCY_BRANCH_COLUMNS = 'id, agency_id, name, address, timezone, status, created_at, updated_at'

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

const adminCommandRow = z.object({
  outcome: z.string(),
  entity_id: z.uuid().nullable(),
})

const iso = (value: string) => new Date(value).toISOString()

function toShift(row: z.infer<typeof shiftRow>): Shift {
  return {
    id: row.id,
    title: row.title,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    status: row.status,
    branch: {
      id: row.branch.id,
      name: row.branch.name,
      address: row.branch.address,
      timezone: row.branch.timezone,
      status: row.branch.status,
    },
    agency: { id: row.branch.agency.id, name: row.branch.agency.name },
    assignedNurse: row.assigned_nurse ? { id: row.assigned_nurse.id, fullName: row.assigned_nurse.full_name } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function toAgency(row: z.infer<typeof agencyRow>): Agency {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    branchCount: row.agency_branches[0]?.count ?? 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function toAgencyBranch(row: z.infer<typeof agencyBranchRow>): AgencyBranch {
  return {
    id: row.id,
    agencyId: row.agency_id,
    name: row.name,
    address: row.address,
    timezone: row.timezone,
    status: row.status,
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

  // Used only for the workflow and admin RPCs, which client roles cannot execute.
  const serviceClient = config.serviceRoleKey
    ? createClient(config.url, config.serviceRoleKey, CLIENT_OPTIONS)
    : null

  async function runAdminCommand<Outcome extends string>(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<AdminCommandResult<Outcome>> {
    if (!serviceClient) throw new DataUnavailableError()
    const data = unwrap(await serviceClient.rpc(fn, args), fn)
    const parsed = adminCommandRow.safeParse(data)
    if (!parsed.success) throw new DataStoreError(` returned an unexpected shape`)
    return { outcome: parsed.data.outcome as Outcome, entityId: parsed.data.entity_id }
  }

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
    if (viewer.role === 'agency') query = query.in('branch.agency_id', agencyScope(viewer))
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
      const agencyIds =
        row!.role === 'agency' ? row!.agency_memberships.filter((m) => m.status === 'active').map((m) => m.agency_id) : []
      return {
        id: row!.id,
        fullName: row!.full_name,
        role: row!.role,
        agencyIds,
        agencyId: agencyIds[0] ?? null,
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
        .select('id, name, address, timezone, status, agency:agencies!inner (id, name)')
      if (viewer.role === 'agency') query = query.in('agency_id', agencyScope(viewer))
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

    async listAgencyNurses(viewer) {
      let query = asUser(viewer.accessToken).from('branch_nurse_eligibility').select(NURSE_ELIGIBILITY_COLUMNS)
      if (viewer.role === 'agency') query = query.in('branch.agency_id', agencyScope(viewer))
      const rows = parseRows(nurseEligibilityRow, unwrap(await query.limit(LIST_LIMIT), 'list agency nurses'), 'list agency nurses')
      const byNurse = new Map<string, NurseEligibility>()
      for (const row of rows) {
        const entry = byNurse.get(row.nurse_id) ?? { nurse: { id: row.nurse.id, fullName: row.nurse.full_name }, branches: [] }
        entry.branches.push({
          branch: { id: row.branch.id, name: row.branch.name, agency: row.branch.agency },
          status: row.status,
          activatedAt: row.activated_at ? iso(row.activated_at) : null,
        })
        byNurse.set(row.nurse_id, entry)
      }
      return [...byNurse.values()]
        .map((entry) => ({ ...entry, branches: entry.branches.sort((a, b) => a.branch.name.localeCompare(b.branch.name)) }))
        .sort((a, b) => a.nurse.fullName.localeCompare(b.nurse.fullName) || a.nurse.id.localeCompare(b.nurse.id))
    },

    async getEligibility(viewer, nurseId, branchId): Promise<EligibilityRecord | null> {
      const row = unwrap(
        await asUser(viewer.accessToken)
          .from('branch_nurse_eligibility')
          .select('nurse_id, branch_id, status, activated_at')
          .eq('nurse_id', nurseId)
          .eq('branch_id', branchId)
          .maybeSingle(),
        'get eligibility',
      )
      if (!row) return null
      const parsed = parseRows(eligibilityRecordRow, [row], 'get eligibility')[0]!
      return { nurseId: parsed.nurse_id, branchId: parsed.branch_id, status: parsed.status, activatedAt: parsed.activated_at ? iso(parsed.activated_at) : null }
    },

    setBranchEligibility(actorId, nurseId, branchId, status) {
      return runAdminCommand<SetEligibilityOutcome>('set_branch_eligibility', {
        p_actor_id: actorId,
        p_nurse_id: nurseId,
        p_branch_id: branchId,
        p_status: status,
      })
    },

    async listUsers(viewer) {
      const client = asUser(viewer.accessToken)
      const users = parseRows(adminUserRow, unwrap(await client.rpc('list_users_admin'), 'list users'), 'list users')
      const memberships = parseRows(
        membershipRow,
        unwrap(
          await client.from('agency_memberships').select('profile_id, agency:agencies!inner (id, name)').eq('status', 'active').limit(LIST_LIMIT),
          'list memberships',
        ),
        'list memberships',
      )
      const eligibility = parseRows(
        eligibilityRow,
        unwrap(
          await client
            .from('branch_nurse_eligibility')
            .select('nurse_id, status, branch:agency_branches!inner (id, name, agency:agencies!inner (id, name))')
            .limit(LIST_LIMIT),
          'list eligibility',
        ),
        'list eligibility',
      )
      return users.map(
        (row): AdminUser => ({
          id: row.id,
          email: row.email,
          fullName: row.full_name,
          role: row.role,
          status: row.confirmed_at ? 'active' : 'invited',
          invitedAt: row.invited_at ? iso(row.invited_at) : null,
          lastSignInAt: row.last_sign_in_at ? iso(row.last_sign_in_at) : null,
          agencies: memberships.filter((m) => m.profile_id === row.id).map((m) => m.agency),
          eligibleBranches: eligibility
            .filter((e) => e.nurse_id === row.id)
            .map((e) => ({ id: e.branch.id, name: e.branch.name, agency: e.branch.agency, status: e.status })),
        }),
      )
    },

    async getUser(viewer, userId) {
      const users = await this.listUsers(viewer)
      return users.find((user) => user.id === userId) ?? null
    },

    provisionUser(actorId, userId, command) {
      return runAdminCommand<ProvisionOutcome>('provision_user', {
        p_actor_id: actorId,
        p_user_id: userId,
        p_full_name: command.fullName,
        p_role: command.role,
        p_agency_ids: command.role === 'agency' ? command.agencyIds : null,
        p_branch_id: command.role === 'nurse' ? command.branchId : null,
      })
    },

    async listAgencies(viewer) {
      const rows = unwrap(
        await asUser(viewer.accessToken).from('agencies').select(AGENCY_COLUMNS).order('name').limit(LIST_LIMIT),
        'list agencies',
      )
      return parseRows(agencyRow, rows, 'list agencies').map(toAgency)
    },

    async getAgency(viewer, agencyId): Promise<AgencyDetail | null> {
      const client = asUser(viewer.accessToken)
      const row = unwrap(await client.from('agencies').select(AGENCY_COLUMNS).eq('id', agencyId).maybeSingle(), 'get agency')
      if (!row) return null
      const branches = unwrap(
        await client.from('agency_branches').select(AGENCY_BRANCH_COLUMNS).eq('agency_id', agencyId).order('name').limit(LIST_LIMIT),
        'list agency branches',
      )
      return {
        agency: toAgency(parseRows(agencyRow, [row], 'get agency')[0]!),
        branches: parseRows(agencyBranchRow, branches, 'list agency branches').map(toAgencyBranch),
      }
    },

    async getAgencyBranch(viewer, agencyId, branchId) {
      const row = unwrap(
        await asUser(viewer.accessToken)
          .from('agency_branches')
          .select(AGENCY_BRANCH_COLUMNS)
          .eq('id', branchId)
          .eq('agency_id', agencyId)
          .maybeSingle(),
        'get agency branch',
      )
      return row ? toAgencyBranch(parseRows(agencyBranchRow, [row], 'get agency branch')[0]!) : null
    },

    createAgency(actorId, input) {
      return runAdminCommand<CreateAgencyOutcome>('create_agency', { p_actor_id: actorId, p_name: input.name })
    },

    updateAgency(actorId, agencyId, input) {
      return runAdminCommand<UpdateAgencyOutcome>('update_agency', {
        p_actor_id: actorId,
        p_agency_id: agencyId,
        p_name: input.name ?? null,
        p_status: input.status ?? null,
      })
    },

    createBranch(actorId, agencyId, input) {
      return runAdminCommand<CreateBranchOutcome>('create_branch', {
        p_actor_id: actorId,
        p_agency_id: agencyId,
        p_name: input.name,
        p_address: input.address,
        p_timezone: input.timezone,
      })
    },

    updateBranch(actorId, branchId, input) {
      return runAdminCommand<UpdateBranchOutcome>('update_branch', {
        p_actor_id: actorId,
        p_branch_id: branchId,
        p_name: input.name ?? null,
        p_address: input.address ?? null,
        p_timezone: input.timezone ?? null,
        p_status: input.status ?? null,
      })
    },
  }
}
