import type { CookieOptions, Request, Response } from 'express'
import type { AuthSession } from '../../../domain/ports/auth-provider/auth-provider.js'

/** Sliding window: each successful refresh re-issues the refresh cookie. */
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

// Tokens are opaque to this service, but anything outside this shape is
// treated as a malformed credential and never forwarded to Supabase.
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,4096}$/

export interface BearerToken {
  accessToken?: string
  /** True when an Authorization header is present (well-formed or not). */
  present: boolean
}

/**
 * Reads `Authorization: Bearer <token>` for API clients (the trial contract).
 * A present but malformed header is reported as present with no token, so
 * the caller answers 401 instead of falling back to cookies.
 */
export function readBearerToken(req: Request): BearerToken {
  const header = req.get('authorization')
  if (header === undefined) return { present: false }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = match?.[1]
  return { present: true, accessToken: token && TOKEN_PATTERN.test(token) ? token : undefined }
}

export interface SessionCookieConfig {
  secure: boolean
}

export interface SessionCookieNames {
  access: string
  refresh: string
}

/**
 * In production the `__Host-` prefix makes browsers enforce Secure, Path=/
 * and no Domain attribute. Plain names are used over http://localhost.
 */
export function sessionCookieNames(config: SessionCookieConfig): SessionCookieNames {
  return config.secure
    ? { access: '__Host-sp_access', refresh: '__Host-sp_refresh' }
    : { access: 'sp_access', refresh: 'sp_refresh' }
}

function baseOptions(config: SessionCookieConfig): CookieOptions {
  // No `domain`: cookies stay host-only on the origin that served them
  // (the frontend origin, when proxied through /api).
  return { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/' }
}

export function setSessionCookies(res: Response, session: AuthSession, config: SessionCookieConfig) {
  const names = sessionCookieNames(config)
  const options = baseOptions(config)
  res.cookie(names.access, session.accessToken, {
    ...options,
    // The access cookie expires with the token; the refresh cookie outlives it.
    maxAge: Math.max(session.expiresIn, 0) * 1000,
  })
  res.cookie(names.refresh, session.refreshToken, {
    ...options,
    maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS * 1000,
  })
}

export function clearSessionCookies(res: Response, config: SessionCookieConfig) {
  const names = sessionCookieNames(config)
  const options = baseOptions(config)
  res.clearCookie(names.access, options)
  res.clearCookie(names.refresh, options)
}

export interface SessionCookieValues {
  accessToken?: string
  refreshToken?: string
  /** True when a session cookie was present but did not look like a token. */
  malformed: boolean
}

export function readSessionCookies(req: Request, config: SessionCookieConfig): SessionCookieValues {
  const names = sessionCookieNames(config)
  const cookies: Record<string, unknown> = req.cookies ?? {}
  const access = cookies[names.access]
  const refresh = cookies[names.refresh]
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && TOKEN_PATTERN.test(value)

  return {
    accessToken: valid(access) ? access : undefined,
    refreshToken: valid(refresh) ? refresh : undefined,
    malformed: (access !== undefined && !valid(access)) || (refresh !== undefined && !valid(refresh)),
  }
}
