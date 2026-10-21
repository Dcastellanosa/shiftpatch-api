import { z } from 'zod'
import { ELIGIBILITY_STATUSES, type EligibilityRecord, type NurseEligibility } from '../../../../domain/admin/admin.js'

/** HTTP contracts of the agency nurse-eligibility routes. */

const isoTimestamp = z.iso.datetime()
const eligibilityStatusSchema = z.enum(ELIGIBILITY_STATUSES)
const agencyRef = z.object({ id: z.uuid(), name: z.string() })

export const nurseEligibilitySchema = z.object({
  nurse: z.object({ id: z.uuid(), fullName: z.string() }),
  branches: z.array(
    z.object({
      branch: z.object({ id: z.uuid(), name: z.string(), agency: agencyRef }),
      status: eligibilityStatusSchema,
      activatedAt: isoTimestamp.nullable(),
    }),
  ),
}) satisfies z.ZodType<NurseEligibility>

export const eligibilityRecordSchema = z.object({
  nurseId: z.uuid(),
  branchId: z.uuid(),
  status: eligibilityStatusSchema,
  activatedAt: isoTimestamp.nullable(),
}) satisfies z.ZodType<EligibilityRecord>

export const nurseListResponse = z.object({ nurses: z.array(nurseEligibilitySchema) })
export const eligibilityResponse = z.object({ eligibility: eligibilityRecordSchema })

export const eligibilityParams = z.object({ nurseId: z.uuid(), branchId: z.uuid() })
