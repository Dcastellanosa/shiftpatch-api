/**
 * Driven port: private object storage for uploaded documents. Paths are
 * opaque keys chosen by the application; nothing here is reachable by
 * clients directly.
 */
export interface FileStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>
  remove(path: string): Promise<void>
}

/** A storage failure. The message names only the failing step, never provider details. */
export class FileStoreError extends Error {
  constructor(step: string) {
    super(`File storage ${step} failed`)
    this.name = 'FileStoreError'
  }
}
