import multer from 'multer'
import { MAX_CREDENTIAL_BYTES } from '../../../../domain/credential/credential.js'

/**
 * Reads a single `file` part into memory (never to disk), capped at the
 * credential size limit. Text fields land in `req.body` for validation;
 * anything over the limit becomes a `MulterError` the error handler maps to 413.
 */
export const credentialFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CREDENTIAL_BYTES, files: 1, fields: 2, parts: 3 },
}).single('file')
