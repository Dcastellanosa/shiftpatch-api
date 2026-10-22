import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStoreError } from '../../../domain/ports/file-store/file-store.js'
import { createSupabaseFileStore } from './supabase-file-store.js'

const supabase = vi.hoisted(() => ({
  createClient: vi.fn(),
  bucket: { upload: vi.fn(), remove: vi.fn() },
  from: vi.fn(),
}))

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: supabase.createClient,
}))

const CONFIG = { url: 'https://ref.supabase.co', serviceRoleKey: 'sb_secret_test', bucket: 'shiftpatch-credentials' }
const BYTES = new TextEncoder().encode('%PDF-1.4')

beforeEach(() => {
  vi.resetAllMocks()
  supabase.from.mockReturnValue(supabase.bucket)
  supabase.createClient.mockReturnValue({ storage: { from: supabase.from } })
})

describe('createSupabaseFileStore', () => {
  it('uploads into the private bucket with the service-role client, never overwriting', async () => {
    supabase.bucket.upload.mockResolvedValue({ data: { path: 'x' }, error: null })
    await createSupabaseFileStore(CONFIG).put('nurse/nursing_license/1.pdf', BYTES, 'application/pdf')

    expect(supabase.createClient).toHaveBeenCalledWith(
      CONFIG.url,
      CONFIG.serviceRoleKey,
      expect.objectContaining({
        auth: expect.objectContaining({ persistSession: false }),
      }),
    )
    expect(supabase.from).toHaveBeenCalledWith('shiftpatch-credentials')
    expect(supabase.bucket.upload).toHaveBeenCalledWith('nurse/nursing_license/1.pdf', BYTES, {
      contentType: 'application/pdf',
      upsert: false,
    })
  })

  it('maps an upload failure to FileStoreError without the provider error', async () => {
    supabase.bucket.upload.mockResolvedValue({ data: null, error: { message: 'bucket missing', statusCode: '404' } })
    await expect(createSupabaseFileStore(CONFIG).put('p', BYTES, 'image/png')).rejects.toSatisfy(
      (e) => e instanceof FileStoreError && !e.message.includes('bucket missing'),
    )
  })

  it('removes an object by path', async () => {
    supabase.bucket.remove.mockResolvedValue({ data: [], error: null })
    await createSupabaseFileStore(CONFIG).remove('nurse/nursing_license/1.pdf')
    expect(supabase.bucket.remove).toHaveBeenCalledWith(['nurse/nursing_license/1.pdf'])
  })

  it('maps a removal failure to FileStoreError', async () => {
    supabase.bucket.remove.mockResolvedValue({ data: null, error: { message: 'nope' } })
    await expect(createSupabaseFileStore(CONFIG).remove('p')).rejects.toBeInstanceOf(FileStoreError)
  })
})
