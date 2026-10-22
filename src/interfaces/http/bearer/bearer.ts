import type { Request } from 'express'

// Tokens are opaque to this service, but anything outside this shape is
// treated as a malformed credential and never handed to the verifier.
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,4096}$/

export type BearerHeader = { kind: 'missing' } | { kind: 'malformed' } | { kind: 'token'; token: string }

/** Reads `Authorization: Bearer <token>`, the only credential this API accepts. */
export function readBearer(req: Request): BearerHeader {
  const header = req.get('authorization')
  if (header === undefined) return { kind: 'missing' }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = match?.[1]
  return token && TOKEN_PATTERN.test(token) ? { kind: 'token', token } : { kind: 'malformed' }
}
