import type { ErrorRequestHandler, RequestHandler } from 'express'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../domain/ports/auth-provider/auth-provider.js'
import { DataStoreError, DataUnavailableError } from '../../../domain/ports/data-store/data-store.js'
import { AppError } from '../errors/errors.js'

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } })
}

/** Maps every error to a safe JSON response. Stack traces and internals never leave the process. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(err.toBody())
    return
  }
  if (err instanceof AuthRateLimitedError) {
    res.status(429).json({ error: { code: 'rate_limited', message: err.message } })
    return
  }
  if (err instanceof AuthUnavailableError) {
    res.status(503).json({ error: { code: 'auth_unavailable', message: err.message } })
    return
  }
  if (err instanceof DataUnavailableError) {
    res.status(503).json({ error: { code: 'data_unavailable', message: 'Data service is not available' } })
    return
  }
  if (err instanceof DataStoreError) {
    // The message holds only the failing step and a PostgREST error code.
    console.error(`Data store error: ${err.message}`)
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } })
    return
  }
  const parserType = (err as { type?: unknown }).type
  if (parserType === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } })
    return
  }
  if (parserType === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } })
    return
  }

  // Log only the error name and message: never request data, cookies,
  // tokens, headers, or third-party error objects.
  const name = err instanceof Error ? err.name : 'UnknownError'
  const message = err instanceof Error ? err.message : String(err)
  console.error(`Unhandled error: ${name}: ${message}`)
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } })
}
