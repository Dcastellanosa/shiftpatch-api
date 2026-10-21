import { z } from 'zod'

/**
 * Public identifiers are slugs such as `agency-a`, `nurse-1` or `shift-1`
 * (lower-case UUIDs match too). Branch ids stay UUIDs.
 */
export const publicIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be a public id such as shift-1')
