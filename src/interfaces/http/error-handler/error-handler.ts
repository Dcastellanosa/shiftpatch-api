import type { ErrorRequestHandler, RequestHandler } from 'express'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../domain/ports/auth-provider/auth-provider.js'
import { DataStoreError, DataUnavailableError } from '../../../domain/ports/data-store/data-store.js'
import { TokenVerifierUnavailableError } from '../../../domain/ports/token-verifier/token-verifier.js'
import { AppError } from '../errors/errors.js'

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'not_found' })
}

/** Maps every error to a safe JSON response. Stack traces and internals never leave the process. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(err.toBody())
    return
  }
  if (err instanceof AuthRateLimitedError) {
    res.status(429).json({ error: err.message, code: 'rate_limited' })
    return
  }
  if (err instanceof AuthUnavailableError || err instanceof TokenVerifierUnavailableError) {
    res.status(503).json({ error: err.message, code: 'auth_unavailable' })
    return
  }
  if (err instanceof DataUnavailableError) {
    res.status(503).json({ error: 'Data service is not available', code: 'data_unavailable' })
    return
  }
  if (err instanceof DataStoreError) {
    // The message holds only the failing step and a PostgREST error code.
    console.error(`Data store error: ${err.message}`)
    res.status(500).json({ error: 'Internal server error', code: 'internal_error' })
    return
  }
  const parserType = (err as { type?: unknown }).type
  if (parserType === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body', code: 'invalid_json' })
    return
  }
  if (parserType === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large', code: 'payload_too_large' })
    return
  }

  // Log only the error name and message: never request data, cookies,
  // tokens, headers, or third-party error objects.
  const name = err instanceof Error ? err.name : 'UnknownError'
  const message = err instanceof Error ? err.message : String(err)
  console.error(`Unhandled error: ${name}: ${message}`)
  res.status(500).json({ error: 'Internal server error', code: 'internal_error' })
}
