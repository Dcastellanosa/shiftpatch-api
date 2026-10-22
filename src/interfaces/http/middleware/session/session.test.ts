import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { SESSION, USER, fakeTokenVerifier } from '../../../../test-support/fakes.js'
import { requireSession, resolveSession } from './session.js'

const request = (authorization?: string) => ({ get: () => authorization }) as unknown as Request

describe('resolveSession', () => {
  it('passes anonymous requests through without req.auth', async () => {
    const next = vi.fn()
    const req = request()
    await resolveSession(fakeTokenVerifier())(req, {} as Response, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.auth).toBeUndefined()
  })

  it('rejects a malformed header without consulting the verifier', async () => {
    const verifier = fakeTokenVerifier()
    for (const header of ['Bearer', 'Basic abc', 'Bearer a b']) {
      await expect(resolveSession(verifier)(request(header), {} as Response, vi.fn())).rejects.toMatchObject({
        status: 401,
        message: 'Invalid or expired token',
      })
    }
    expect(verifier.verify).not.toHaveBeenCalled()
  })

  it('rejects a token the verifier does not accept', async () => {
    const verifier = fakeTokenVerifier()
    await expect(
      resolveSession(verifier)(request(`Bearer ${SESSION.accessToken}`), {} as Response, vi.fn()),
    ).rejects.toMatchObject({ status: 401, message: 'Invalid or expired token' })
    expect(verifier.verify).toHaveBeenCalledWith(SESSION.accessToken)
  })

  it('sets req.auth from a verified token', async () => {
    const next = vi.fn()
    const req = request(`Bearer ${SESSION.accessToken}`)
    await resolveSession(fakeTokenVerifier({ verify: async () => USER }))(req, {} as Response, next)
    expect(req.auth).toEqual({ user: USER, accessToken: SESSION.accessToken })
    expect(next).toHaveBeenCalledOnce()
  })

  it('reports auth as unavailable when a token is sent but no verifier is configured', async () => {
    await expect(
      resolveSession(null)(request(`Bearer ${SESSION.accessToken}`), {} as Response, vi.fn()),
    ).rejects.toMatchObject({ status: 503, message: 'Authentication is not available' })
  })

  it('passes anonymous requests through without a verifier', async () => {
    const next = vi.fn()
    await resolveSession(null)(request(), {} as Response, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('requireSession', () => {
  it('rejects a request without req.auth', () => {
    expect(() => requireSession({} as Request, {} as Response, vi.fn())).toThrow(
      expect.objectContaining({ status: 401, message: 'Authentication required' }),
    )
  })
})
