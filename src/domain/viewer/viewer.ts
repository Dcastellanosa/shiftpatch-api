import type { AppRole } from '../shift/shift.js'

/** Identity as verified by the auth provider. Never built from client input. */
export interface AuthUser {
  id: string
  email: string | null
}

/** Application profile for a verified Auth user. */
export interface Profile {
  id: string
  fullName: string
  role: AppRole
  /** Agencies of the caller's active memberships (agency users only; empty otherwise). */
  agencyIds: string[]
  /** First active agency, kept for callers that expect a single one. */
  agencyId: string | null
}

/** The authenticated caller, resolved from the session and the profiles table. */
export interface Viewer extends Profile {
  /** Caller's access token, used for RLS-scoped reads. Never returned to clients. */
  accessToken: string
}
