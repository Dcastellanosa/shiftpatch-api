import type { RequestHandler } from 'express'
import type { ZodType, z } from 'zod'
import { AppError } from '../../errors/errors.js'

/** Field-level issues stay server-side: the envelope is only `{ error }` and input is never echoed. */
const validationError = (message: string) => new AppError(400, message)

/** Replaces `req.body` with the parsed value, or responds 400. Input values are never echoed. */
export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) throw validationError('Invalid request body')
    req.body = result.data
    next()
  }
}

/** Parses route params or a query string, or throws a 400. Input values are never echoed. */
export function parseInput<S extends ZodType>(schema: S, input: unknown, label: 'query' | 'params'): z.infer<S> {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw validationError(label === 'query' ? 'Invalid query parameters' : 'Invalid path parameters')
  }
  return result.data
}
