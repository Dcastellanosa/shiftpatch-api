import type { ErrorRequestHandler, RequestHandler } from 'express'
import multer from 'multer'
import { FileStoreError } from '../../../domain/ports/file-store/file-store.js'
import { AuthRateLimitedError, AuthUnavailableError } from '../../../domain/ports/auth-provider/auth-provider.js'
import { DataStoreError, DataUnavailableError } from '../../../domain/ports/data-store/data-store.js'
import { TokenVerifierUnavailableError } from '../../../domain/ports/token-verifier/token-verifier.js'
import { AppError } from '../errors/errors.js'

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Route not found' })
}

/** Maps every error to a safe JSON response. Stack traces and internals never leave the process. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(err.toBody())
    return
  }
  if (err instanceof AuthRateLimitedError) {
    res.status(429).json({ error: err.message })
    return
  }
  if (err instanceof AuthUnavailableError || err instanceof TokenVerifierUnavailableError) {
    res.status(503).json({ error: err.message })
    return
  }
  if (err instanceof DataUnavailableError) {
    res.status(503).json({ error: 'Data service is not available' })
    return
  }
  if (err instanceof DataStoreError) {
    // The message holds only the failing step and a PostgREST error code.
    console.error(`Data store error: ${err.message}`)
    res.status(500).json({ error: 'Internal server error' })
    return
  }
  if (err instanceof FileStoreError) {
    console.error(`File store error: ${err.message}`)
    res.status(503).json({ error: 'File storage is not available' })
    return
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File too large' })
      return
    }
    res.status(400).json({ error: 'Invalid upload' })
    return
  }
  const parserType = (err as { type?: unknown }).type
  if (parserType === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' })
    return
  }
  if (parserType === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large' })
    return
  }

  // Log only the error name and message: never request data, cookies,
  // tokens, headers, or third-party error objects.
  const name = err instanceof Error ? err.name : 'UnknownError'
  const message = err instanceof Error ? err.message : String(err)
  console.error(`Unhandled error: ${name}: ${message}`)
  res.status(500).json({ error: 'Internal server error' })
}
