import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import {
  TokenVerifierUnavailableError,
  type TokenVerifier,
} from '../../../domain/ports/token-verifier/token-verifier.js'
import type { AuthUser } from '../../../domain/viewer/viewer.js'

export interface JoseTokenVerifierConfig {
  supabaseUrl: string
  /**
   * Shared secret of projects that sign with HS256 (the local CLI stack and
   * legacy hosted projects). Server-only; never logged. When absent, HS256
   * tokens are rejected and only asymmetric signing keys are trusted.
   */
  jwtSecret?: string | undefined
  /** Test seam replacing the remote JWKS of `<supabaseUrl>/auth/v1/.well-known/jwks.json`. */
  jwks?: JWTVerifyGetKey
}

const ASYMMETRIC_ALGORITHMS = new Set(['ES256', 'RS256'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Verifies Supabase access tokens locally: signature (JWKS for ES256/RS256,
 * the project secret for HS256), issuer `<supabaseUrl>/auth/v1`, audience
 * `authenticated` and expiry. No network call per request beyond the cached
 * key set.
 */
export function createJoseTokenVerifier(config: JoseTokenVerifierConfig): TokenVerifier {
  const issuer = `${config.supabaseUrl}/auth/v1`
  const jwks = config.jwks ?? createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', config.supabaseUrl))
  const secret = config.jwtSecret ? new TextEncoder().encode(config.jwtSecret) : null

  return {
    async verify(token) {
      let alg: string | undefined
      try {
        alg = decodeProtectedHeader(token).alg
      } catch {
        return null
      }
      if (!alg) return null

      const options = { issuer, audience: 'authenticated', algorithms: [alg] }
      let payload: JWTPayload
      try {
        if (ASYMMETRIC_ALGORITHMS.has(alg)) {
          payload = (await jwtVerify(token, jwks, options)).payload
        } else if (alg === 'HS256' && secret) {
          payload = (await jwtVerify(token, secret, options)).payload
        } else {
          return null
        }
      } catch (error) {
        if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSNoMatchingKey) {
          // JWKSNoMatchingKey after a refresh means the key set is reachable but
          // does not hold the key: a rejection. A timeout is unavailability.
          if (error instanceof joseErrors.JWKSTimeout) throw new TokenVerifierUnavailableError()
          return null
        }
        if (error instanceof joseErrors.JOSEError) return null
        // fetch failures (TypeError) and anything else: the key set is unreachable.
        throw new TokenVerifierUnavailableError()
      }

      return toAuthUser(payload)
    },
  }
}

function toAuthUser(payload: JWTPayload): AuthUser | null {
  if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return null
  const email = typeof payload.email === 'string' ? payload.email : null
  return { id: payload.sub, email }
}
