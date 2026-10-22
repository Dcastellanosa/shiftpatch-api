import { z } from 'zod'

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
    'must be a calendar date',
  )

/** Text fields of the multipart `POST /me/credentials`; the file part is handled by the upload middleware. */
export const uploadCredentialFields = z
  .object({
    expiresAt: calendarDate,
    credentialTypeCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,62}$/)
      .default('nursing_license'),
  })
  .strict()

export type UploadCredentialFields = z.infer<typeof uploadCredentialFields>
