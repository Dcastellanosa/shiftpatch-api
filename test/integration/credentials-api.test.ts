import { createClient } from '@supabase/supabase-js'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { USERS as TRIAL_USERS } from '../../scripts/seed-data.js'
import { ALLOWED_ORIGIN, USERS, buildRealApp, openPool, signIn } from './helpers.js'

/**
 * Credential uploads end to end against the local stack: the API validates
 * the bytes, stores the object in the private bucket with its service-role
 * client and records the row; nothing else can reach the bucket.
 */

type Agent = Awaited<ReturnType<typeof signIn>>

const app = buildRealApp()
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')
let pool: Pool
let james: Agent
let maria: Agent
let sunrise: Agent

const upload = (agent: Agent, fields: Record<string, string>, file: Buffer | null = PDF, filename = 'licence.pdf') => {
  let req = agent.post('/me/credentials').set('Origin', ALLOWED_ORIGIN)
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value)
  if (file) req = req.attach('file', file, { filename, contentType: 'application/pdf' })
  return req
}

beforeAll(async () => {
  pool = openPool()
  james = await signIn(app, TRIAL_USERS.james)
  maria = await signIn(app, TRIAL_USERS.maria)
  sunrise = await signIn(app, TRIAL_USERS.sunriseAgency)
})

/** Leaves the trial rows as seeded for the files that run afterwards (James's licence expired on 2026-06-01). */
afterAll(async () => {
  await pool.query(
    `update shiftpatch.nurse_credentials
     set expires_at = '2026-06-01', issued_at = '2022-06-01', file_path = null, original_name = null,
         content_type = null, size_bytes = null, uploaded_at = null, status = 'valid'
     where nurse_id = $1`,
    [TRIAL_USERS.james.id],
  )
  await pool.end()
})

describe('GET /me/credentials', () => {
  it('shows James Cook his expired licence (expired by date, as seeded)', async () => {
    const res = await james.get('/me/credentials')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      credentials: [
        {
          id: expect.any(String),
          type: 'nursing_license',
          expiresAt: '2026-06-01',
          status: 'expired',
          fileName: null,
          uploadedAt: null,
        },
      ],
    })
  })

  it('is refused to agency users', async () => {
    const res = await sunrise.get('/me/credentials')
    expect(res.status).toBe(403)
    expect(Object.keys(res.body)).toEqual(['error'])
  })
})

describe('POST /me/credentials', () => {
  let objectPath: string

  it('stores a renewed licence for James, replacing his expired row, and unblocks his claims', async () => {
    const res = await upload(james, { expiresAt: '2028-01-01' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({
      credential: {
        id: expect.any(String),
        type: 'nursing_license',
        expiresAt: '2028-01-01',
        status: 'valid',
        fileName: 'licence.pdf',
        uploadedAt: expect.any(String),
      },
    })

    const { rows } = await pool.query(
      `select c.file_path, c.content_type, c.size_bytes, c.status, c.expires_at::text as expires_at
       from shiftpatch.nurse_credentials c where c.nurse_id = $1`,
      [TRIAL_USERS.james.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      content_type: 'application/pdf',
      size_bytes: PDF.byteLength,
      status: 'valid',
      expires_at: '2028-01-01',
    })
    objectPath = rows[0].file_path
    expect(objectPath).toMatch(new RegExp(`^${TRIAL_USERS.james.id}/nursing_license/[0-9a-f-]{36}\\.pdf$`))

    // The object is in the private bucket (service role only).
    const stack = inject('stack')
    const service = createClient(stack.apiUrl, stack.serviceRoleKey, { auth: { persistSession: false } })
    const [folder, type] = objectPath.split('/')
    const { data: objects, error } = await service.storage.from('shiftpatch-credentials').list(`${folder}/${type}`)
    expect(error).toBeNull()
    expect(objects!.map((o) => `${folder}/${type}/${o.name}`)).toContain(objectPath)
    const { data: bucket } = await service.storage.getBucket('shiftpatch-credentials')
    expect(bucket).toMatchObject({ public: false })

    // James can now claim an open shift (shift-3 is open; his licence is valid again).
    const claim = await james.post('/shifts/shift-3/claim').set('Origin', ALLOWED_ORIGIN).send()
    expect(claim.status).toBe(200)
    expect(claim.body).toMatchObject({ id: 'shift-3', status: 'filled', claimedBy: 'nurse-2' })
    const release = await james.post('/shifts/shift-3/cancel').set('Origin', ALLOWED_ORIGIN).send({ reason: 'advance' })
    expect(release.status).toBe(200)
  })

  it('a second upload of the same type updates the same row with a new object', async () => {
    const before = (await james.get('/me/credentials')).body.credentials[0].id
    const res = await upload(james, { expiresAt: '2029-06-30' }, PDF, 'renewed.pdf')
    expect(res.status).toBe(201)
    expect(res.body.credential).toMatchObject({ id: before, expiresAt: '2029-06-30', fileName: 'renewed.pdf' })
    const { rows } = await pool.query('select file_path from shiftpatch.nurse_credentials where id = $1', [before])
    expect(rows[0].file_path).not.toBe(objectPath)
  })

  it('refuses agency users, non-PDF bytes and unknown types without storing anything', async () => {
    const countObjects = async () => {
      const stack = inject('stack')
      const service = createClient(stack.apiUrl, stack.serviceRoleKey, { auth: { persistSession: false } })
      const { data } = await service.storage
        .from('shiftpatch-credentials')
        .list(`${TRIAL_USERS.maria.id}/nursing_license`)
      return data?.length ?? 0
    }
    const beforeCount = await countObjects()

    expect((await upload(sunrise, { expiresAt: '2028-01-01' })).status).toBe(403)
    const text = await upload(maria, { expiresAt: '2028-01-01' }, Buffer.from('not a pdf'))
    expect(text.status).toBe(400)
    expect(text.body).toEqual({ error: 'Unsupported file type' })
    const unknown = await upload(maria, { expiresAt: '2028-01-01', credentialTypeCode: 'drivers_license' })
    expect(unknown.status).toBe(400)
    expect(unknown.body).toEqual({ error: 'Unknown credential type' })

    // The unknown-type upload reached storage and was removed again.
    expect(await countObjects()).toBe(beforeCount)
    const { rows } = await pool.query(
      'select count(*)::int as n from shiftpatch.nurse_credentials where nurse_id = $1',
      [TRIAL_USERS.maria.id],
    )
    expect(rows[0].n).toBe(1)
  })

  it('nobody but the service role can read the bucket', async () => {
    const stack = inject('stack')
    const anon = createClient(stack.apiUrl, stack.publishableKey, { auth: { persistSession: false } })
    const { data, error } = await anon.storage.from('shiftpatch-credentials').list(TRIAL_USERS.james.id)
    expect(error ?? data).not.toBeNull()
    expect(data ?? []).toEqual([])
  })
})

describe('fixture nurses', () => {
  it('keep one row per credential type (the uniqueness rule holds for the seeded data)', async () => {
    const { rows } = await pool.query(
      `select nurse_id, credential_type_id, count(*)::int as n
       from shiftpatch.nurse_credentials group by 1, 2 having count(*) > 1`,
    )
    expect(rows).toEqual([])
    expect(USERS.ava.id).toBeTruthy()
  })
})
