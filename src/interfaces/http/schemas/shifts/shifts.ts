import { z } from 'zod'
import { ENTITY_STATUSES } from '../../../../domain/agency/agency.js'
import {
  APP_ROLES,
  CANCEL_REASONS,
  SHIFT_EVENT_TYPES,
  SHIFT_STATUSES,
  type Branch,
  type CreateShiftInput,
  type Shift,
  type ShiftCancellation,
  type ShiftEvent,
  type ShiftFilters,
} from '../../../../domain/shift/shift.js'
import { publicIdSchema } from '../ids/ids.js'

/**
 * HTTP request and response contracts for the shift API. Response schemas are
 * the shapes clients rely on; `satisfies` keeps them in step with the domain
 * types. The flat `id, agencyId, agencyName, role, date, startTime, endTime,
 * status, claimedBy` part is the trial contract; the rest is a superset.
 */

export const appRoleSchema = z.enum(APP_ROLES)
export const shiftStatusSchema = z.enum(SHIFT_STATUSES)
export const shiftEventTypeSchema = z.enum(SHIFT_EVENT_TYPES)
export const entityStatusSchema = z.enum(ENTITY_STATUSES)

const isoTimestamp = z.iso.datetime()
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(
  (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
  'must be a calendar date',
)
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM')

export const branchSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  status: entityStatusSchema,
  agency: z.object({ id: publicIdSchema, name: z.string() }),
}) satisfies z.ZodType<Branch>

export const shiftSchema = z.object({
  id: publicIdSchema,
  agencyId: publicIdSchema,
  agencyName: z.string(),
  role: z.string(),
  date: localDate,
  startTime: localTime,
  endTime: localTime,
  status: shiftStatusSchema,
  claimedBy: publicIdSchema.nullable(),
  claimedByName: z.string().nullable(),
  branch: z.object({ id: z.uuid(), name: z.string(), address: z.string(), timezone: z.string(), status: entityStatusSchema }),
  startsAt: isoTimestamp,
  endsAt: isoTimestamp,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}) satisfies z.ZodType<Shift>

export const cancellationSchema = z.object({
  reason: z.enum(CANCEL_REASONS),
  previousNurseId: publicIdSchema,
}) satisfies z.ZodType<ShiftCancellation>

export const shiftEventSchema = z.object({
  id: z.uuid(),
  eventType: shiftEventTypeSchema,
  previousStatus: shiftStatusSchema.nullable(),
  newStatus: shiftStatusSchema,
  reason: z.string().nullable(),
  occurredAt: isoTimestamp,
  /** `fullName` is null when the caller may not see the actor's profile. */
  actor: z.object({ id: z.uuid(), fullName: z.string().nullable() }),
}) satisfies z.ZodType<ShiftEvent>

/** Single-shift responses are the bare shift object (contract). */
export const shiftResponse = shiftSchema
export const cancelResponse = shiftSchema.extend({ cancellation: cancellationSchema })
export const shiftListResponse = z.object({ shifts: z.array(shiftSchema) })
export const agencyShiftsResponse = z.object({ agencyId: publicIdSchema, shifts: z.array(shiftSchema) })
export const shiftEventsResponse = z.object({ events: z.array(shiftEventSchema) })
export const branchListResponse = z.object({ branches: z.array(branchSchema) })
export const myShiftsResponse = z.object({ upcoming: z.array(shiftSchema), past: z.array(shiftSchema) })

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const shiftIdParams = z.object({ shiftId: publicIdSchema })
export const agencyShiftsParams = z.object({ agencyId: publicIdSchema })

export const listShiftsQuery = z
  .object({
    status: shiftStatusSchema.optional(),
    branchId: z.uuid().optional(),
    agencyId: publicIdSchema.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` must be before `to`',
    path: ['to'],
  }) satisfies z.ZodType<ShiftFilters, unknown>

/** `POST /shifts`: the contract body. `branchId` is needed only when the caller has several active branches. */
export const createShiftBody = z
  .object({
    role: z.string().trim().min(1).max(200),
    date: localDate,
    startTime: localTime,
    endTime: localTime,
    branchId: z.uuid().optional(),
  })
  .strict() satisfies z.ZodType<CreateShiftInput, unknown>

export const cancelBody = z.object({ reason: z.enum(CANCEL_REASONS) }).strict()
export type CancelBody = z.infer<typeof cancelBody>
