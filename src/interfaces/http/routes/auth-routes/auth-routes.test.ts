import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../../domain/ports/auth-provider/auth-provider.js'
import {
  ALLOWED_ORIGIN,
  SESSION,
  USER,
  buildApp,
  fakeAuthAdmin,
  fakeAuthProvider,
  fakeTokenVerifier,
} from '../../../../test-support/fakes.js'

/** `GET /auth/me` for a user without a profile: the name falls back to the email. */
const EXPECTED_PAYLOAD = {
  user: { id: USER.id, name: USER.email, email: USER.email, role: null, agencyId: null, agencyIds: [] },
}

/** Sign-in responses are exactly `{ token, user: { id, name, role } }`, as the contract reads. */
function expectSignInPayload(body: unknown, session = SESSION) {
  expect(body).toEqual({ token: session.accessToken, user: { id: USER.id, name: USER.email, role: null } })
  expect(Object.keys(body as object).sort()).toEqual(['token', 'user'])
  expect(Object.keys((body as { user: object }).user).sort()).toEqual(['id', 'name', 'role'])
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
    expect(res.body).toEqual({ error: 'Invalid request body' })
    expect(provider.signInWithPassword).not.toHaveBeenCalled()
  })

  it('rejects unknown keys in the body (strict contract) without contacting the provider', async () => {
    const provider = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const res = await login(buildApp(provider), {
      email: 'nurse@example.com',
      password: 'correct',
      id: 'attacker-chosen-id',
      role: 'admin',
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid request body' })
    expect(provider.signInWithPassword).not.toHaveBeenCalled()
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
    expect(res.body).toEqual({ error: 'Malformed JSON body' })
  })

  it('returns a generic 401 for invalid credentials', async () => {
    const provider = fakeAuthProvider()
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'wrong' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid email or password' })
  })

  it('returns the access token with the safe payload, never the refresh token, and sets no cookie', async () => {
    const provider = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'correct' })

    expect(res.status).toBe(200)
    expectSignInPayload(res.body)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('sets no cookie in production either', async () => {
    const provider = fakeAuthProvider({ signInWithPassword: async () => SESSION })
    const res = await login(buildApp(provider, 'production'), { email: 'nurse@example.com', password: 'correct' })
    expect(res.status).toBe(200)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('returns 503 when auth is not configured', async () => {
    const res = await login(buildApp(null), { email: 'nurse@example.com', password: 'x' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'Authentication is not available' })
  })

  it('returns 429 when the provider rate-limits', async () => {
    const provider = fakeAuthProvider({
      signInWithPassword: async () => {
        throw new AuthRateLimitedError()
      },
    })
    const res = await login(buildApp(provider), { email: 'nurse@example.com', password: 'x' })
    expect(res.status).toBe(429)
    expect(res.body).toEqual({ error: 'Too many authentication attempts' })
  })
})

describe('GET /auth/me (bearer sessions)', () => {
  const me = (app: ReturnType<typeof buildApp>) => request(app).get('/auth/me')
  const appWith = (verifier: ReturnType<typeof fakeTokenVerifier> | null) =>
    buildApp(fakeAuthProvider(), 'test', null, null, verifier)

  it('returns 401 without an Authorization header and does not call the verifier', async () => {
    const verifier = fakeTokenVerifier()
    const res = await me(appWith(verifier))

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required' })
    expect(verifier.verify).not.toHaveBeenCalled()
  })

  it('returns the safe payload for a verified bearer token and sets no cookie', async () => {
    const verifier = fakeTokenVerifier({ verify: async () => USER })
    const res = await me(appWith(verifier)).set('Authorization', `Bearer ${SESSION.accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(EXPECTED_PAYLOAD)
    expect(JSON.stringify(res.body)).not.toContain(SESSION.accessToken)
    expect(verifier.verify).toHaveBeenCalledWith(SESSION.accessToken)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('returns 401 for a rejected (invalid or expired) token', async () => {
    const res = await me(appWith(fakeTokenVerifier())).set('Authorization', 'Bearer stale-token')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid or expired token' })
  })

  it('never reads a session from cookies', async () => {
    const verifier = fakeTokenVerifier({ verify: async () => USER })
    const res = await me(appWith(verifier)).set('Cookie', `sp_access=${SESSION.accessToken}`)

    expect(res.status).toBe(401)
    expect(verifier.verify).not.toHaveBeenCalled()
  })

  it('returns 401 for a malformed Authorization header without contacting the verifier', async () => {
    const verifier = fakeTokenVerifier()
    for (const header of ['Basic abc', 'Bearer', 'Bearer <script>', `Token ${SESSION.accessToken}`]) {
      const res = await me(appWith(verifier)).set('Authorization', header)
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'Invalid or expired token' })
    }
    expect(verifier.verify).not.toHaveBeenCalled()
  })

  it('ignores identity supplied in the query string', async () => {
    const res = await request(appWith(fakeTokenVerifier())).get(`/auth/me?userId=${USER.id}&role=admin`)
    expect(res.status).toBe(401)
  })

  it('answers 503 for a bearer request when auth is not configured', async () => {
    const res = await me(appWith(null)).set('Authorization', `Bearer ${SESSION.accessToken}`)
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'Authentication is not available' })
  })
})

describe('POST /auth/logout', () => {
  it('revokes the presented bearer token', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider))
      .post('/auth/logout')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Authorization', `Bearer ${SESSION.accessToken}`)

    expect(res.status).toBe(204)
    expect(provider.signOut).toHaveBeenCalledWith(SESSION.accessToken)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('answers 204 without a token and never reads cookies', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider))
      .post('/auth/logout')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `sp_access=${SESSION.accessToken}`)

    expect(res.status).toBe(204)
    expect(provider.signOut).not.toHaveBeenCalled()
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

  it('sets the password, then answers with the same bearer session shape as login', async () => {
    const auth = fakeAuthAdmin({ completePassword: async () => SESSION })
    const res = await complete(appWith(auth), VALID)

    expect(res.status).toBe(200)
    expectSignInPayload(res.body)
    expect(auth.completePassword).toHaveBeenCalledWith(VALID.tokenHash, 'invite', VALID.password)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it.each([
    ['invalid_link', 401, 'This link is invalid or has expired. Request a new one.'],
    ['weak_password', 422, 'Choose a longer, less common password'],
  ] as const)('maps %s to %i without a token', async (outcome, status, error) => {
    const auth = fakeAuthAdmin({ completePassword: async () => outcome })
    const res = await complete(appWith(auth), { ...VALID, type: 'recovery' })
    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error })
    expect(JSON.stringify(res.body)).not.toContain(VALID.tokenHash)
  })

  it('answers 429 or 503 when the provider is unavailable or rate limited', async () => {
    for (const error of [new AuthUnavailableError(), new AuthRateLimitedError()]) {
      const auth = fakeAuthAdmin({
        completePassword: async () => {
          throw error
        },
      })
      const res = await complete(appWith(auth), VALID)
      expect([429, 503]).toContain(res.status)
      expect(res.body.token).toBeUndefined()
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
    expect(res.body).toEqual({ error: 'Invalid request body' })
    expect(auth.completePassword).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toMatch(/short|magiclink|not a hash|correct horse/)
  })

  it('answers 503 when link exchanges are not configured', async () => {
    const res = await complete(appWith(null), VALID)
    expect(res.status).toBe(503)
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
