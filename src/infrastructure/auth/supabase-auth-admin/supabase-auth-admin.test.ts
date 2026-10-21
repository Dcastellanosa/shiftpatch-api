import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../domain/ports/auth-provider/auth-provider.js'
import { createSupabaseAuthAdmin } from './supabase-auth-admin.js'

const supabase = vi.hoisted(() => ({
  createClient: vi.fn(),
  auth: {
    verifyOtp: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    admin: { inviteUserByEmail: vi.fn(), deleteUser: vi.fn() },
  },
}))

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: supabase.createClient,
}))

const CONFIG = {
  url: 'https://ref.supabase.co',
  publishableKey: 'sb_publishable_test',
  serviceRoleKey: 'sb_secret_test',
}
const USER = { id: '7c1e0d52-0000-4000-8000-000000000001', email: 'new@example.com' }
const SUPABASE_SESSION = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, user: USER }
const SESSION = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, user: USER }
const REDIRECT = 'http://localhost:5173/set-password'

beforeEach(() => {
  vi.resetAllMocks()
  supabase.createClient.mockReturnValue({ auth: supabase.auth })
  supabase.auth.signOut.mockResolvedValue({ error: null })
})

describe('createSupabaseAuthAdmin', () => {
  it('uses the service-role client for the admin API and a publishable client for link exchanges', async () => {
    supabase.auth.admin.inviteUserByEmail.mockResolvedValue({ data: { user: USER }, error: null })
    supabase.auth.verifyOtp.mockResolvedValue({ data: { session: SUPABASE_SESSION }, error: null })
    supabase.auth.updateUser.mockResolvedValue({ data: { user: USER }, error: null })
    const auth = createSupabaseAuthAdmin(CONFIG)

    await auth.inviteUser('new@example.com', { fullName: 'New', redirectTo: REDIRECT })
    await auth.completePassword('hash', 'invite', 'correct horse battery')

    expect(supabase.createClient).toHaveBeenNthCalledWith(1, CONFIG.url, CONFIG.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    expect(supabase.createClient).toHaveBeenNthCalledWith(2, CONFIG.url, CONFIG.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  })

  describe('inviteUser', () => {
    it('invites with the full name and redirect and returns the new id', async () => {
      supabase.auth.admin.inviteUserByEmail.mockResolvedValue({ data: { user: USER }, error: null })
      await expect(
        createSupabaseAuthAdmin(CONFIG).inviteUser('new@example.com', { fullName: 'New', redirectTo: REDIRECT }),
      ).resolves.toEqual({ id: USER.id })
      expect(supabase.auth.admin.inviteUserByEmail).toHaveBeenCalledWith('new@example.com', {
        data: { full_name: 'New' },
        redirectTo: REDIRECT,
      })
    })

    it('reports an existing address', async () => {
      supabase.auth.admin.inviteUserByEmail.mockResolvedValue({
        data: { user: null },
        error: new AuthApiError('exists', 422, 'email_exists'),
      })
      await expect(
        createSupabaseAuthAdmin(CONFIG).inviteUser('new@example.com', { fullName: 'New', redirectTo: REDIRECT }),
      ).resolves.toBe('email_exists')
    })

    it.each([
      ['rate limits', new AuthApiError('slow down', 429, 'over_email_send_rate_limit'), AuthRateLimitedError],
      ['server errors', new AuthApiError('boom', 500, 'unexpected_failure'), AuthUnavailableError],
      ['network failures', new AuthRetryableFetchError('fetch failed', 0), AuthUnavailableError],
    ])('throws a typed error for %s', async (_label, error, expected) => {
      supabase.auth.admin.inviteUserByEmail.mockResolvedValue({ data: { user: null }, error })
      await expect(
        createSupabaseAuthAdmin(CONFIG).inviteUser('new@example.com', { fullName: 'New', redirectTo: REDIRECT }),
      ).rejects.toBeInstanceOf(expected)
    })
  })

  describe('deleteUser', () => {
    it('removes the user and surfaces failures as unavailable', async () => {
      supabase.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null })
      await expect(createSupabaseAuthAdmin(CONFIG).deleteUser(USER.id)).resolves.toBeUndefined()
      expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith(USER.id)
      supabase.auth.admin.deleteUser.mockResolvedValue({
        data: {},
        error: new AuthApiError('boom', 500, 'unexpected_failure'),
      })
      await expect(createSupabaseAuthAdmin(CONFIG).deleteUser(USER.id)).rejects.toBeInstanceOf(AuthUnavailableError)
    })
  })

  describe('completePassword', () => {
    it('verifies the hash, updates the password and returns the session', async () => {
      supabase.auth.verifyOtp.mockResolvedValue({ data: { session: SUPABASE_SESSION }, error: null })
      supabase.auth.updateUser.mockResolvedValue({ data: { user: USER }, error: null })
      await expect(
        createSupabaseAuthAdmin(CONFIG).completePassword('hash-1', 'recovery', 'correct horse battery'),
      ).resolves.toEqual(SESSION)
      expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-1', type: 'recovery' })
      expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'correct horse battery' })
      expect(supabase.auth.signOut).not.toHaveBeenCalled()
    })

    it('reports an invalid or expired link without touching the password', async () => {
      supabase.auth.verifyOtp.mockResolvedValue({
        data: { session: null },
        error: new AuthApiError('expired', 403, 'otp_expired'),
      })
      await expect(createSupabaseAuthAdmin(CONFIG).completePassword('hash-1', 'invite', 'pw-pw-pw-pw')).resolves.toBe(
        'invalid_link',
      )
      expect(supabase.auth.updateUser).not.toHaveBeenCalled()
    })

    it('revokes the provisional session and reports a weak password', async () => {
      supabase.auth.verifyOtp.mockResolvedValue({ data: { session: SUPABASE_SESSION }, error: null })
      supabase.auth.updateUser.mockResolvedValue({
        data: { user: null },
        error: new AuthApiError('weak', 422, 'weak_password'),
      })
      await expect(createSupabaseAuthAdmin(CONFIG).completePassword('hash-1', 'invite', 'password')).resolves.toBe(
        'weak_password',
      )
      expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    })

    it('revokes the provisional session and throws when the update fails otherwise', async () => {
      supabase.auth.verifyOtp.mockResolvedValue({ data: { session: SUPABASE_SESSION }, error: null })
      supabase.auth.updateUser.mockResolvedValue({
        data: { user: null },
        error: new AuthApiError('boom', 500, 'unexpected_failure'),
      })
      await expect(
        createSupabaseAuthAdmin(CONFIG).completePassword('hash-1', 'invite', 'correct horse battery'),
      ).rejects.toBeInstanceOf(AuthUnavailableError)
      expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    })

    it('throws for rate limits and outages during verification', async () => {
      supabase.auth.verifyOtp.mockResolvedValue({
        data: { session: null },
        error: new AuthApiError('slow', 429, 'over_request_rate_limit'),
      })
      await expect(
        createSupabaseAuthAdmin(CONFIG).completePassword('h', 'invite', 'correct horse battery'),
      ).rejects.toBeInstanceOf(AuthRateLimitedError)
      supabase.auth.verifyOtp.mockResolvedValue({
        data: { session: null },
        error: new AuthRetryableFetchError('down', 0),
      })
      await expect(
        createSupabaseAuthAdmin(CONFIG).completePassword('h', 'invite', 'correct horse battery'),
      ).rejects.toBeInstanceOf(AuthUnavailableError)
    })
  })

  describe('sendRecovery', () => {
    it('requests the email with the redirect and stays silent on rejections', async () => {
      supabase.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
      await expect(createSupabaseAuthAdmin(CONFIG).sendRecovery('new@example.com', REDIRECT)).resolves.toBeUndefined()
      expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith('new@example.com', { redirectTo: REDIRECT })
      supabase.auth.resetPasswordForEmail.mockResolvedValue({
        data: {},
        error: new AuthApiError('nope', 400, 'user_not_found'),
      })
      await expect(createSupabaseAuthAdmin(CONFIG).sendRecovery('new@example.com', REDIRECT)).resolves.toBeUndefined()
    })

    it('throws for rate limits and outages', async () => {
      supabase.auth.resetPasswordForEmail.mockResolvedValue({
        data: {},
        error: new AuthApiError('slow', 429, 'over_email_send_rate_limit'),
      })
      await expect(createSupabaseAuthAdmin(CONFIG).sendRecovery('new@example.com', REDIRECT)).rejects.toBeInstanceOf(
        AuthRateLimitedError,
      )
      supabase.auth.resetPasswordForEmail.mockResolvedValue({
        data: {},
        error: new AuthApiError('boom', 500, 'unexpected_failure'),
      })
      await expect(createSupabaseAuthAdmin(CONFIG).sendRecovery('new@example.com', REDIRECT)).rejects.toBeInstanceOf(
        AuthUnavailableError,
      )
    })
  })
})
