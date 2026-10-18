import type { AppRole } from '../shifts/contracts.js'

export type UserRole = AppRole

/** The only user shape this API returns to clients. Never contains tokens. */
export interface SessionUser {
  id: string
  email: string | null
  fullName: string | null
  role: UserRole | null
  agencyId: string | null
}

export interface SessionPayload {
  user: SessionUser
}
