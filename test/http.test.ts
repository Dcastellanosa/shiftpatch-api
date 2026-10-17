import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { parseEnv } from '../src/config/env.js'
import { ALLOWED_ORIGIN, buildApp, fakeAuthProvider } from './helpers.js'

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

describe('parseEnv', () => {
  it('starts without any Supabase variables', () => {
    const env = parseEnv({ CORS_ORIGINS: ALLOWED_ORIGIN })
    expect(env.SUPABASE_URL).toBeUndefined()
    expect(env.NODE_ENV).toBe('development')
  })

  it('treats blank values from .env.example as unset', () => {
    const env = parseEnv({
      CORS_ORIGINS: ALLOWED_ORIGIN,
      NODE_ENV: '',
      SUPABASE_URL: '',
      SUPABASE_PUBLISHABLE_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    })
    expect(env.NODE_ENV).toBe('development')
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
  })

  it('requires CORS_ORIGINS', () => {
    expect(() => parseEnv({ CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/)
  })

  it('requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY together', () => {
    expect(() =>
      parseEnv({ CORS_ORIGINS: ALLOWED_ORIGIN, SUPABASE_URL: 'https://ref.supabase.co' }),
    ).toThrow(/SUPABASE_PUBLISHABLE_KEY/)
  })

  it('never echoes secret values in validation errors', () => {
    const secret = 'sb_secret_should_not_appear'
    try {
      parseEnv({ CORS_ORIGINS: 'not a url', SUPABASE_SERVICE_ROLE_KEY: secret })
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })
})
