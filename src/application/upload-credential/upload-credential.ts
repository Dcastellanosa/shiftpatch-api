import {
  detectCredentialContentType,
  EXTENSION_FOR,
  MAX_CREDENTIAL_BYTES,
  type CredentialUpload,
  type NurseCredential,
} from '../../domain/credential/credential.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { FileStore } from '../../domain/ports/file-store/file-store.js'
import type { CredentialOutcome } from '../../domain/outcomes/outcomes.js'
import type { Viewer } from '../../domain/viewer/viewer.js'
import { listCredentials } from '../list-credentials/list-credentials.js'

export type UploadCredentialFailure = Exclude<CredentialOutcome, 'recorded'> | 'unsupported_file' | 'file_too_large'

export type UploadCredentialResult =
  { ok: true; credential: NurseCredential } | { ok: false; outcome: UploadCredentialFailure }

export interface UploadCredentialDependencies {
  store: DataStore
  files: FileStore
  /** Fresh random id for the stored object's name. */
  newId: () => string
}

/**
 * Stores a nurse's credential document and records its expiry. The file is
 * validated by its bytes (not only by what the client declared), written
 * under the nurse's own prefix, then the database row is upserted. If the
 * database refuses or fails after the upload, the object is removed again
 * so no orphaned document stays in storage.
 */
export async function uploadCredential(
  { store, files, newId }: UploadCredentialDependencies,
  viewer: Viewer,
  upload: CredentialUpload,
): Promise<UploadCredentialResult> {
  if (viewer.role !== 'nurse') return { ok: false, outcome: 'not_a_nurse' }
  if (upload.bytes.byteLength > MAX_CREDENTIAL_BYTES) return { ok: false, outcome: 'file_too_large' }
  const contentType = detectCredentialContentType(upload.bytes)
  if (!contentType || contentType !== upload.declaredContentType) return { ok: false, outcome: 'unsupported_file' }

  const path = `${viewer.id}/${upload.credentialTypeCode}/${newId()}.${EXTENSION_FOR[contentType]}`
  await files.put(path, upload.bytes, contentType)

  let result
  try {
    result = await store.upsertNurseCredential(viewer.id, {
      credentialTypeCode: upload.credentialTypeCode,
      expiresAt: upload.expiresAt,
      filePath: path,
      originalName: upload.originalName,
      contentType,
      sizeBytes: upload.bytes.byteLength,
    })
  } catch (error) {
    await compensate(files, path)
    throw error
  }
  if (result.outcome !== 'recorded') {
    await compensate(files, path)
    return { ok: false, outcome: result.outcome }
  }

  const credentials = await listCredentials({ store }, viewer, new Date())
  const credential = credentials.find((c) => c.id === result.credentialId)
  if (!credential) return { ok: false, outcome: 'credential_type_not_found' }
  return { ok: true, credential }
}

/** Best effort: the original failure is what the caller must see. */
async function compensate(files: FileStore, path: string) {
  try {
    await files.remove(path)
  } catch {
    // The orphaned object is reported through the original error; nothing else to do here.
  }
}
