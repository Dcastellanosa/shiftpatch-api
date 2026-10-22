import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../infrastructure/config/env/env.js'
import { createApp } from './create-app.js'
import { ALLOWED_ORIGIN, buildApp, fakeAuthProvider } from '../../test-support/fakes.js'

describe('GET /health', () => {
  it('returns 200 without Supabase configuration', async () => {
    const res = await request(buildApp(null)).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})

describe('origin check (CSRF)', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('rejects %s from an unapproved origin', async (method) => {
    const agent = request(buildApp())
    const verb = method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete'
    const res = await agent[verb]('/auth/logout').set('Origin', 'https://evil.example')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Request origin is not allowed' })
  })

  it('rejects login from an unapproved origin before contacting the provider', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider))
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'nurse@example.com', password: 'x' })

    expect(res.status).toBe(403)
    expect(provider.signInWithPassword).not.toHaveBeenCalled()
  })

  it.each([
    ['POST', '/auth/login', { email: 'a@example.com', password: 'x' }],
    ['POST', '/auth/complete-password', { tokenHash: 'a'.repeat(56), type: 'invite', password: 'long enough' }],
    ['POST', '/shifts/shift-1/cancel', { reason: 'advance' }],
    ['POST', '/shifts/shift-1/claim', {}],
    ['POST', '/shifts', { role: 'RN', date: '2026-10-05', startTime: '07:00', endTime: '19:00' }],
  ])('answers %s %s from an unapproved origin with 403 and the one-key envelope', async (_m, path, body) => {
    const res = await request(buildApp()).post(path).set('Origin', 'https://evil.example').send(body)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Request origin is not allowed' })
  })

  it('rejects the opaque "null" origin', async () => {
    const res = await request(buildApp()).post('/auth/logout').set('Origin', 'null')
    expect(res.status).toBe(403)
  })

  it('rejects a browser request that omits Origin', async () => {
    const res = await request(buildApp())
      .post('/auth/logout')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Sec-Fetch-Mode', 'cors')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Origin header is required' })
  })

  it('allows unsafe requests from an approved origin', async () => {
    const res = await request(buildApp()).post('/auth/logout').set('Origin', ALLOWED_ORIGIN)
    expect(res.status).toBe(204)
  })

  it('does not block safe methods', async () => {
    const res = await request(buildApp()).get('/auth/me').set('Origin', 'https://evil.example')
    expect(res.status).toBe(401)
  })
})

describe('the /api prefix', () => {
  it('serves every route under /api as well, for clients that reach the API host directly', async () => {
    const app = buildApp()
    expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok' })
    const me = await request(app).get('/api/auth/me')
    expect(me.status).toBe(401)
    expect(me.body).toEqual({ error: 'Authentication required' })
    const missing = await request(app).get('/api/nope')
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: 'Route not found' })
  })
})

describe('CORS', () => {
  it('lets browser API clients from an approved origin send Authorization and use PUT', async () => {
    const res = await request(buildApp())
      .options('/nurses/x/eligibility/y')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-methods']).toContain('PUT')
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i)
  })

  it('allows an exact approved origin without credentials (there are no cookies)', async () => {
    const res = await request(buildApp()).get('/health').set('Origin', ALLOWED_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('sends no CORS headers to an unapproved origin', async () => {
    const res = await request(buildApp()).get('/health').set('Origin', 'https://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('createApp wiring', () => {
  it('builds Supabase adapters from the environment when no overrides are given', async () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      CORS_ORIGINS: ALLOWED_ORIGIN,
      SUPABASE_URL: 'https://ref.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    })
    const res = await request(createApp(env)).get('/health')
    expect(res.status).toBe(200)
  })

  it('reports auth as unavailable without Supabase configuration', async () => {
    const app = createApp(parseEnv({ NODE_ENV: 'test', CORS_ORIGINS: ALLOWED_ORIGIN }))
    const res = await request(app)
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: 'nurse@example.com', password: 'pw' })
    expect(res.status).toBe(503)
    expect(Object.keys(res.body)).toEqual(['error'])
  })

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(buildApp()).get('/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Route not found' })
  })

  it('does not advertise Express', async () => {
    const res = await request(buildApp()).get('/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })
})
