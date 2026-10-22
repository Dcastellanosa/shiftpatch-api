import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { requireTrustedOrigin } from './origin-check.js'

const ALLOWED = 'https://app.example.com'
const check = requireTrustedOrigin(new Set([ALLOWED]))

function run(method: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  const req = { method, get: (name: string) => lower[name.toLowerCase()] } as unknown as Request
  const next = vi.fn()
  try {
    check(req, {} as Response, next)
    return { passed: next.mock.calls.length === 1 }
  } catch (error) {
    return { passed: false, message: (error as { message?: string }).message }
  }
}

describe('requireTrustedOrigin', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('lets safe method %s through regardless of origin', (method) => {
    expect(run(method, { Origin: 'https://evil.example' })).toEqual({ passed: true })
  })

  it('accepts an allowed origin', () => {
    expect(run('POST', { Origin: ALLOWED })).toEqual({ passed: true })
  })

  it('rejects an origin that only shares a prefix with an allowed one', () => {
    expect(run('POST', { Origin: `${ALLOWED}.evil.example` })).toEqual({
      passed: false,
      message: 'Request origin is not allowed',
    })
  })

  it.each<Record<string, string>>([{ 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Mode': 'cors' }])(
    'requires Origin on browser requests (%o)',
    (headers) => {
      expect(run('DELETE', headers)).toEqual({ passed: false, message: 'Origin header is required' })
    },
  )

  it('lets non-browser clients without Origin through', () => {
    expect(run('POST')).toEqual({ passed: true })
  })
})
