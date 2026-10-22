import type { AuthUser } from '../../viewer/viewer.js'

/**
 * Driven port: validates an access token's signature, issuer, audience and
 * expiry and returns the authenticated subject. Resolves to `null` for any
 * token that must be rejected; throws `TokenVerifierUnavailableError` when the
 * key material cannot be reached. Authorization data (role, agencies,
 * branches) is never read from the token: the application resolves it from
 * the ShiftPatch database afterwards.
 */
export interface TokenVerifier {
  verify(token: string): Promise<AuthUser | null>
}

export class TokenVerifierUnavailableError extends Error {
  constructor() {
    super('Authentication is not available')
    this.name = 'TokenVerifierUnavailableError'
  }
}
