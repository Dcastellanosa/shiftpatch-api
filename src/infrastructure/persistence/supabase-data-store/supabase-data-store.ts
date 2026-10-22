import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { DataStoreError, DataUnavailableError, type DataStore } from '../../../domain/ports/data-store/data-store.js'
import {
  ELIGIBILITY_STATUSES,
  type AdminUser,
  type EligibilityRecord,
  type NurseEligibility,
} from '../../../domain/admin/admin.js'
import { ENTITY_STATUSES, type Agency, type AgencyBranch, type AgencyDetail } from '../../../domain/agency/agency.js'
import { toLocalDateTime } from '../../../domain/local-time/local-time.js'
import type {
  AdminCommandResult,
  CancelCommandResult,
  CancelOutcome,
  ClaimOutcome,
  CommandResult,
  CreateAgencyOutcome,
  DeleteAgencyOutcome,
  DeleteUserOutcome,
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
  type Shift,
  type ShiftEvent,
  SHIFT_STATUSES,
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

// ---------------------------------------------------------------------------
// Status vocabulary: the database says `claimed`, the contract says `filled`.
// ---------------------------------------------------------------------------

const appRoleSchema = z.enum(APP_ROLES)
// Reads are restricted to the two stored statuses a shift can have today.
const dbShiftStatusSchema = z.enum(SHIFT_STATUSES)
const shiftEventTypeSchema = z.enum(SHIFT_EVENT_TYPES)
const entityStatusSchema = z.enum(ENTITY_STATUSES)

/** One row of `list_shifts_marketplace`: the only read path for shifts. */
const marketRow = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  status: dbShiftStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  branch_address: z.string(),
  branch_timezone: z.string(),
  branch_status: entityStatusSchema,
  agency_id: z.uuid(),
  agency_slug: z.string(),
  agency_name: z.string(),
  agency_status: entityStatusSchema,
  assigned_nurse_id: z.uuid().nullable(),
  assigned_nurse_slug: z.string().nullable(),
  assigned_nurse_name: z.string().nullable(),
})

const eventRow = z.object({
  id: z.uuid(),
  actor_id: z.uuid(),
  event_type: shiftEventTypeSchema,
  previous_status: z.string().nullable(),
  new_status: z.string(),
  reason: z.string().nullable(),
  occurred_at: z.string(),
  actor: z.object({ full_name: z.string() }).nullable(),
})

const agencyRef = z.object({ id: z.uuid(), slug: z.string(), name: z.string() })

const branchRow = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  status: entityStatusSchema,
  agency: agencyRef,
})

const agencyRow = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: entityStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  agency_branches: z.array(z.object({ count: z.number() })),
})

const agencyBranchRow = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  status: entityStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  agency: z.object({ id: z.uuid(), slug: z.string() }),
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

const profileSlugRow = z.object({ id: z.uuid(), slug: z.string() })

const membershipRow = z.object({
  profile_id: z.uuid(),
  agency: agencyRef,
})

const eligibilityRow = z.object({
  nurse_id: z.uuid(),
  status: z.enum(ELIGIBILITY_STATUSES),
  branch: z.object({ id: z.uuid(), name: z.string(), agency: agencyRef }),
})

const nurseEligibilityRow = z.object({
  nurse_id: z.uuid(),
  status: z.enum(ELIGIBILITY_STATUSES),
  activated_at: z.string().nullable(),
  nurse: z.object({ id: z.uuid(), slug: z.string(), full_name: z.string() }),
  branch: z.object({ id: z.uuid(), name: z.string(), agency: agencyRef }),
})

const eligibilityRecordRow = z.object({
  branch_id: z.uuid(),
  status: z.enum(ELIGIBILITY_STATUSES),
  activated_at: z.string().nullable(),
  nurse: z.object({ slug: z.string() }),
})

const NURSE_ELIGIBILITY_COLUMNS = `
  nurse_id, status, activated_at,
  nurse:profiles!branch_nurse_eligibility_nurse_id_fkey!inner (id, slug, full_name),
  branch:agency_branches!inner (id, name, agency_id, agency:agencies!inner (id, slug, name))
`

const AGENCY_COLUMNS = 'id, slug, name, status, created_at, updated_at, agency_branches (count)'
const AGENCY_BRANCH_COLUMNS =
  'id, name, address, timezone, status, created_at, updated_at, agency:agencies!inner (id, slug)'

const profileRow = z.object({
  id: z.uuid(),
  slug: z.string(),
  full_name: z.string(),
  role: appRoleSchema,
  agency_memberships: z.array(
    z.object({ agency_id: z.uuid(), status: z.string(), agency: z.object({ slug: z.string() }).nullable() }),
  ),
})

const commandRow = z.object({
  outcome: z.string(),
  shift_id: z.uuid().nullable(),
  event_id: z.uuid().nullable(),
})

const cancelRow = z.object({
  outcome: z.string(),
  shift_id: z.uuid().nullable(),
  event_id: z.uuid().nullable(),
  previous_nurse_id: z.uuid().nullable(),
  previous_nurse_slug: z.string().nullable(),
})

const adminCommandRow = z.object({
  outcome: z.string(),
  entity_id: z.uuid().nullable(),
})

const idRow = z.object({ id: z.uuid() })

const iso = (value: string) => new Date(value).toISOString()

function toShift(row: z.infer<typeof marketRow>): Shift {
  const startsAt = iso(row.starts_at)
  const endsAt = iso(row.ends_at)
  const start = toLocalDateTime(startsAt, row.branch_timezone)
  const end = toLocalDateTime(endsAt, row.branch_timezone)
  return {
    id: row.slug,
    agencyId: row.agency_slug,
    agencyName: row.agency_name,
    role: row.title,
    date: start.date,
    startTime: start.time,
    endTime: end.time,
    status: row.status,
    claimedBy: row.assigned_nurse_slug,
    claimedByName: row.assigned_nurse_name,
    branch: {
      id: row.branch_id,
      name: row.branch_name,
      address: row.branch_address,
      timezone: row.branch_timezone,
      status: row.branch_status,
    },
    startsAt,
    endsAt,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function toAgency(row: z.infer<typeof agencyRow>): Agency {
  return {
    id: row.slug,
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
    agencyId: row.agency.slug,
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

export function createSupabaseDataStore(config: SupabaseDataConfig): DataStore {
  // Request-scoped client carrying the caller's JWT: queries run as the
  // `authenticated` role, so Row Level Security applies to every read.
  const asUser = (accessToken: string) =>
    createClient(config.url, config.publishableKey, {
      ...CLIENT_OPTIONS,
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })

  // Used only for the workflow and admin RPCs (which client roles cannot
  // execute) and for resolving public ids to the UUIDs those RPCs take.
  const serviceClient = config.serviceRoleKey ? createClient(config.url, config.serviceRoleKey, CLIENT_OPTIONS) : null

  function service() {
    if (!serviceClient) throw new DataUnavailableError()
    return serviceClient
  }

  /** The UUID behind a public id, or null when no such row exists. A slug lookup reveals nothing beyond existence. */
  async function uuidOf(table: 'agencies' | 'profiles' | 'shifts', slug: string): Promise<string | null> {
    const row = unwrap(await service().from(table).select('id').eq('slug', slug).maybeSingle(), `${table} lookup`)
    return row ? parseRows(idRow, [row], `${table} lookup`)[0]!.id : null
  }

  /** The public id of a row a command just created. */
  async function slugOf(table: 'agencies' | 'shifts', uuid: string): Promise<string> {
    const row = unwrap(await service().from(table).select('slug').eq('id', uuid).maybeSingle(), `${table} slug lookup`)
    const parsed = z.object({ slug: z.string() }).safeParse(row)
    if (!parsed.success) throw new DataStoreError(`${table} slug lookup returned an unexpected shape`)
    return parsed.data.slug
  }

  async function runAdminCommand<Outcome extends string>(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<AdminCommandResult<Outcome>> {
    const data = unwrap(await service().rpc(fn, args), fn)
    const parsed = adminCommandRow.safeParse(data)
    if (!parsed.success) throw new DataStoreError(`${fn} returned an unexpected shape`)
    return { outcome: parsed.data.outcome as Outcome, entityId: parsed.data.entity_id }
  }

  async function runCommand<Outcome extends string>(
    fn: 'create_shift' | 'claim_shift',
    args: Record<string, unknown>,
  ): Promise<CommandResult<Outcome>> {
    const data = unwrap(await service().rpc(fn, args), fn)
    const parsed = commandRow.safeParse(data)
    if (!parsed.success) throw new DataStoreError(`${fn} returned an unexpected shape`)
    return {
      outcome: parsed.data.outcome as Outcome,
      shiftId: parsed.data.shift_id,
      eventId: parsed.data.event_id,
    }
  }

  /** The marketplace projection as the caller (the function checks the caller is provisioned). */
  const marketplace = (viewer: Viewer, args: { agencySlug?: string | null; shiftSlug?: string | null } = {}) =>
    asUser(viewer.accessToken).rpc('list_shifts_marketplace', {
      p_agency_slug: args.agencySlug ?? null,
      p_shift_slug: args.shiftSlug ?? null,
    })

  return {
    async getProfile(accessToken, userId) {
      const data = unwrap(
        await asUser(accessToken)
          .from('profiles')
          .select('id, slug, full_name, role, agency_memberships (agency_id, status, agency:agencies (slug))')
          .eq('id', userId)
          .maybeSingle(),
        'profile lookup',
      )
      if (!data) return null
      const [row] = parseRows(profileRow, [data], 'profile lookup')
      const active =
        row!.role === 'agency' ? row!.agency_memberships.filter((m) => m.status === 'active' && m.agency) : []
      const agencyIds = active.map((m) => m.agency_id)
      const agencySlugs = active.map((m) => m.agency!.slug)
      return {
        id: row!.id,
        slug: row!.slug,
        fullName: row!.full_name,
        role: row!.role,
        agencyIds,
        agencySlugs,
        agencyId: agencyIds[0] ?? null,
        agencySlug: agencySlugs[0] ?? null,
      }
    },

    async listShifts(viewer, filters) {
      let query = marketplace(viewer, { agencySlug: filters.agencyId })
      if (filters.status) query = query.eq('status', filters.status)
      if (filters.branchId) query = query.eq('branch_id', filters.branchId)
      if (filters.from) query = query.gte('starts_at', filters.from)
      if (filters.to) query = query.lt('starts_at', filters.to)
      const rows = unwrap(await query.order('starts_at').order('id').limit(LIST_LIMIT), 'list shifts')
      return parseRows(marketRow, rows, 'list shifts').map(toShift)
    },

    async getShift(viewer, shiftId) {
      const row = unwrap(await marketplace(viewer, { shiftSlug: shiftId }).maybeSingle(), 'get shift')
      return row ? toShift(parseRows(marketRow, [row], 'get shift')[0]!) : null
    },

    async listAssignedShifts(viewer) {
      const rows = unwrap(
        await marketplace(viewer).eq('assigned_nurse_id', viewer.id).order('starts_at').order('id').limit(LIST_LIMIT),
        'list assigned shifts',
      )
      return parseRows(marketRow, rows, 'list assigned shifts').map(toShift)
    },

    async listShiftEvents(viewer, shiftId) {
      const client = asUser(viewer.accessToken)
      // Resolved under RLS: a shift the caller may not read has no readable history either.
      const shift = unwrap(await client.from('shifts').select('id').eq('slug', shiftId).maybeSingle(), 'shift lookup')
      if (!shift) return []
      const rows = unwrap(
        await client
          .from('shift_events')
          .select(
            'id, actor_id, event_type, previous_status, new_status, reason, occurred_at, actor:profiles!shift_events_actor_id_fkey (full_name)',
          )
          .eq('shift_id', parseRows(idRow, [shift], 'shift lookup')[0]!.id)
          .order('occurred_at')
          .order('id'),
        'list shift events',
      )
      return parseRows(eventRow, rows, 'list shift events').map(toEvent)
    },

    async listBranches(viewer) {
      let query = asUser(viewer.accessToken)
        .from('agency_branches')
        .select('id, name, address, timezone, status, agency:agencies!inner (id, slug, name)')
      if (viewer.role === 'agency') query = query.in('agency_id', agencyScope(viewer))
      const rows = unwrap(await query.order('name').limit(LIST_LIMIT), 'list branches')
      return parseRows(branchRow, rows, 'list branches').map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        timezone: row.timezone,
        status: row.status,
        agency: { id: row.agency.slug, name: row.agency.name },
      }))
    },

    async createShift(actorId, command) {
      const result = await runCommand<CreateOutcome>('create_shift', {
        p_actor_id: actorId,
        p_branch_id: command.branchId,
        p_title: command.title,
        p_starts_at: command.startsAt,
        p_ends_at: command.endsAt,
      })
      // Commands report public ids to the application layer.
      return result.shiftId ? { ...result, shiftId: await slugOf('shifts', result.shiftId) } : result
    },

    async claimShift(nurseId, shiftId) {
      const uuid = await uuidOf('shifts', shiftId)
      if (!uuid) return { outcome: 'shift_not_found', shiftId: null, eventId: null }
      const result = await runCommand<ClaimOutcome>('claim_shift', { p_shift_id: uuid, p_nurse_id: nurseId })
      return { ...result, shiftId: result.shiftId ? shiftId : null }
    },

    async cancelClaim(actorId, shiftId, reason): Promise<CancelCommandResult> {
      const uuid = await uuidOf('shifts', shiftId)
      if (!uuid)
        return {
          outcome: 'shift_not_found',
          shiftId: null,
          eventId: null,
          previousNurseId: null,
          previousNurseSlug: null,
        }
      const data = unwrap(
        await service().rpc('cancel_shift_claim', { p_actor_id: actorId, p_shift_id: uuid, p_reason: reason }),
        'cancel_shift_claim',
      )
      const parsed = cancelRow.safeParse(data)
      if (!parsed.success) throw new DataStoreError('cancel_shift_claim returned an unexpected shape')
      return {
        outcome: parsed.data.outcome as CancelOutcome,
        shiftId: parsed.data.shift_id ? shiftId : null,
        eventId: parsed.data.event_id,
        previousNurseId: parsed.data.previous_nurse_id,
        previousNurseSlug: parsed.data.previous_nurse_slug,
      }
    },

    async listAgencyNurses(viewer) {
      let query = asUser(viewer.accessToken).from('branch_nurse_eligibility').select(NURSE_ELIGIBILITY_COLUMNS)
      if (viewer.role === 'agency') query = query.in('branch.agency_id', agencyScope(viewer))
      const rows = parseRows(
        nurseEligibilityRow,
        unwrap(await query.limit(LIST_LIMIT), 'list agency nurses'),
        'list agency nurses',
      )
      const byNurse = new Map<string, NurseEligibility>()
      for (const row of rows) {
        const entry = byNurse.get(row.nurse_id) ?? {
          nurse: { id: row.nurse.slug, fullName: row.nurse.full_name },
          branches: [],
        }
        entry.branches.push({
          branch: {
            id: row.branch.id,
            name: row.branch.name,
            agency: { id: row.branch.agency.slug, name: row.branch.agency.name },
          },
          status: row.status,
          activatedAt: row.activated_at ? iso(row.activated_at) : null,
        })
        byNurse.set(row.nurse_id, entry)
      }
      return [...byNurse.values()]
        .map((entry) => ({
          ...entry,
          branches: entry.branches.sort((a, b) => a.branch.name.localeCompare(b.branch.name)),
        }))
        .sort((a, b) => a.nurse.fullName.localeCompare(b.nurse.fullName) || a.nurse.id.localeCompare(b.nurse.id))
    },

    async getEligibility(viewer, nurseId, branchId): Promise<EligibilityRecord | null> {
      const row = unwrap(
        await asUser(viewer.accessToken)
          .from('branch_nurse_eligibility')
          .select('branch_id, status, activated_at, nurse:profiles!branch_nurse_eligibility_nurse_id_fkey!inner (slug)')
          .eq('nurse.slug', nurseId)
          .eq('branch_id', branchId)
          .maybeSingle(),
        'get eligibility',
      )
      if (!row) return null
      const parsed = parseRows(eligibilityRecordRow, [row], 'get eligibility')[0]!
      return {
        nurseId: parsed.nurse.slug,
        branchId: parsed.branch_id,
        status: parsed.status,
        activatedAt: parsed.activated_at ? iso(parsed.activated_at) : null,
      }
    },

    async setBranchEligibility(actorId, nurseId, branchId, status) {
      const nurseUuid = await uuidOf('profiles', nurseId)
      if (!nurseUuid) return { outcome: 'nurse_not_found', entityId: null }
      return runAdminCommand<SetEligibilityOutcome>('set_branch_eligibility', {
        p_actor_id: actorId,
        p_nurse_id: nurseUuid,
        p_branch_id: branchId,
        p_status: status,
      })
    },

    async listUsers(viewer) {
      const client = asUser(viewer.accessToken)
      const users = parseRows(adminUserRow, unwrap(await client.rpc('list_users_admin'), 'list users'), 'list users')
      const slugs = new Map(
        parseRows(
          profileSlugRow,
          unwrap(await client.from('profiles').select('id, slug').limit(LIST_LIMIT), 'list profile ids'),
          'list profile ids',
        ).map((p) => [p.id, p.slug]),
      )
      const memberships = parseRows(
        membershipRow,
        unwrap(
          await client
            .from('agency_memberships')
            .select('profile_id, agency:agencies!inner (id, slug, name)')
            .eq('status', 'active')
            .limit(LIST_LIMIT),
          'list memberships',
        ),
        'list memberships',
      )
      const eligibility = parseRows(
        eligibilityRow,
        unwrap(
          await client
            .from('branch_nurse_eligibility')
            .select('nurse_id, status, branch:agency_branches!inner (id, name, agency:agencies!inner (id, slug, name))')
            .limit(LIST_LIMIT),
          'list eligibility',
        ),
        'list eligibility',
      )
      return users
        .map((row): AdminUser & { uuid: string } => ({
          uuid: row.id,
          id: slugs.get(row.id) ?? row.id,
          email: row.email,
          fullName: row.full_name,
          role: row.role,
          status: row.confirmed_at ? 'active' : 'invited',
          invitedAt: row.invited_at ? iso(row.invited_at) : null,
          lastSignInAt: row.last_sign_in_at ? iso(row.last_sign_in_at) : null,
          agencies: memberships
            .filter((m) => m.profile_id === row.id)
            .map((m) => ({ id: m.agency.slug, name: m.agency.name })),
          eligibleBranches: eligibility
            .filter((e) => e.nurse_id === row.id)
            .map((e) => ({
              id: e.branch.id,
              name: e.branch.name,
              agency: { id: e.branch.agency.slug, name: e.branch.agency.name },
              status: e.status,
            })),
        }))
        .map(({ uuid: _uuid, ...user }) => user)
    },

    async getUser(viewer, userId) {
      // Accepts the public id or, right after provisioning, the Auth UUID.
      const client = asUser(viewer.accessToken)
      const match = unwrap(
        await client
          .from('profiles')
          .select('id, slug')
          .or(`slug.eq.${userId},id.eq.${isUuid(userId) ? userId : NIL_UUID}`)
          .maybeSingle(),
        'user lookup',
      )
      if (!match) return null
      const { slug } = parseRows(profileSlugRow, [match], 'user lookup')[0]!
      const users = await this.listUsers(viewer)
      return users.find((user) => user.id === slug) ?? null
    },

    async provisionUser(actorId, authUserId, command) {
      let agencyUuids: string[] | null = null
      if (command.role === 'agency') {
        const rows = parseRows(
          z.object({ id: z.uuid(), slug: z.string() }),
          unwrap(await service().from('agencies').select('id, slug').in('slug', command.agencyIds), 'agencies lookup'),
          'agencies lookup',
        )
        if (rows.length !== new Set(command.agencyIds).size) return { outcome: 'agency_not_found', entityId: null }
        agencyUuids = rows.map((r) => r.id)
      }
      return runAdminCommand<ProvisionOutcome>('provision_user', {
        p_actor_id: actorId,
        p_user_id: authUserId,
        p_full_name: command.fullName,
        p_role: command.role,
        p_agency_ids: agencyUuids,
        p_branch_id: command.role === 'nurse' ? command.branchId : null,
      })
    },

    async deleteUser(actorId, userId) {
      const uuid = await uuidOf('profiles', userId)
      if (!uuid) return { outcome: 'user_not_found', entityId: null }
      return runAdminCommand<DeleteUserOutcome>('delete_user', { p_actor_id: actorId, p_user_id: uuid })
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
      const row = unwrap(
        await client.from('agencies').select(AGENCY_COLUMNS).eq('slug', agencyId).maybeSingle(),
        'get agency',
      )
      if (!row) return null
      const agency = parseRows(agencyRow, [row], 'get agency')[0]!
      const branches = unwrap(
        await client
          .from('agency_branches')
          .select(AGENCY_BRANCH_COLUMNS)
          .eq('agency_id', agency.id)
          .order('name')
          .limit(LIST_LIMIT),
        'list agency branches',
      )
      return {
        agency: toAgency(agency),
        branches: parseRows(agencyBranchRow, branches, 'list agency branches').map(toAgencyBranch),
      }
    },

    async getAgencyBranch(viewer, agencyId, branchId) {
      const row = unwrap(
        await asUser(viewer.accessToken)
          .from('agency_branches')
          .select(AGENCY_BRANCH_COLUMNS)
          .eq('id', branchId)
          .eq('agency.slug', agencyId)
          .maybeSingle(),
        'get agency branch',
      )
      return row ? toAgencyBranch(parseRows(agencyBranchRow, [row], 'get agency branch')[0]!) : null
    },

    async createAgency(actorId, input) {
      const result = await runAdminCommand<CreateAgencyOutcome>('create_agency', {
        p_actor_id: actorId,
        p_name: input.name,
      })
      return result.entityId ? { ...result, entityId: await slugOf('agencies', result.entityId) } : result
    },

    async updateAgency(actorId, agencyId, input) {
      const uuid = await uuidOf('agencies', agencyId)
      if (!uuid) return { outcome: 'agency_not_found', entityId: null }
      const result = await runAdminCommand<UpdateAgencyOutcome>('update_agency', {
        p_actor_id: actorId,
        p_agency_id: uuid,
        p_name: input.name ?? null,
        p_status: input.status ?? null,
      })
      return { ...result, entityId: result.entityId ? agencyId : null }
    },

    async deleteAgency(actorId, agencyId) {
      const uuid = await uuidOf('agencies', agencyId)
      if (!uuid) return { outcome: 'agency_not_found', entityId: null }
      const result = await runAdminCommand<DeleteAgencyOutcome>('delete_agency', {
        p_actor_id: actorId,
        p_agency_id: uuid,
      })
      return { ...result, entityId: result.entityId ? agencyId : null }
    },

    async createBranch(actorId, agencyId, input) {
      const uuid = await uuidOf('agencies', agencyId)
      if (!uuid) return { outcome: 'agency_not_found', entityId: null }
      return runAdminCommand<CreateBranchOutcome>('create_branch', {
        p_actor_id: actorId,
        p_agency_id: uuid,
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

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
