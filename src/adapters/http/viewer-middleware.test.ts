import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { ADMIN_PROFILE, NURSE_PROFILE, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { loadViewer, requireRole } from './viewer-middleware.js'

const res = {} as Response

describe('loadViewer', () => {
  it('rejects a request without a validated session', async () => {
    await expect(loadViewer(fakeDataStore())({} as Request, res, vi.fn())).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    })
  })
})

describe('requireRole', () => {
  it('rejects a request without a viewer', () => {
    expect(() => requireRole('admin')({} as Request, res, vi.fn())).toThrow(
      expect.objectContaining({ status: 401, code: 'unauthenticated' }),
    )
  })

  it('rejects a viewer with another role', () => {
    const req = { viewer: viewerFor(NURSE_PROFILE) } as Request
    expect(() => requireRole('agency', 'admin')(req, res, vi.fn())).toThrow(
      expect.objectContaining({ status: 403, code: 'forbidden' }),
    )
  })

  it('accepts a viewer with one of the roles', () => {
    const next = vi.fn()
    requireRole('agency', 'admin')({ viewer: viewerFor(ADMIN_PROFILE) } as Request, res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
