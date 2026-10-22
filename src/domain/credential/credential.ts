/**
 * Nurse credential documents (licences, screenings). A credential is a
 * stored file plus its expiry date; the claim rules compare the expiry date
 * with the shift date, so an expired document blocks claims.
 */

export const CREDENTIAL_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const
export type CredentialContentType = (typeof CREDENTIAL_CONTENT_TYPES)[number]

/** Below the hosting platform's 4.5 MB request limit, so an oversized file is refused by this API with its envelope. */
export const MAX_CREDENTIAL_BYTES = 4 * 1024 * 1024

/** The stored `original_name` column accepts 1 to 255 characters. */
export const MAX_FILE_NAME_LENGTH = 255

export const CREDENTIAL_STATUSES = ['valid', 'expired', 'revoked'] as const
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number]

export interface NurseCredential {
  id: string
  /** Credential type code, e.g. `nursing_license`. */
  type: string
  /** YYYY-MM-DD. */
  expiresAt: string
  status: CredentialStatus
  fileName: string | null
  uploadedAt: string | null
}

/** What a nurse submits: the file bytes with what the client claimed about them, plus the metadata. */
export interface CredentialUpload {
  bytes: Uint8Array
  declaredContentType: string
  originalName: string
  expiresAt: string
  credentialTypeCode: string
}

export const EXTENSION_FOR: Record<CredentialContentType, 'pdf' | 'png' | 'jpg'> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46] // %PDF

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte)

/** The content type the bytes really are, by magic number; `null` when they are none of the accepted types. */
export function detectCredentialContentType(bytes: Uint8Array): CredentialContentType | null {
  if (startsWith(bytes, PDF_SIGNATURE)) return 'application/pdf'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  return null
}
