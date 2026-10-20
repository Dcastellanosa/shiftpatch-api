import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../infrastructure/config/env/index.js'
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
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'rejects %s from an unapproved origin',
    async (method) => {
      const agent = request(buildApp())
      const verb = method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete'
      const res = await agent[verb]('/auth/logout').set('Origin', 'https://evil.example')

      expect(res.status).toBe(403)
      expect(res.body).toEqual({
        error: { code: 'invalid_origin', message: 'Request origin is not allowed' },
      })
    },
  )

  it('rejects login from an unapproved origin before contacting the provider', async () => {
    const provider = fakeAuthProvider()
    const res = await request(buildApp(provider))
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'nurse@example.com', password: 'x' })

    expect(res.status).toBe(403)
    expect(provider.signInWithPassword).not.toHaveBeenCalled()
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
    expect(res.body).toEqual({ error: { code: 'origin_required', message: 'Origin header is required' } })
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

describe('CORS', () => {
  it('allows credentials only for an exact approved origin', async () => {
    const res = await request(buildApp()).get('/health').set('Origin', ALLOWED_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
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
    expect(res.body.error.code).toBe('auth_unavailable')
  })

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(buildApp()).get('/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Route not found' } })
  })

  it('does not advertise Express', async () => {
    const res = await request(buildApp()).get('/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })
})
