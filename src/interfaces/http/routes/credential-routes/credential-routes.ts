import { randomUUID } from 'node:crypto'
import { Router, type RequestHandler } from 'express'
import { listCredentials } from '../../../../application/list-credentials/list-credentials.js'
import {
  uploadCredential,
  type UploadCredentialFailure,
} from '../../../../application/upload-credential/upload-credential.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import type { FileStore } from '../../../../domain/ports/file-store/file-store.js'
import { AppError } from '../../errors/errors.js'
import { credentialFile } from '../../middleware/upload/upload.js'
import { validateBody } from '../../middleware/validate/validate.js'
import { loadViewer, requireRole } from '../../middleware/viewer/viewer.js'
import { uploadCredentialFields, type UploadCredentialFields } from '../../schemas/credentials/credentials.js'

const storageUnavailable = () => new AppError(503, 'File storage is not available')

const UPLOAD_ERRORS: Record<UploadCredentialFailure, () => AppError> = {
  not_a_nurse: () => new AppError(403, 'Only nurses can upload credentials'),
  credential_type_not_found: () => new AppError(400, 'Unknown credential type'),
  unsupported_file: () => new AppError(400, 'Unsupported file type'),
  file_too_large: () => new AppError(413, 'File too large'),
}

export interface CredentialRouterDependencies {
  store: DataStore | null
  /** `null` when no service-role key is configured: uploads answer 503. */
  files: FileStore | null
}

/**
 * A nurse's own credential documents. Uploads are API-mediated: the browser
 * never touches storage, the server validates type and size by the bytes,
 * stores the object in a private bucket and records the metadata.
 */
export function createCredentialRouter({ store, files }: CredentialRouterDependencies, authenticate: RequestHandler[]) {
  const router = Router()
  const asNurse = [...authenticate, loadViewer(store), requireRole('nurse')]

  router.get('/me/credentials', ...asNurse, async (req, res) => {
    res.json({ credentials: await listCredentials({ store: store! }, req.viewer!, new Date()) })
  })

  router.post('/me/credentials', ...asNurse, credentialFile, validateBody(uploadCredentialFields), async (req, res) => {
    if (!req.file) throw new AppError(400, 'A file is required')
    if (!files) throw storageUnavailable()
    const fields = req.body as UploadCredentialFields
    const result = await uploadCredential({ store: store!, files, newId: randomUUID }, req.viewer!, {
      bytes: new Uint8Array(req.file.buffer),
      declaredContentType: req.file.mimetype,
      originalName: req.file.originalname,
      expiresAt: fields.expiresAt,
      credentialTypeCode: fields.credentialTypeCode,
    })
    if (!result.ok) throw UPLOAD_ERRORS[result.outcome]()
    res.status(201).json({ credential: result.credential })
  })

  return router
}
