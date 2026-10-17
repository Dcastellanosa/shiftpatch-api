import type { AuthUser } from '../auth/auth-provider.js'

declare global {
  namespace Express {
    interface Request {
      /** Set by `resolveSession` only after server-side validation. */
      auth?: {
        user: AuthUser
        accessToken: string
      }
    }
  }
}

export {}
