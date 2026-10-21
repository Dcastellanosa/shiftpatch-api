import { z } from 'zod'

/** `POST /auth/login` body. Values are validated at the boundary and never echoed. */
export const loginBody = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
})

export type LoginBody = z.infer<typeof loginBody>
