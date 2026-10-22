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
 * HTTP request and response contracts for the shift API. Every shift leaves
 * this API as the contract's flat shape and nothing else:
 * `id, agencyId, agencyName, role, date, startTime, endTime, status, claimedBy`.
 * The stored status `claimed` is the public `filled`; the translation lives
 * in `toContractShift` only.
 */

export const appRoleSchema = z.enum(APP_ROLES)
/** Stored statuses, as the domain and the data store speak them. */
export const shiftStatusSchema = z.enum(SHIFT_STATUSES)
/** Public statuses, as the contract reads. */
export const CONTRACT_SHIFT_STATUSES = ['open', 'filled'] as const
export type ContractShiftStatus = (typeof CONTRACT_SHIFT_STATUSES)[number]
export const contractShiftStatusSchema = z.enum(CONTRACT_SHIFT_STATUSES)
export const shiftEventTypeSchema = z.enum(SHIFT_EVENT_TYPES)
export const entityStatusSchema = z.enum(ENTITY_STATUSES)

const isoTimestamp = z.iso.datetime()
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
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

export const CONTRACT_SHIFT_KEYS = [
  'id',
  'agencyId',
  'agencyName',
  'role',
  'date',
  'startTime',
  'endTime',
  'status',
  'claimedBy',
] as const

export const shiftSchema = z
  .object({
    id: publicIdSchema,
    agencyId: publicIdSchema,
    agencyName: z.string(),
    role: z.string(),
    date: localDate,
    startTime: localTime,
    endTime: localTime,
    status: contractShiftStatusSchema,
    claimedBy: publicIdSchema.nullable(),
  })
  .strict()

export type ContractShift = z.infer<typeof shiftSchema>

const toContractStatus = (status: Shift['status']): ContractShiftStatus => (status === 'claimed' ? 'filled' : 'open')

/** Projects a domain shift onto the contract shape: exactly the nine public keys. */
export function toContractShift(shift: Shift): ContractShift {
  return {
    id: shift.id,
    agencyId: shift.agencyId,
    agencyName: shift.agencyName,
    role: shift.role,
    date: shift.date,
    startTime: shift.startTime,
    endTime: shift.endTime,
    status: toContractStatus(shift.status),
    claimedBy: shift.claimedBy,
  }
}

export const cancellationSchema = z.object({
  reason: z.enum(CANCEL_REASONS),
  previousNurseId: publicIdSchema,
}) satisfies z.ZodType<ShiftCancellation>

export const shiftEventSchema = z.object({
  id: z.uuid(),
  eventType: shiftEventTypeSchema,
  previousStatus: z.string().nullable(),
  newStatus: z.string(),
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

/** `?status=` speaks the public words only (`open`, `filled`); the store receives the stored value. */
const statusFilter = contractShiftStatusSchema.transform((value): Shift['status'] =>
  value === 'filled' ? 'claimed' : 'open',
)

export const listShiftsQuery = z
  .object({
    status: statusFilter.optional(),
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
