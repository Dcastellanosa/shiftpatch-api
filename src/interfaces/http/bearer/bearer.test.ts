import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { readBearer } from './bearer.js'

const request = (authorization?: string) => ({ get: () => authorization }) as unknown as Request

describe('readBearer', () => {
  it('reports a missing Authorization header', () => {
    expect(readBearer(request())).toEqual({ kind: 'missing' })
  })

  it('reads a well-formed bearer token, case-insensitively', () => {
    expect(readBearer(request('Bearer abc.def-ghi'))).toEqual({ kind: 'token', token: 'abc.def-ghi' })
    expect(readBearer(request('bearer abc'))).toEqual({ kind: 'token', token: 'abc' })
  })

  it.each(['Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'Bearer ' + 'x'.repeat(4097), 'Bearer <script>'])(
    'reports %j as malformed',
    (header) => {
      expect(readBearer(request(header))).toEqual({ kind: 'malformed' })
    },
  )
})
