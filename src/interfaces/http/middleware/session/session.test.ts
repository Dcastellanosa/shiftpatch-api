import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { SESSION } from '../../../../test-support/fakes.js'
import { requireSession, resolveSession } from './session.js'

describe('resolveSession', () => {
  it('reports auth as unavailable when cookies are present but no provider is configured', async () => {
    const req = { cookies: { sp_access: SESSION.accessToken } } as unknown as Request
    await expect(resolveSession(null, { secure: false })(req, {} as Response, vi.fn())).rejects.toMatchObject({
      status: 503,
      code: 'auth_unavailable',
    })
  })

  it('passes through anonymous requests without a provider', async () => {
    const next = vi.fn()
    await resolveSession(null, { secure: false })({ cookies: {} } as Request, {} as Response, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('requireSession', () => {
  it('rejects a request without req.auth', () => {
    expect(() => requireSession({} as Request, {} as Response, vi.fn())).toThrow(
      expect.objectContaining({ status: 401 }),
    )
  })
})
