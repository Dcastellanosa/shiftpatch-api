import type { RequestHandler } from 'express'
import type { ZodType } from 'zod'
import { AppError } from './errors.js'

/** Replaces `req.body` with the parsed value, or responds 400. Input values are never echoed. */
export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      throw new AppError(
        400,
        'validation_error',
        'Invalid request body',
        result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      )
    }
    req.body = result.data
    next()
  }
}
