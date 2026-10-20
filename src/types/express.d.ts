import type { AuthUser, Viewer } from '../domain/identity.js'

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
