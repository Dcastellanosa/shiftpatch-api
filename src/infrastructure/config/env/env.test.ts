import { describe, expect, it } from 'vitest'
import { parseEnv, parseSeedEnv } from './env.js'

const ALLOWED_ORIGIN = 'http://localhost:5173'

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
      SUPABASE_JWT_SECRET: '',
    })
    expect(env.NODE_ENV).toBe('development')
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
    expect(env.SUPABASE_JWT_SECRET).toBeUndefined()
  })

  it('requires CORS_ORIGINS', () => {
    expect(() => parseEnv({ CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/)
  })

  it('requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY together', () => {
    expect(() => parseEnv({ CORS_ORIGINS: ALLOWED_ORIGIN, SUPABASE_URL: 'https://ref.supabase.co' })).toThrow(
      /SUPABASE_PUBLISHABLE_KEY/,
    )
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

  it('parses a full configuration', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      CORS_ORIGINS: ' https://app.example.com , http://localhost:5173 ,',
      SUPABASE_URL: 'https://ref.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x',
      SUPABASE_JWT_SECRET: 'x'.repeat(32),
    })
    expect(env).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      CORS_ORIGINS: ['https://app.example.com', 'http://localhost:5173'],
      SUPABASE_URL: 'https://ref.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x',
      SUPABASE_JWT_SECRET: 'x'.repeat(32),
    })
  })

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => parseEnv({ CORS_ORIGINS: ALLOWED_ORIGIN, SUPABASE_JWT_SECRET: 'short' })).toThrow(
      /SUPABASE_JWT_SECRET/,
    )
  })

  it.each(['https://app.example.com/', 'https://app.example.com/path', 'ftp://app.example.com'])(
    'rejects %s as a CORS origin',
    (origin) => {
      expect(() => parseEnv({ CORS_ORIGINS: origin })).toThrow(/CORS_ORIGINS/)
    },
  )

  it('rejects an invalid PORT', () => {
    expect(() => parseEnv({ CORS_ORIGINS: ALLOWED_ORIGIN, PORT: '-1' })).toThrow(/PORT/)
  })
})

describe('parseSeedEnv', () => {
  const valid = {
    SUPABASE_URL: 'https://ref.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x',
    SEED_USER_PASSWORD: 'a-long-enough-password',
  }

  it('parses a valid seed configuration', () => {
    expect(parseSeedEnv(valid)).toEqual({ ...valid, NODE_ENV: 'development' })
  })

  it('requires the service-role key and names the variable', () => {
    expect(() => parseSeedEnv({ ...valid, SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow(
      /Invalid seed configuration:[\s\S]*SUPABASE_SERVICE_ROLE_KEY/,
    )
  })

  it('rejects a short seed password without echoing it', () => {
    const error = (() => {
      try {
        parseSeedEnv({ ...valid, SEED_USER_PASSWORD: 'shortpw' })
      } catch (e) {
        return String(e)
      }
    })()
    expect(error).toMatch(/SEED_USER_PASSWORD: must be at least 8 characters/)
    expect(error).not.toContain('shortpw')
  })
})
