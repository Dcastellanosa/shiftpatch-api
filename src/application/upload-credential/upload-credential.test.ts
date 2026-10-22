import { describe, expect, it } from 'vitest'
import type { CredentialUpload } from '../../domain/credential/credential.js'
import {
  AGENCY_PROFILE,
  NURSE_PROFILE,
  USER,
  credentialFixture,
  fakeDataStore,
  fakeFileStore,
  viewerFor,
} from '../../test-support/fakes.js'
import { uploadCredential } from './upload-credential.js'

const PDF = new TextEncoder().encode('%PDF-1.4 minimal')
const NEW_ID = '9e0c1d3e-0000-4000-8000-000000000042'

const upload = (overrides: Partial<CredentialUpload> = {}): CredentialUpload => ({
  bytes: PDF,
  declaredContentType: 'application/pdf',
  originalName: 'licence.pdf',
  expiresAt: '2028-01-01',
  credentialTypeCode: 'nursing_license',
  ...overrides,
})

const deps = (store = fakeDataStore(), files = fakeFileStore()) => ({ store, files, newId: () => NEW_ID })

describe('uploadCredential', () => {
  it('refuses non-nurses before touching storage or the database', async () => {
    const store = fakeDataStore()
    const files = fakeFileStore()
    await expect(uploadCredential(deps(store, files), viewerFor(AGENCY_PROFILE), upload())).resolves.toEqual({
      ok: false,
      outcome: 'not_a_nurse',
    })
    expect(files.put).not.toHaveBeenCalled()
    expect(store.upsertNurseCredential).not.toHaveBeenCalled()
  })

  it('refuses a file whose bytes do not match the declared type', async () => {
    const files = fakeFileStore()
    const result = await uploadCredential(
      deps(fakeDataStore(), files),
      viewerFor(NURSE_PROFILE),
      upload({ declaredContentType: 'image/png' }),
    )
    expect(result).toEqual({ ok: false, outcome: 'unsupported_file' })
    expect(files.put).not.toHaveBeenCalled()
  })

  it('refuses unrecognised bytes and unsupported declared types', async () => {
    const text = new TextEncoder().encode('just text')
    await expect(
      uploadCredential(deps(), viewerFor(NURSE_PROFILE), upload({ bytes: text, declaredContentType: 'text/plain' })),
    ).resolves.toEqual({ ok: false, outcome: 'unsupported_file' })
  })

  it('refuses a file name that is empty or longer than 255 characters before touching storage', async () => {
    const files = fakeFileStore()
    for (const originalName of ['', 'x'.repeat(256)]) {
      await expect(
        uploadCredential(deps(fakeDataStore(), files), viewerFor(NURSE_PROFILE), upload({ originalName })),
      ).resolves.toEqual({ ok: false, outcome: 'invalid_file_name' })
    }
    expect(files.put).not.toHaveBeenCalled()
  })

  it('refuses a file over 4 MiB', async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1)
    big.set(PDF)
    await expect(uploadCredential(deps(), viewerFor(NURSE_PROFILE), upload({ bytes: big }))).resolves.toEqual({
      ok: false,
      outcome: 'file_too_large',
    })
  })

  it('stores the file under the nurse, then records the credential and returns it', async () => {
    const credential = credentialFixture()
    const store = fakeDataStore({
      upsertNurseCredential: async () => ({ outcome: 'recorded', credentialId: credential.id }),
      listNurseCredentials: async () => [credential],
    })
    const files = fakeFileStore()
    const result = await uploadCredential(deps(store, files), viewerFor(NURSE_PROFILE), upload())

    expect(result).toEqual({ ok: true, credential })
    const path = `${USER.id}/nursing_license/${NEW_ID}.pdf`
    expect(files.put).toHaveBeenCalledWith(path, PDF, 'application/pdf')
    expect(store.upsertNurseCredential).toHaveBeenCalledWith(USER.id, {
      credentialTypeCode: 'nursing_license',
      expiresAt: '2028-01-01',
      filePath: path,
      originalName: 'licence.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.byteLength,
    })
    expect(files.put.mock.invocationCallOrder[0]!).toBeLessThan(
      store.upsertNurseCredential.mock.invocationCallOrder[0]!,
    )
  })

  it('removes the stored file when the database refuses the credential', async () => {
    const store = fakeDataStore({
      upsertNurseCredential: async () => ({ outcome: 'credential_type_not_found', credentialId: null }),
    })
    const files = fakeFileStore()
    await expect(uploadCredential(deps(store, files), viewerFor(NURSE_PROFILE), upload())).resolves.toEqual({
      ok: false,
      outcome: 'credential_type_not_found',
    })
    expect(files.remove).toHaveBeenCalledWith(`${USER.id}/nursing_license/${NEW_ID}.pdf`)
  })

  it('removes the stored file and rethrows when the database call throws', async () => {
    const boom = new Error('rpc exploded')
    const store = fakeDataStore({
      upsertNurseCredential: async () => {
        throw boom
      },
    })
    const files = fakeFileStore()
    await expect(uploadCredential(deps(store, files), viewerFor(NURSE_PROFILE), upload())).rejects.toBe(boom)
    expect(files.remove).toHaveBeenCalledWith(`${USER.id}/nursing_license/${NEW_ID}.pdf`)
  })

  it('reports the original failure even when the compensating removal fails', async () => {
    const boom = new Error('rpc exploded')
    const store = fakeDataStore({
      upsertNurseCredential: async () => {
        throw boom
      },
    })
    const files = fakeFileStore({
      remove: async () => {
        throw new Error('storage down')
      },
    })
    await expect(uploadCredential(deps(store, files), viewerFor(NURSE_PROFILE), upload())).rejects.toBe(boom)
    expect(files.remove).toHaveBeenCalledOnce()
  })
})
