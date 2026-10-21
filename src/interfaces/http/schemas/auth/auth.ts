import { z } from 'zod'
import { PASSWORD_LINK_TYPES } from '../../../../domain/admin/admin.js'

/** `POST /auth/login` body. Values are validated at the boundary and never echoed. */
export const loginBody = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
})

export type LoginBody = z.infer<typeof loginBody>

/**
 * `POST /auth/complete-password` body: the one-time hash from an invitation
 * or recovery link (read from the URL fragment by the web app) and the new
 * password. Never logged or echoed.
 */
export const completePasswordBody = z
  .object({
    tokenHash: z.string().regex(/^[A-Za-z0-9._~-]{16,512}$/),
    type: z.enum(PASSWORD_LINK_TYPES),
    password: z.string().min(8).max(72),
  })
  .strict()

export type CompletePasswordBody = z.infer<typeof completePasswordBody>

/** `POST /auth/recover` body. */
export const recoverBody = z.object({ email: z.email().max(320) }).strict()

export type RecoverBody = z.infer<typeof recoverBody>
