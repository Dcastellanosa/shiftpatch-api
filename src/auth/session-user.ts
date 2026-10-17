import type { AuthUser } from './auth-provider.js'

export type UserRole = 'agency' | 'nurse' | 'admin'

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

/**
 * Profile data (full name, role, agency) is not modeled yet, so those fields
 * are always null. When the profiles table exists, the lookup belongs here,
 * keyed by the verified `user.id`, and the response shape stays the same.
 */
export function toSessionPayload(user: AuthUser): SessionPayload {
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: null,
      role: null,
      agencyId: null,
    },
  }
}
