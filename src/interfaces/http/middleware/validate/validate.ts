import type { RequestHandler } from 'express'
import type { ZodType, z } from 'zod'
import { AppError } from '../../errors/errors.js'

function validationError(message: string, issues: z.core.$ZodIssue[]) {
  return new AppError(
    400,
    'validation_error',
    message,
    issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  )
}

/** Replaces `req.body` with the parsed value, or responds 400. Input values are never echoed. */
export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) throw validationError('Invalid request body', result.error.issues)
    req.body = result.data
    next()
  }
}

/** Parses route params or a query string, or throws a 400. Input values are never echoed. */
export function parseInput<S extends ZodType>(schema: S, input: unknown, label: 'query' | 'params'): z.infer<S> {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw validationError(label === 'query' ? 'Invalid query parameters' : 'Invalid path parameters', result.error.issues)
  }
  return result.data
}
