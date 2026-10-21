import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../../domain/ports/auth-provider/auth-provider.js'
import {
  ALLOWED_ORIGIN,
  REFRESHED_SESSION,
  SESSION,
  USER,
  buildApp,
  cookieFor,
  fakeAuthAdmin,
  fakeAuthProvider,
  setCookies,
} from '../../../../test-support/fakes.js'

const EXPECTED_PAYLOAD = {
  user: { id: USER.id, name: null, email: USER.email, role: null, agencyId: null, agencyIds: [] },
}

const CLEARED = /Expires=Thu, 01 Jan 1970 00:00:00 GMT/

/** Refresh tokens never appear in JSON; an access token only ever appears as the top-level `token` of a sign-in response. */
function expectNoTokens(body: unknown) {
  const json = JSON.stringify(body)
  for (const token of [
    SESSION.accessToken,
    SESSION.refreshToken,
    REFRESHED_SESSION.accessToken,
    REFRESHED_SESSION.refreshToken,
  ]) {
    expect(json).not.toContain(token)
  }
  expect(json).not.toMatch(/access_?token|refresh_?token/i)
}

function expectSignInPayload(body: unknown, session = SESSION) {
  expect(body).toEqual({ token: session.accessToken, ...EXPECTED_PAYLOAD })
  const json = JSON.stringify(body)
  expect(json).not.toContain(session.refreshToken)
  expect(json).not.toMatch(/access_?token|refresh_?token/i)
}

describe('POST /auth/login', () => {
  const login = (app: ReturnType<typeof buildApp>, body: unknown) =>
    request(app)
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send(body as object)

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
    expect(res.body.code).toBe('validation_error')
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
    expect(res.body).toEqual({ error: 'Malformed JSON body', code: 'invalid_json' })
  })

  it('returns a generic 401 and sets no cookies for invalid credentials', async () => {
    const provider = fakeAuthProvider()
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'wrong' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid email or password', code: 'invalid_credentials' })
    expect(setCookies(res.headers)).toEqual([])
  })

  it('returns the safe session payload plus the access token for API clients, never the refresh token', async () => {
    const provider = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'correct' })

    expect(res.status).toBe(200)
    expectSignInPayload(res.body)
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
      agencyIds: ['agency-1'],
    })

    expectSignInPayload(res.body)
  })

  it('returns 503 when auth is not configured', async () => {
    const res = await login(buildApp(null), { email: 'nurse@example.com', password: 'x' })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('auth_unavailable')
  })

  it('returns 429 when the provider rate-limits', async () => {
    const provider = fakeAuthProvider({
      signInWithPassword: async () => {
        throw new AuthRateLimitedError()
      },
    })
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'x' })
    expect(res.status).toBe(429)
    expect(res.body.code).toBe('rate_limited')
  })
})

describe('GET /auth/me', () => {
  it('returns 401 without session cookies and does not call the provider', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider)).get('/auth/me')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required', code: 'unauthenticated' })
    expect(provider.getUser).not.toHaveBeenCalled()
  })

  it('returns the safe payload for a valid access token', async () => {
    const provider = fakeAuthProvider({ getUser: async () => USER })
    const res = await request(buildApp(provider)).get('/auth/me').set('Cookie', `sp_access=${SESSION.accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(EXPECTED_PAYLOAD)
    expectNoTokens(res.body)
  })

  it('returns 401 and clears cookies for an invalid token with no refresh token', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider)).get('/auth/me').set('Cookie', 'sp_access=expired-token')

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('unauthenticated')
    expect(cookieFor(setCookies(res.headers), 'sp_access')).toMatch(CLEARED)
  })

  it('returns 401 for a malformed cookie without contacting the provider', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider)).get('/auth/me').set('Cookie', 'sp_access=%3Cscript%3E%20bad')

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
    const res = await request(buildApp(provider)).get('/auth/me').set('Cookie', `sp_refresh=${SESSION.refreshToken}`)

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
    expect(res.body.code).toBe('auth_unavailable')
  })
})

describe('Bearer sessions (API clients)', () => {
  const bearer = (app: ReturnType<typeof buildApp>, token: string) =>
    request(app).get('/auth/me').set('Authorization', `Bearer ${token}`)

  it('accepts Authorization: Bearer with a valid access token and sets no cookie', async () => {
    const provider = fakeAuthProvider({ getUser: async () => USER })
    const res = await bearer(buildApp(provider), SESSION.accessToken)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(EXPECTED_PAYLOAD)
    expect(provider.getUser).toHaveBeenCalledWith(SESSION.accessToken)
    expect(setCookies(res.headers)).toEqual([])
  })

  it('answers 401 for a rejected bearer token without falling back to cookies or refreshing', async () => {
    const provider = fakeAuthProvider({ getUser: async (token) => (token === SESSION.accessToken ? USER : null) })
    const res = await request(buildApp(provider))
      .get('/auth/me')
      .set('Authorization', 'Bearer stale-token')
      .set('Cookie', `sp_access=${SESSION.accessToken}; sp_refresh=${SESSION.refreshToken}`)

    expect(res.status).toBe(401)
    expect(provider.getUser).toHaveBeenCalledTimes(1)
    expect(provider.refreshSession).not.toHaveBeenCalled()
    expect(setCookies(res.headers)).toEqual([])
  })

  it('answers 401 for a malformed Authorization header without contacting the provider', async () => {
    const provider = fakeAuthProvider()
    for (const header of ['Basic abc', 'Bearer', 'Bearer <script>', `Token ${SESSION.accessToken}`]) {
      const res = await request(buildApp(provider)).get('/auth/me').set('Authorization', header)
      expect(res.status).toBe(401)
    }
    expect(provider.getUser).not.toHaveBeenCalled()
  })

  it('answers 503 for a bearer request when auth is not configured', async () => {
    const res = await bearer(buildApp(null), SESSION.accessToken)
    expect(res.status).toBe(503)
  })

  it('revokes a bearer session on logout', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider))
      .post('/auth/logout')
      .set('Authorization', `Bearer ${SESSION.accessToken}`)
    expect(res.status).toBe(204)
    expect(provider.signOut).toHaveBeenCalledWith(SESSION.accessToken)
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

describe('POST /auth/complete-password', () => {
  const complete = (app: ReturnType<typeof buildApp>, body: unknown) =>
    request(app)
      .post('/auth/complete-password')
      .set('Origin', ALLOWED_ORIGIN)
      .send(body as object)
  const VALID = { tokenHash: 'a'.repeat(56), type: 'invite', password: 'correct horse battery' }
  const appWith = (auth: ReturnType<typeof fakeAuthAdmin> | null) => buildApp(fakeAuthProvider(), 'test', null, auth)

  it('sets the password, then issues the same cookies as login and the safe payload', async () => {
    const auth = fakeAuthAdmin({ completePassword: async () => SESSION })
    const res = await complete(appWith(auth), VALID)

    expect(res.status).toBe(200)
    expectSignInPayload(res.body)
    expect(auth.completePassword).toHaveBeenCalledWith(VALID.tokenHash, 'invite', VALID.password)
    const cookies = setCookies(res.headers)
    expect(cookieFor(cookies, 'sp_access')).toContain(`sp_access=${SESSION.accessToken}`)
    expect(cookieFor(cookies, 'sp_refresh')).toContain(`sp_refresh=${SESSION.refreshToken}`)
    for (const cookie of cookies) {
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Path=/')
    }
  })

  it.each([
    ['invalid_link', 401, 'invalid_or_expired_link'],
    ['weak_password', 422, 'weak_password'],
  ] as const)('maps %s to %i with no Set-Cookie at all', async (outcome, status, code) => {
    const auth = fakeAuthAdmin({ completePassword: async () => outcome })
    const res = await complete(appWith(auth), { ...VALID, type: 'recovery' })
    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error: expect.any(String), code })
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(VALID.tokenHash)
  })

  it('sets no cookie when the provider is unavailable or rate limited', async () => {
    for (const error of [new AuthUnavailableError(), new AuthRateLimitedError()]) {
      const auth = fakeAuthAdmin({
        completePassword: async () => {
          throw error
        },
      })
      const res = await complete(appWith(auth), VALID)
      expect([429, 503]).toContain(res.status)
      expect(res.headers['set-cookie']).toBeUndefined()
    }
  })

  it.each([
    ['a short password', { ...VALID, password: 'short' }],
    ['an unknown link type', { ...VALID, type: 'magiclink' }],
    ['a malformed hash', { ...VALID, tokenHash: 'not a hash!' }],
    ['an unexpected key', { ...VALID, email: 'x@example.test' }],
    ['an empty body', {}],
  ])('rejects %s with 400, no provider call and no echo', async (_label, body) => {
    const auth = fakeAuthAdmin()
    const res = await complete(appWith(auth), body)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_error')
    expect(auth.completePassword).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toMatch(/short|magiclink|not a hash|correct horse/)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('answers 503 when link exchanges are not configured', async () => {
    const res = await complete(appWith(null), VALID)
    expect(res.status).toBe(503)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('rejects a cross-site request before contacting the provider', async () => {
    const auth = fakeAuthAdmin()
    const res = await request(appWith(auth))
      .post('/auth/complete-password')
      .set('Origin', 'https://evil.example')
      .send(VALID)
    expect(res.status).toBe(403)
    expect(auth.completePassword).not.toHaveBeenCalled()
  })
})

describe('POST /auth/recover', () => {
  const recover = (app: ReturnType<typeof buildApp>, body: unknown) =>
    request(app)
      .post('/auth/recover')
      .set('Origin', ALLOWED_ORIGIN)
      .send(body as object)

  it('answers 204 and asks the provider for an email pointing at the web set-password page', async () => {
    const auth = fakeAuthAdmin()
    const res = await recover(buildApp(fakeAuthProvider(), 'test', null, auth), { email: 'nurse@example.test' })
    expect(res.status).toBe(204)
    expect(auth.sendRecovery).toHaveBeenCalledWith('nurse@example.test', `${ALLOWED_ORIGIN}/set-password`)
  })

  it('answers 204 even when email is not configured', async () => {
    const res = await recover(buildApp(fakeAuthProvider(), 'test', null, null), { email: 'nurse@example.test' })
    expect(res.status).toBe(204)
  })

  it('rejects a malformed body without contacting the provider', async () => {
    const auth = fakeAuthAdmin()
    const res = await recover(buildApp(fakeAuthProvider(), 'test', null, auth), { email: 'nope', extra: 1 })
    expect(res.status).toBe(400)
    expect(auth.sendRecovery).not.toHaveBeenCalled()
  })
})
