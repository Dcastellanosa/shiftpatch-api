import { describe, expect, it } from 'vitest'
import { detectCredentialContentType, MAX_CREDENTIAL_BYTES } from './credential.js'

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF')
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

describe('detectCredentialContentType', () => {
  it('recognises PDF, PNG and JPEG by their magic bytes', () => {
    expect(detectCredentialContentType(PDF)).toBe('application/pdf')
    expect(detectCredentialContentType(PNG)).toBe('image/png')
    expect(detectCredentialContentType(JPEG)).toBe('image/jpeg')
  })

  it('rejects anything else, including empty and truncated files', () => {
    expect(detectCredentialContentType(new Uint8Array())).toBeNull()
    expect(detectCredentialContentType(new TextEncoder().encode('hello'))).toBeNull()
    expect(detectCredentialContentType(PNG.slice(0, 4))).toBeNull()
    expect(detectCredentialContentType(new TextEncoder().encode('<script>'))).toBeNull()
  })

  it('caps uploads at 5 MiB', () => {
    expect(MAX_CREDENTIAL_BYTES).toBe(5 * 1024 * 1024)
  })
})
