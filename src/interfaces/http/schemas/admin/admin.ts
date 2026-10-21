import { z } from 'zod'
import {
  ENTITY_STATUSES,
  type Agency,
  type AgencyBranch,
  type CreateAgencyInput,
  type CreateBranchInput,
  type UpdateAgencyInput,
  type UpdateBranchInput,
} from '../../../../domain/agency/agency.js'

/**
 * HTTP contracts of the agency administration routes. Bodies are strict:
 * unknown keys are rejected rather than ignored, and no input is echoed.
 */

export const entityStatusSchema = z.enum(ENTITY_STATUSES)

const isoTimestamp = z.iso.datetime()
const name = z.string().trim().min(1).max(200)
const address = z.string().trim().min(1).max(500)

/** IANA zone names known to this runtime; also satisfies the database's shape check. */
const SUPPORTED_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone')).add('UTC')
export const timezoneSchema = z
  .string()
  .max(64)
  .refine((value) => SUPPORTED_TIMEZONES.has(value), { message: 'must be an IANA time zone name' })

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const agencySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: entityStatusSchema,
  branchCount: z.number().int().nonnegative(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}) satisfies z.ZodType<Agency>

export const agencyBranchSchema = z.object({
  id: z.uuid(),
  agencyId: z.uuid(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  status: entityStatusSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}) satisfies z.ZodType<AgencyBranch>

export const agencyListResponse = z.object({ agencies: z.array(agencySchema) })
export const agencyResponse = z.object({ agency: agencySchema })
export const agencyDetailResponse = z.object({ agency: agencySchema, branches: z.array(agencyBranchSchema) })
export const branchResponse = z.object({ branch: agencyBranchSchema })

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const agencyIdParams = z.object({ agencyId: z.uuid() })
export const agencyBranchParams = z.object({ agencyId: z.uuid(), branchId: z.uuid() })

export const createAgencyBody = z.object({ name }).strict() satisfies z.ZodType<CreateAgencyInput, unknown>

export const updateAgencyBody = z
  .object({ name: name.optional(), status: entityStatusSchema.optional() })
  .strict()
  .refine((body) => body.name !== undefined || body.status !== undefined, {
    message: 'at least one of name or status is required',
  }) satisfies z.ZodType<UpdateAgencyInput, unknown>

export const createBranchBody = z
  .object({ name, address, timezone: timezoneSchema })
  .strict() satisfies z.ZodType<CreateBranchInput, unknown>

export const updateBranchBody = z
  .object({
    name: name.optional(),
    address: address.optional(),
    timezone: timezoneSchema.optional(),
    status: entityStatusSchema.optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'at least one field is required',
  }) satisfies z.ZodType<UpdateBranchInput, unknown>
