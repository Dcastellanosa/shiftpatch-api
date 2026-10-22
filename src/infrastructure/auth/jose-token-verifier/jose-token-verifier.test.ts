import {
  SignJWT,
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TokenVerifierUnavailableError } from '../../../domain/ports/token-verifier/token-verifier.js'
import { createJoseTokenVerifier } from './jose-token-verifier.js'

const SUPABASE_URL = 'http://127.0.0.1:55321'
const ISSUER = `${SUPABASE_URL}/auth/v1`
const SECRET = 'unit-test-only-secret-with-at-least-32-characters'
const SUB = '7c1e0d52-0000-4000-8000-000000000001'

let privateKey: CryptoKey
let otherPrivateKey: CryptoKey
let jwks: JWTVerifyGetKey

interface Claims {
  issuer?: string
  audience?: string
  sub?: string
  expiresIn?: string
  email?: string
}

async function es256(claims: Claims = {}, key: CryptoKey = privateKey) {
  return new SignJWT({ email: claims.email ?? 'maria.lopez@example.com' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(claims.issuer ?? ISSUER)
    .setAudience(claims.audience ?? 'authenticated')
    .setSubject(claims.sub ?? SUB)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '1h')
    .sign(key)
}

async function hs256(claims: Claims = {}, secret = SECRET) {
  return new SignJWT({ email: claims.email ?? 'maria.lopez@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(claims.issuer ?? ISSUER)
    .setAudience(claims.audience ?? 'authenticated')
    .setSubject(claims.sub ?? SUB)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(secret))
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  otherPrivateKey = (await generateKeyPair('ES256')).privateKey
  const jwk = await exportJWK(pair.publicKey)
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] })
})

const verifier = () => createJoseTokenVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: SECRET, jwks })

describe('createJoseTokenVerifier', () => {
  it('accepts a token signed with the project signing key (JWKS)', async () => {
    await expect(verifier().verify(await es256())).resolves.toEqual({ id: SUB, email: 'maria.lopez@example.com' })
  })

  it('accepts a token signed with the shared secret (HS256)', async () => {
    await expect(verifier().verify(await hs256())).resolves.toEqual({ id: SUB, email: 'maria.lopez@example.com' })
  })

  it('reports a missing email claim as null', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setSubject(SUB)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET))
    await expect(verifier().verify(token)).resolves.toEqual({ id: SUB, email: null })
  })

  it('rejects an expired token', async () => {
    await expect(verifier().verify(await es256({ expiresIn: '-1m' }))).resolves.toBeNull()
    await expect(verifier().verify(await hs256({ expiresIn: '-1m' }))).resolves.toBeNull()
  })

  it('rejects a token from another issuer', async () => {
    await expect(verifier().verify(await es256({ issuer: 'https://evil.example/auth/v1' }))).resolves.toBeNull()
  })

  it('rejects a token for another audience', async () => {
    await expect(verifier().verify(await hs256({ audience: 'anon' }))).resolves.toBeNull()
  })

  it('rejects a token signed with an unknown key', async () => {
    await expect(verifier().verify(await es256({}, otherPrivateKey))).resolves.toBeNull()
  })

  it('rejects a token signed with another secret', async () => {
    await expect(
      verifier().verify(await hs256({}, 'another-secret-that-is-also-32-characters-long')),
    ).resolves.toBeNull()
  })

  it('rejects HS256 tokens when no secret is configured', async () => {
    const noSecret = createJoseTokenVerifier({ supabaseUrl: SUPABASE_URL, jwks })
    await expect(noSecret.verify(await hs256())).resolves.toBeNull()
    await expect(noSecret.verify(await es256())).resolves.not.toBeNull()
  })

  it('rejects unsigned and malformed tokens', async () => {
    const unsigned = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(SUB)
      .sign(new TextEncoder().encode(SECRET))
    const [header, payload] = unsigned.split('.')
    const noneAlg = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`
    await expect(verifier().verify(noneAlg)).resolves.toBeNull()
    await expect(verifier().verify(`${header}.${payload}.`)).resolves.toBeNull()
    await expect(verifier().verify('not-a-jwt')).resolves.toBeNull()
    await expect(verifier().verify('')).resolves.toBeNull()
  })

  it('rejects a subject that is not a UUID', async () => {
    await expect(verifier().verify(await hs256({ sub: 'nurse-1' }))).resolves.toBeNull()
  })

  it('reports an unreachable key set as unavailable, not as a rejection', async () => {
    const failing = createJoseTokenVerifier({
      supabaseUrl: SUPABASE_URL,
      jwks: vi.fn(async () => {
        throw new errors.JWKSTimeout()
      }),
    })
    await expect(failing.verify(await es256())).rejects.toBeInstanceOf(TokenVerifierUnavailableError)
  })

  it('fetches the project JWKS from the Supabase auth endpoint by default', async () => {
    const jwk = await exportJWK((await generateKeyPair('ES256')).publicKey)
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const remote = createJoseTokenVerifier({ supabaseUrl: SUPABASE_URL })
      // The served key is not the signing key: the signature check runs against the fetched set and rejects.
      await expect(remote.verify(await es256())).resolves.toBeNull()
      expect(fetchSpy).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports an unreachable JWKS endpoint as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    try {
      const remote = createJoseTokenVerifier({ supabaseUrl: SUPABASE_URL })
      await expect(remote.verify(await es256())).rejects.toBeInstanceOf(TokenVerifierUnavailableError)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
