import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../domain/ports/auth-provider/index.js'
import { DataStoreError, DataUnavailableError } from '../../../domain/ports/data-store/index.js'
import { errorHandler } from './error-handler.js'
import { AppError } from '../errors/index.js'

function handle(err: unknown) {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  errorHandler(err, {} as Request, res as unknown as Response, vi.fn() as NextFunction)
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('errorHandler', () => {
  it('renders AppError with its status, code and details', () => {
    expect(handle(new AppError(409, 'conflict', 'Taken', [{ path: 'x' }]))).toEqual({
      status: 409,
      body: { error: { code: 'conflict', message: 'Taken', details: [{ path: 'x' }] } },
    })
  })

  it.each([
    [new AuthRateLimitedError(), 429, 'rate_limited'],
    [new AuthUnavailableError(), 503, 'auth_unavailable'],
    [new DataUnavailableError(), 503, 'data_unavailable'],
  ])('maps %s to %i', (err, status, code) => {
    const result = handle(err)
    expect(result.status).toBe(status)
    expect(result.body.error.code).toBe(code)
  })

  it('logs only the safe message of a DataStoreError and returns a generic 500', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(handle(new DataStoreError('list shifts failed (42501)'))).toEqual({
      status: 500,
      body: { error: { code: 'internal_error', message: 'Internal server error' } },
    })
    expect(log).toHaveBeenCalledWith('Data store error: list shifts failed (42501)')
  })

  it.each([
    ['entity.parse.failed', 400, 'invalid_json'],
    ['entity.too.large', 413, 'payload_too_large'],
  ])('maps body-parser %s to %i', (type, status, code) => {
    const result = handle(Object.assign(new Error('parser'), { type }))
    expect(result.status).toBe(status)
    expect(result.body.error.code).toBe(code)
  })

  it('hides unknown errors behind a generic 500 and logs only name and message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = handle(new TypeError('boom'))
    expect(result).toEqual({ status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } } })
    expect(JSON.stringify(result.body)).not.toContain('boom')
    expect(log).toHaveBeenCalledWith('Unhandled error: TypeError: boom')
  })

  it('handles non-Error throwables', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(handle('plain string').status).toBe(500)
    expect(log).toHaveBeenCalledWith('Unhandled error: UnknownError: plain string')
  })
})
