import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../domain/ports/auth-provider/auth-provider.js'
import { DataStoreError, DataUnavailableError } from '../../../domain/ports/data-store/data-store.js'
import { TokenVerifierUnavailableError } from '../../../domain/ports/token-verifier/token-verifier.js'
import { errorHandler } from './error-handler.js'
import { AppError } from '../errors/errors.js'

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
  it('renders AppError as its status and the one-key { error } envelope', () => {
    expect(handle(new AppError(409, 'Taken'))).toEqual({ status: 409, body: { error: 'Taken' } })
  })

  it.each([
    [new AuthRateLimitedError(), 429, 'Too many authentication attempts'],
    [new AuthUnavailableError(), 503, 'Authentication service unavailable'],
    [new TokenVerifierUnavailableError(), 503, 'Authentication is not available'],
    [new DataUnavailableError(), 503, 'Data service is not available'],
  ])('maps %s to %i with a one-key envelope', (err, status, error) => {
    expect(handle(err)).toEqual({ status, body: { error } })
  })

  it('logs only the safe message of a DataStoreError and returns a generic 500', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(handle(new DataStoreError('list shifts failed (42501)'))).toEqual({
      status: 500,
      body: { error: 'Internal server error' },
    })
    expect(log).toHaveBeenCalledWith('Data store error: list shifts failed (42501)')
  })

  it.each([
    ['entity.parse.failed', 400, 'Malformed JSON body'],
    ['entity.too.large', 413, 'Request body too large'],
  ])('maps body-parser %s to %i', (type, status, error) => {
    expect(handle(Object.assign(new Error('parser'), { type }))).toEqual({ status, body: { error } })
  })

  it('hides unknown errors behind a generic 500 and logs only name and message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = handle(new TypeError('boom'))
    expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(JSON.stringify(result.body)).not.toContain('boom')
    expect(log).toHaveBeenCalledWith('Unhandled error: TypeError: boom')
  })

  it('handles non-Error throwables', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(handle('plain string').status).toBe(500)
    expect(log).toHaveBeenCalledWith('Unhandled error: UnknownError: plain string')
  })
})
