import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { AuthRateLimitedError, AuthUnavailableError } from '../src/auth/auth-provider.js'
import {
  ALLOWED_ORIGIN,
  REFRESHED_SESSION,
  SESSION,
  USER,
  buildApp,
  cookieFor,
  fakeAuthProvider,
  setCookies,
} from './helpers.js'

const EXPECTED_PAYLOAD = {
  user: { id: USER.id, email: USER.email, fullName: null, role: null, agencyId: null },
}

const CLEARED = /Expires=Thu, 01 Jan 1970 00:00:00 GMT/

function expectNoTokens(body: unknown) {
  const json = JSON.stringify(body)
  for (const token of [SESSION.accessToken, SESSION.refreshToken, REFRESHED_SESSION.accessToken, REFRESHED_SESSION.refreshToken]) {
    expect(json).not.toContain(token)
  }
  expect(json).not.toMatch(/access_?token|refresh_?token/i)
}

describe('POST /auth/login', () => {
  const login = (app: ReturnType<typeof buildApp>, body: unknown) =>
    request(app).post('/auth/login').set('Origin', ALLOWED_ORIGIN).send(body as object)

  it.each([
    ['empty body', {}],
    ['invalid email', { email: 'not-an-email', password: 'secret' }],
    ['missing password', { email: 'nurse@example.com' }],
    ['empty password', { email: 'nurse@example.com', password: '' }],
    ['non-string password', { email: 'nurse@example.com', password: 123 }],
  ])('returns 400 for %s', async (_label, body) => {
    const provider = fakeAuthProvider()
    const res = await login(buildApp(provider), body)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
    expect(provider.signInWithPassword).not.toHaveBeenCalled()
    expect(setCookies(res.headers)).toEqual([])
  })

  it('does not echo the submitted password in validation errors', async () => {
    const res = await login(buildApp(), { email: 'bad', password: 'hunter2-secret' })
    expect(JSON.stringify(res.body)).not.toContain('hunter2-secret')
  })

  it('returns 400 for malformed JSON', async () => {
    const res = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"email":')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: { code: 'invalid_json', message: 'Malformed JSON body' } })
  })

  it('returns a generic 401 and sets no cookies for invalid credentials', async () => {
    const provider = fakeAuthProvider()
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'wrong' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid email or password' },
    })
    expect(setCookies(res.headers)).toEqual([])
  })

  it('returns only the safe session payload and never tokens in JSON', async () => {
    const provider = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'correct' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual(EXPECTED_PAYLOAD)
    expectNoTokens(res.body)
  })

  it('sets HttpOnly, SameSite=Lax, Path=/ session cookies without a Domain', async () => {
    const provider = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'correct' })
    const cookies = setCookies(res.headers)
    const access = cookieFor(cookies, 'sp_access')
    const refresh = cookieFor(cookies, 'sp_refresh')

    expect(access).toContain(`sp_access=${SESSION.accessToken}`)
    expect(access).toContain('Max-Age=3600')
    expect(refresh).toContain(`sp_refresh=${SESSION.refreshToken}`)
    expect(refresh).toContain(`Max-Age=${7 * 24 * 60 * 60}`)
    for (const cookie of [access, refresh]) {
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Path=/')
      expect(cookie).not.toMatch(/Domain=/i)
      expect(cookie).not.toContain('Secure')
    }
  })

  it('uses Secure __Host- cookies in production', async () => {
    const provider = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const res = await login(buildApp(provider, 'production'), {
      email: 'nurse@example.com',
      password: 'correct',
    })
    const cookies = setCookies(res.headers)

    for (const name of ['__Host-sp_access', '__Host-sp_refresh']) {
      const cookie = cookieFor(cookies, name)
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).not.toMatch(/Domain=/i)
    }
  })

  it('ignores identity fields supplied in the body', async () => {
    const provider = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const res = await login(buildApp(provider), {
      email: 'nurse@example.com',
      password: 'correct',
      id: 'attacker-chosen-id',
      role: 'admin',
      agencyId: 'agency-1',
    })

    expect(res.body).toEqual(EXPECTED_PAYLOAD)
  })

  it('returns 503 when auth is not configured', async () => {
    const res = await login(buildApp(null), { email: 'nurse@example.com', password: 'x' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('auth_unavailable')
  })

  it('returns 429 when the provider rate-limits', async () => {
    const provider = fakeAuthProvider({
      signInWithPassword: async () => {
        throw new AuthRateLimitedError()
      },
    })
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'x' })
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('rate_limited')
  })
})

describe('GET /auth/me', () => {
  it('returns 401 without session cookies and does not call the provider', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider)).get('/auth/me')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    expect(provider.getUser).not.toHaveBeenCalled()
  })

  it('returns the safe payload for a valid access token', async () => {
    const provider = fakeAuthProvider({ getUser: async () => USER })
    const res = await request(buildApp(provider))
      .get('/auth/me')
      .set('Cookie', `sp_access=${SESSION.accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(EXPECTED_PAYLOAD)
    expectNoTokens(res.body)
  })

  it('returns 401 and clears cookies for an invalid token with no refresh token', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider)).get('/auth/me').set('Cookie', 'sp_access=expired-token')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthenticated')
    expect(cookieFor(setCookies(res.headers), 'sp_access')).toMatch(CLEARED)
  })

  it('returns 401 for a malformed cookie without contacting the provider', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider))
      .get('/auth/me')
      .set('Cookie', 'sp_access=%3Cscript%3E%20bad')

    expect(res.status).toBe(401)
    expect(provider.getUser).not.toHaveBeenCalled()
    expect(cookieFor(setCookies(res.headers), 'sp_access')).toMatch(CLEARED)
  })

  it('refreshes an expired session and reissues cookies', async () => {
    const provider = fakeAuthProvider()
    provider.refreshSession.mockResolvedValue(REFRESHED_SESSION)
    const res = await request(buildApp(provider))
      .get('/auth/me')
      .set('Cookie', `sp_access=${SESSION.accessToken}; sp_refresh=${SESSION.refreshToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(EXPECTED_PAYLOAD)
    expectNoTokens(res.body)
    expect(provider.refreshSession).toHaveBeenCalledWith(SESSION.refreshToken)
    const cookies = setCookies(res.headers)
    expect(cookieFor(cookies, 'sp_access')).toContain(`sp_access=${REFRESHED_SESSION.accessToken}`)
    expect(cookieFor(cookies, 'sp_refresh')).toContain(`sp_refresh=${REFRESHED_SESSION.refreshToken}`)
  })

  it('refreshes when only the refresh cookie remains', async () => {
    const provider = fakeAuthProvider({ refreshSession: async () => REFRESHED_SESSION })
    const res = await request(buildApp(provider))
      .get('/auth/me')
      .set('Cookie', `sp_refresh=${SESSION.refreshToken}`)

    expect(res.status).toBe(200)
    expect(provider.getUser).not.toHaveBeenCalled()
  })

  it('returns 401 and clears cookies when the refresh token is rejected', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider))
      .get('/auth/me')
      .set('Cookie', `sp_access=${SESSION.accessToken}; sp_refresh=${SESSION.refreshToken}`)

    expect(res.status).toBe(401)
    const cookies = setCookies(res.headers)
    expect(cookieFor(cookies, 'sp_access')).toMatch(CLEARED)
    expect(cookieFor(cookies, 'sp_refresh')).toMatch(CLEARED)
  })

  it('ignores identity supplied in the query string', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider)).get(`/auth/me?userId=${USER.id}&role=admin`)
    expect(res.status).toBe(401)
  })

  it('returns 503 when the provider is unavailable', async () => {
    const provider = fakeAuthProvider({
      getUser: async () => {
        throw new AuthUnavailableError()
      },
    })
    const res = await request(buildApp(provider)).get('/auth/me').set('Cookie', 'sp_access=some-token')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('auth_unavailable')
  })
})

describe('POST /auth/logout', () => {
  it('revokes the session and clears both cookies', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider))
      .post('/auth/logout')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `sp_access=${SESSION.accessToken}; sp_refresh=${SESSION.refreshToken}`)

    expect(res.status).toBe(204)
    expect(provider.signOut).toHaveBeenCalledWith(SESSION.accessToken)
    const cookies = setCookies(res.headers)
    for (const name of ['sp_access', 'sp_refresh']) {
      const cookie = cookieFor(cookies, name)
      expect(cookie).toMatch(CLEARED)
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('HttpOnly')
    }
  })

  it('clears cookies even without a session', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider)).post('/auth/logout').set('Origin', ALLOWED_ORIGIN)

    expect(res.status).toBe(204)
    expect(provider.signOut).not.toHaveBeenCalled()
    expect(cookieFor(setCookies(res.headers), 'sp_access')).toMatch(CLEARED)
  })
})
