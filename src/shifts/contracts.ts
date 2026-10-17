import { z } from 'zod'

/**
 * Request and response contracts for the shift API. Response schemas are the
 * shapes the frontend relies on; every timestamp is an ISO 8601 UTC string.
 */

export const appRoleSchema = z.enum(['admin', 'agency', 'nurse'])
export type AppRole = z.infer<typeof appRoleSchema>

export const shiftStatusSchema = z.enum(['open', 'claimed', 'cancelled', 'completed', 'no_show'])
export type ShiftStatus = z.infer<typeof shiftStatusSchema>

export const shiftEventTypeSchema = z.enum(['created', 'claimed', 'cancelled', 'completed', 'no_show'])

const isoTimestamp = z.iso.datetime()

export const branchSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  agency: z.object({ id: z.uuid(), name: z.string() }),
})
export type Branch = z.infer<typeof branchSchema>

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
})
export type Shift = z.infer<typeof shiftSchema>

export const shiftEventSchema = z.object({
  id: z.uuid(),
  eventType: shiftEventTypeSchema,
  previousStatus: shiftStatusSchema.nullable(),
  newStatus: shiftStatusSchema,
  reason: z.string().nullable(),
  occurredAt: isoTimestamp,
  /** `fullName` is null when the caller may not see the actor's profile. */
  actor: z.object({ id: z.uuid(), fullName: z.string().nullable() }),
})
export type ShiftEvent = z.infer<typeof shiftEventSchema>

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
    /** Shifts starting at or after this instant. */
    from: z.iso.datetime({ offset: true }).optional(),
    /** Shifts starting before this instant. */
    to: z.iso.datetime({ offset: true }).optional(),
    /** Nurse only: also include shifts assigned to the caller. */
    includeAssigned: queryBoolean.optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` must be before `to`',
    path: ['to'],
  })
export type ShiftFilters = z.infer<typeof listShiftsQuery>

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
  )
export type CreateShiftInput = z.infer<typeof createShiftBody>
