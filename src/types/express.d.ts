import type { AuthUser } from '../auth/auth-provider.js'
import type { Viewer } from '../data/data-store.js'

declare global {
  namespace Express {
    interface Request {
      /** Set by `resolveSession` only after server-side validation. */
      auth?: {
        user: AuthUser
        accessToken: string
      }
      /** Set by `loadViewer` from the caller's own profile row. */
      viewer?: Viewer
    }
  }
}

export {}
