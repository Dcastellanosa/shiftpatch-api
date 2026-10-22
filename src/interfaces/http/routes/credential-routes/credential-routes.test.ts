import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { Profile } from '../../../../domain/viewer/viewer.js'
import { MAX_CREDENTIAL_BYTES } from '../../../../domain/credential/credential.js'
import { FileStoreError } from '../../../../domain/ports/file-store/file-store.js'
import {
  AGENCY_PROFILE,
  ALLOWED_ORIGIN,
  BEARER,
  NURSE_PROFILE,
  credentialFixture,
  fakeDataStore,
  fakeFileStore,
  buildSignedInApp,
} from '../../../../test-support/fakes.js'

const asProfile = (profile: Profile | null) => async () => profile
const PDF = Buffer.from('%PDF-1.4\n%%EOF')

function uploadAs(
  app: ReturnType<typeof buildSignedInApp>,
  file: Buffer | null,
  { filename = 'licence.pdf', contentType = 'application/pdf', ...fields }: Record<string, string>,
) {
  let req = request(app).post('/me/credentials').set('Origin', ALLOWED_ORIGIN).set(BEARER)
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value)
  if (file) req = req.attach('file', file, { filename, contentType })
  return req
}

const nurseApp = (overrides: Parameters<typeof fakeDataStore>[0] = {}, files = fakeFileStore()) =>
  buildSignedInApp(fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), ...overrides }), null, files)

describe('GET /me/credentials', () => {
  it('needs a bearer token', async () => {
    const res = await request(nurseApp()).get('/me/credentials')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required' })
  })

  it('is nurse-only', async () => {
    const store = fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) })
    const res = await request(buildSignedInApp(store, null, fakeFileStore()))
      .get('/me/credentials')
      .set(BEARER)
    expect(res.status).toBe(403)
    expect(Object.keys(res.body)).toEqual(['error'])
    expect(store.listNurseCredentials).not.toHaveBeenCalled()
  })

  it('lists the nurse’s credentials', async () => {
    const credential = credentialFixture()
    const res = await request(nurseApp({ listNurseCredentials: async () => [credential] }))
      .get('/me/credentials')
      .set(BEARER)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ credentials: [credential] })
  })
})

describe('POST /me/credentials', () => {
  const recorded = () => ({
    upsertNurseCredential: async () => ({ outcome: 'recorded' as const, credentialId: credentialFixture().id }),
    listNurseCredentials: async () => [credentialFixture()],
  })

  it('needs a bearer token', async () => {
    const res = await request(nurseApp())
      .post('/me/credentials')
      .set('Origin', ALLOWED_ORIGIN)
      .attach('file', PDF, 'licence.pdf')
    expect(res.status).toBe(401)
  })

  it('rejects an unapproved origin with the one-key envelope before reading the upload', async () => {
    const files = fakeFileStore()
    const res = await request(nurseApp(recorded(), files))
      .post('/me/credentials')
      .set('Origin', 'https://evil.example')
      .set(BEARER)
      .field('expiresAt', '2028-01-01')
      .attach('file', PDF, 'licence.pdf')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Request origin is not allowed' })
    expect(files.put).not.toHaveBeenCalled()
  })

  it('is nurse-only', async () => {
    const files = fakeFileStore()
    const app = buildSignedInApp(fakeDataStore({ getProfile: asProfile(AGENCY_PROFILE) }), null, files)
    const res = await uploadAs(app, PDF, { expiresAt: '2028-01-01' })
    expect(res.status).toBe(403)
    expect(files.put).not.toHaveBeenCalled()
  })

  it('records a PDF with its expiry date and answers 201 with the credential', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), ...recorded() })
    const files = fakeFileStore()
    const res = await uploadAs(buildSignedInApp(store, null, files), PDF, { expiresAt: '2028-01-01' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ credential: credentialFixture() })
    expect(Object.keys(res.body.credential).sort()).toEqual(
      ['id', 'type', 'expiresAt', 'status', 'fileName', 'uploadedAt'].sort(),
    )
    expect(files.put).toHaveBeenCalledWith(expect.stringMatching(/\.pdf$/), expect.any(Uint8Array), 'application/pdf')
    expect(store.upsertNurseCredential).toHaveBeenCalledWith(
      NURSE_PROFILE.id,
      expect.objectContaining({
        credentialTypeCode: 'nursing_license',
        expiresAt: '2028-01-01',
        originalName: 'licence.pdf',
      }),
    )
  })

  it('accepts an explicit credential type', async () => {
    const store = fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), ...recorded() })
    const res = await uploadAs(buildSignedInApp(store, null, fakeFileStore()), PDF, {
      expiresAt: '2028-01-01',
      credentialTypeCode: 'tb_test',
    })
    expect(res.status).toBe(201)
    expect(store.upsertNurseCredential).toHaveBeenCalledWith(
      NURSE_PROFILE.id,
      expect.objectContaining({ credentialTypeCode: 'tb_test' }),
    )
  })

  it('answers 400 when no file is attached', async () => {
    const res = await uploadAs(nurseApp(recorded()), null, { expiresAt: '2028-01-01' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'A file is required' })
  })

  it.each([
    ['a missing expiry date', {}],
    ['a malformed expiry date', { expiresAt: '01/01/2028' }],
    ['an unexpected field', { expiresAt: '2028-01-01', nurseId: 'attacker' }],
    ['a malformed credential type', { expiresAt: '2028-01-01', credentialTypeCode: 'Nursing License' }],
  ])('answers 400 for %s', async (_label, fields) => {
    const files = fakeFileStore()
    const res = await uploadAs(nurseApp(recorded(), files), PDF, fields)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid request body' })
    expect(files.put).not.toHaveBeenCalled()
  })

  it('answers 400 for a file type it does not accept (declared or sniffed)', async () => {
    const files = fakeFileStore()
    const app = nurseApp(recorded(), files)
    const text = await uploadAs(app, Buffer.from('plain text'), {
      expiresAt: '2028-01-01',
      filename: 'notes.txt',
      contentType: 'text/plain',
    })
    expect(text.status).toBe(400)
    expect(text.body).toEqual({ error: 'Unsupported file type' })
    const disguised = await uploadAs(app, Buffer.from('plain text'), { expiresAt: '2028-01-01' })
    expect(disguised.status).toBe(400)
    expect(disguised.body).toEqual({ error: 'Unsupported file type' })
    expect(files.put).not.toHaveBeenCalled()
  })

  it('answers 400 for a file name over 255 characters without storing anything', async () => {
    const files = fakeFileStore()
    const res = await uploadAs(nurseApp(recorded(), files), PDF, {
      expiresAt: '2028-01-01',
      filename: `${'x'.repeat(260)}.pdf`,
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'File name must be between 1 and 255 characters' })
    expect(files.put).not.toHaveBeenCalled()
  })

  it('answers 413 with the JSON envelope for a file over 4 MiB', async () => {
    const big = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1)
    PDF.copy(big)
    const res = await uploadAs(nurseApp(recorded()), big, { expiresAt: '2028-01-01' })
    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: 'File too large' })
  })

  it('answers 400 for an unknown credential type and keeps no file', async () => {
    const files = fakeFileStore()
    const app = nurseApp(
      { upsertNurseCredential: async () => ({ outcome: 'credential_type_not_found', credentialId: null }) },
      files,
    )
    const res = await uploadAs(app, PDF, { expiresAt: '2028-01-01', credentialTypeCode: 'unknown_thing' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Unknown credential type' })
    expect(files.remove).toHaveBeenCalledOnce()
  })

  it('answers 503 when file storage is not configured or unavailable', async () => {
    const noStorage = buildSignedInApp(
      fakeDataStore({ getProfile: asProfile(NURSE_PROFILE), ...recorded() }),
      null,
      null,
    )
    const res = await uploadAs(noStorage, PDF, { expiresAt: '2028-01-01' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'File storage is not available' })

    const failing = fakeFileStore({
      put: async () => {
        throw new FileStoreError('upload')
      },
    })
    const down = await uploadAs(nurseApp(recorded(), failing), PDF, { expiresAt: '2028-01-01' })
    expect(down.status).toBe(503)
    expect(down.body).toEqual({ error: 'File storage is not available' })
  })
})
