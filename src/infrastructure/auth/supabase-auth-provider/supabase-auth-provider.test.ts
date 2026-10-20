import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../domain/ports/auth-provider/index.js'
import { createSupabaseAuthProvider } from './supabase-auth-provider.js'

const supabase = vi.hoisted(() => ({
  createClient: vi.fn(),
  auth: {
    signInWithPassword: vi.fn(),
    getUser: vi.fn(),
    refreshSession: vi.fn(),
    admin: { signOut: vi.fn() },
  },
}))

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: supabase.createClient,
}))

const CONFIG = { url: 'https://ref.supabase.co', publishableKey: 'sb_publishable_test' }
const USER = { id: '7c1e0d52-0000-4000-8000-000000000001', email: 'nurse@example.com' }
const SUPABASE_SESSION = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  user: USER,
}
const SESSION = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, user: USER }

const rejected = new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')
const rateLimited = new AuthApiError('Too many requests', 429, 'over_request_rate_limit')
const serverError = new AuthApiError('Database error', 500, 'unexpected_failure')
const networkError = new AuthRetryableFetchError('fetch failed', 0)

beforeEach(() => {
  vi.resetAllMocks()
  supabase.createClient.mockReturnValue({ auth: supabase.auth })
})

describe('createSupabaseAuthProvider', () => {
  it('builds a non-persistent client with the publishable key for each operation', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    const provider = createSupabaseAuthProvider(CONFIG)

    await provider.getUser('a')
    await provider.getUser('b')

    expect(supabase.createClient).toHaveBeenCalledTimes(2)
    expect(supabase.createClient).toHaveBeenCalledWith(CONFIG.url, CONFIG.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  })

  describe('signInWithPassword', () => {
    it('maps the Supabase session', async () => {
      supabase.auth.signInWithPassword.mockResolvedValue({ data: { session: SUPABASE_SESSION }, error: null })
      const session = await createSupabaseAuthProvider(CONFIG).signInWithPassword('nurse@example.com', 'pw')
      expect(session).toEqual(SESSION)
      expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'nurse@example.com', password: 'pw' })
    })

    it('maps a user without an email to a null email', async () => {
      supabase.auth.signInWithPassword.mockResolvedValue({
        data: { session: { ...SUPABASE_SESSION, user: { id: USER.id } } },
        error: null,
      })
      const session = await createSupabaseAuthProvider(CONFIG).signInWithPassword('x@example.com', 'pw')
      expect(session?.user).toEqual({ id: USER.id, email: null })
    })

    it('returns null when the credentials are rejected', async () => {
      supabase.auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: rejected })
      await expect(createSupabaseAuthProvider(CONFIG).signInWithPassword('x@example.com', 'pw')).resolves.toBeNull()
    })

    it('throws AuthRateLimitedError on 429', async () => {
      supabase.auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: rateLimited })
      await expect(createSupabaseAuthProvider(CONFIG).signInWithPassword('x@example.com', 'pw')).rejects.toBeInstanceOf(
        AuthRateLimitedError,
      )
    })

    it.each([
      ['a 5xx API error', serverError],
      ['a network error', networkError],
    ])('throws AuthUnavailableError on %s without leaking the original error', async (_label, error) => {
      supabase.auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error })
      const failure = await createSupabaseAuthProvider(CONFIG)
        .signInWithPassword('x@example.com', 'pw')
        .catch((e: unknown) => e)
      expect(failure).toBeInstanceOf(AuthUnavailableError)
      expect((failure as Error).message).not.toContain(error.message)
    })
  })

  describe('getUser', () => {
    it('returns the verified user for a valid token', async () => {
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      await expect(createSupabaseAuthProvider(CONFIG).getUser('token')).resolves.toEqual(USER)
      expect(supabase.auth.getUser).toHaveBeenCalledWith('token')
    })

    it('returns null for a rejected token', async () => {
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: rejected })
      await expect(createSupabaseAuthProvider(CONFIG).getUser('token')).resolves.toBeNull()
    })
  })

  describe('refreshSession', () => {
    it('returns the refreshed session', async () => {
      supabase.auth.refreshSession.mockResolvedValue({ data: { session: SUPABASE_SESSION }, error: null })
      await expect(createSupabaseAuthProvider(CONFIG).refreshSession('refresh-0')).resolves.toEqual(SESSION)
      expect(supabase.auth.refreshSession).toHaveBeenCalledWith({ refresh_token: 'refresh-0' })
    })

    it('returns null when Supabase returns no session', async () => {
      supabase.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: null })
      await expect(createSupabaseAuthProvider(CONFIG).refreshSession('refresh-0')).resolves.toBeNull()
    })

    it('returns null for a rejected refresh token', async () => {
      supabase.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: rejected })
      await expect(createSupabaseAuthProvider(CONFIG).refreshSession('refresh-0')).resolves.toBeNull()
    })
  })

  describe('signOut', () => {
    it('revokes the local session with the user token', async () => {
      supabase.auth.admin.signOut.mockResolvedValue({ error: null })
      await createSupabaseAuthProvider(CONFIG).signOut('token')
      expect(supabase.auth.admin.signOut).toHaveBeenCalledWith('token', 'local')
    })

    it('swallows revocation failures', async () => {
      supabase.auth.admin.signOut.mockRejectedValue(new Error('network down'))
      await expect(createSupabaseAuthProvider(CONFIG).signOut('token')).resolves.toBeUndefined()
    })
  })
})
