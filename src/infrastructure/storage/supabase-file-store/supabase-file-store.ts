import { createClient } from '@supabase/supabase-js'
import { FileStoreError, type FileStore } from '../../../domain/ports/file-store/file-store.js'

export interface SupabaseFileStoreConfig {
  url: string
  /** Server-only. The bucket is private; only this client reads or writes it. */
  serviceRoleKey: string
  bucket: string
}

export function createSupabaseFileStore(config: SupabaseFileStoreConfig): FileStore {
  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const bucket = () => client.storage.from(config.bucket)

  return {
    async put(path, bytes, contentType) {
      // Never overwrite: every upload has a fresh object name.
      const { error } = await bucket().upload(path, bytes, { contentType, upsert: false })
      if (error) throw new FileStoreError('upload')
    },

    async remove(path) {
      const { error } = await bucket().remove([path])
      if (error) throw new FileStoreError('removal')
    },
  }
}
