import { vi } from 'vitest'
import type { AuthProvider, AuthSession, AuthUser } from '../src/auth/auth-provider.js'
import { parseEnv } from '../src/config/env.js'
import { createApp } from '../src/create-app.js'

export const ALLOWED_ORIGIN = 'http://localhost:5173'

export const USER: AuthUser = { id: '7c1e0d52-0000-4000-8000-000000000001', email: 'nurse@example.com' }

export const SESSION: AuthSession = {
  accessToken: 'access-token-value-1',
  refreshToken: 'refresh-token-value-1',
  expiresIn: 3600,
  user: USER,
}

export const REFRESHED_SESSION: AuthSession = {
  accessToken: 'access-token-value-2',
  refreshToken: 'refresh-token-value-2',
  expiresIn: 3600,
  user: USER,
}

/** Every method is a spy; overrides become the spy's implementation. */
export function fakeAuthProvider(overrides: Partial<AuthProvider> = {}) {
  return {
    signInWithPassword: vi.fn<AuthProvider['signInWithPassword']>(
      overrides.signInWithPassword ?? (async () => null),
    ),
    getUser: vi.fn<AuthProvider['getUser']>(overrides.getUser ?? (async () => null)),
    refreshSession: vi.fn<AuthProvider['refreshSession']>(overrides.refreshSession ?? (async () => null)),
    signOut: vi.fn<AuthProvider['signOut']>(overrides.signOut ?? (async () => undefined)),
  }
}

export function buildApp(
  authProvider: AuthProvider | null = fakeAuthProvider(),
  nodeEnv: 'test' | 'production' = 'test',
) {
  const env = parseEnv({ NODE_ENV: nodeEnv, CORS_ORIGINS: ALLOWED_ORIGIN })
  return createApp(env, { authProvider })
}

/** Returns the Set-Cookie header lines as an array. */
export function setCookies(headers: Record<string, unknown>): string[] {
  const value = headers['set-cookie']
  if (value === undefined) return []
  return Array.isArray(value) ? value : [String(value)]
}

export function cookieFor(cookies: string[], name: string): string | undefined {
  return cookies.find((line) => line.startsWith(`${name}=`))
}
