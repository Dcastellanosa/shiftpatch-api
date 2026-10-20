import { z } from 'zod'
import {
  APP_ROLES,
  SHIFT_EVENT_TYPES,
  SHIFT_STATUSES,
  type Branch,
  type CreateShiftInput,
  type Shift,
  type ShiftEvent,
  type ShiftFilters,
} from '../../../../domain/shift/index.js'

/**
 * HTTP request and response contracts for the shift API. Response schemas are
 * the shapes the frontend relies on; `satisfies` keeps them in step with the
 * domain types.
 */

export const appRoleSchema = z.enum(APP_ROLES)
export const shiftStatusSchema = z.enum(SHIFT_STATUSES)
export const shiftEventTypeSchema = z.enum(SHIFT_EVENT_TYPES)

const isoTimestamp = z.iso.datetime()

export const branchSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  agency: z.object({ id: z.uuid(), name: z.string() }),
}) satisfies z.ZodType<Branch>

export const shiftSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  startsAt: isoTimestamp,
  endsAt: isoTimestamp,
  status: shiftStatusSchema,
  branch: z.object({ id: z.uuid(), name: z.string(), address: z.string(), timezone: z.string() }),
  agency: z.object({ id: z.uuid(), name: z.string() }),
  assignedNurse: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}) satisfies z.ZodType<Shift>

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

export const shiftListResponse = z.object({ shifts: z.array(shiftSchema) })
export const shiftResponse = z.object({ shift: shiftSchema })
export const shiftEventsResponse = z.object({ events: z.array(shiftEventSchema) })
export const branchListResponse = z.object({ branches: z.array(branchSchema) })
export const myShiftsResponse = z.object({ upcoming: z.array(shiftSchema), past: z.array(shiftSchema) })

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const shiftIdParams = z.object({ shiftId: z.uuid() })

const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true')

export const listShiftsQuery = z
  .object({
    status: shiftStatusSchema.optional(),
    branchId: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    includeAssigned: queryBoolean.optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` must be before `to`',
    path: ['to'],
  }) satisfies z.ZodType<ShiftFilters, unknown>

const MAX_SHIFT_HOURS = 24

export const createShiftBody = z
  .object({
    branchId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  })
  .refine((b) => new Date(b.endsAt) > new Date(b.startsAt), {
    message: '`endsAt` must be after `startsAt`',
    path: ['endsAt'],
  })
  .refine(
    (b) => new Date(b.endsAt).getTime() - new Date(b.startsAt).getTime() <= MAX_SHIFT_HOURS * 3_600_000,
    { message: `A shift cannot be longer than ${MAX_SHIFT_HOURS} hours`, path: ['endsAt'] },
  ) satisfies z.ZodType<CreateShiftInput, unknown>
