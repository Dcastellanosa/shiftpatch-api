import request from 'supertest'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { USERS } from '../../scripts/seed-data.js'
import { buildRealApp } from './helpers.js'

/**
 * The trial contract, request by request, exactly as the specification
 * reads: `/api/...` paths on the API host, `Authorization: Bearer <token>`,
 * `{ "error": "<message>" }` envelopes, public ids and the flat shift shape.
 * Runs against the seeded trial dataset (plus the suite's fixtures, which
 * live in other agencies).
 */

const app = buildRealApp()
const tokens = {} as Record<'maria' | 'james' | 'sunrise' | 'metro' | 'admin', string>

async function login(email: string, password = inject('seedPassword')) {
  return request(app).post('/api/auth/login').send({ email, password })
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

const SHIFT_1 = {
  id: 'shift-1',
  agencyId: 'agency-a',
  agencyName: 'Sunrise Health Staffing',
  role: 'RN',
  date: '2026-10-02',
  startTime: '19:00',
  endTime: '07:00',
  status: 'open',
  claimedBy: null,
}
const SHIFT_2 = { ...SHIFT_1, id: 'shift-2', role: 'LPN', date: '2026-10-03', startTime: '07:00', endTime: '19:00', status: 'filled', claimedBy: 'nurse-1' }
const SHIFT_3 = { ...SHIFT_1, id: 'shift-3', agencyId: 'agency-b', agencyName: 'Metro Care Partners', date: '2026-10-04' }

beforeAll(async () => {
  tokens.maria = (await login(USERS.maria.email)).body.token
  tokens.james = (await login(USERS.james.email)).body.token
  tokens.sunrise = (await login(USERS.sunriseAgency.email)).body.token
  tokens.metro = (await login(USERS.metroAgency.email)).body.token
  tokens.admin = (await login(USERS.admin.email)).body.token
})

/** Leaves the trial rows as seeded for the files that run afterwards. */
afterAll(async () => {
  await request(app).post('/api/shifts/shift-1/cancel').set(bearer(tokens.maria)).send({ reason: 'advance' })
  await request(app).post('/api/shifts/shift-2/claim').set(bearer(tokens.maria)).send()
})

describe('1. POST /api/auth/login', () => {
  it('answers { token, user: { id, name, role } } for a nurse', async () => {
    const res = await login(USERS.maria.email)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ token: expect.any(String), user: { id: 'nurse-1', name: 'Maria Lopez', role: 'nurse' } })
    expect(JSON.stringify(res.body)).not.toMatch(/refresh/i)
  })

  it.each([
    [USERS.sunriseAgency.email, 'agency-a', 'agency'],
    [USERS.metroAgency.email, 'agency-b', 'agency'],
    [USERS.admin.email, 'admin-1', 'admin'],
  ])('%s signs in as %s with role %s', async (email, id, role) => {
    const res = await login(email)
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ id, role })
  })

  it('answers 401 { "error": "Invalid email or password" } for bad credentials', async () => {
    const res = await login(USERS.maria.email, 'wrong-password')
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: 'Invalid email or password' })
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})

describe('authentication', () => {
  it('every shift route needs a bearer token and answers a string error', async () => {
    const missing = await request(app).get('/api/shifts')
    expect(missing.status).toBe(401)
    expect(missing.body).toMatchObject({ error: expect.any(String) })
    expect(typeof missing.body.error).toBe('string')
    const stale = await request(app).get('/api/shifts').set('Authorization', 'Bearer not-a-real-token')
    expect(stale.status).toBe(401)
  })
})

describe('2. GET /api/shifts', () => {
  it('lists every shift across both agencies in the contract shape, to a nurse', async () => {
    const res = await request(app).get('/api/shifts').set(bearer(tokens.maria))
    expect(res.status).toBe(200)
    const byId = new Map((res.body.shifts as { id: string }[]).map((s) => [s.id, s]))
    expect(byId.get('shift-1')).toMatchObject(SHIFT_1)
    expect(byId.get('shift-2')).toMatchObject(SHIFT_2)
    expect(byId.get('shift-3')).toMatchObject(SHIFT_3)
  })
})

describe('3. POST /api/shifts', () => {
  it('lets agency-a post a shift scoped to its own agencyId', async () => {
    const res = await request(app)
      .post('/api/shifts')
      .set(bearer(tokens.sunrise))
      .send({ role: 'RN', date: '2026-10-05', startTime: '07:00', endTime: '19:00' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      agencyId: 'agency-a',
      agencyName: 'Sunrise Health Staffing',
      role: 'RN',
      date: '2026-10-05',
      startTime: '07:00',
      endTime: '19:00',
      status: 'open',
      claimedBy: null,
    })
    expect(res.body.id).toMatch(/^shift-\d+$/)
  })

  it('refuses nurses', async () => {
    const res = await request(app).post('/api/shifts').set(bearer(tokens.maria)).send({ role: 'RN', date: '2026-10-05', startTime: '07:00', endTime: '19:00' })
    expect(res.status).toBe(403)
    expect(typeof res.body.error).toBe('string')
  })
})

describe('4. POST /api/shifts/:id/claim', () => {
  it('answers 403 { "error": "Credential expired, cannot claim shift" } for James Cook', async () => {
    const res = await request(app).post('/api/shifts/shift-1/claim').set(bearer(tokens.james)).send()
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: 'Credential expired, cannot claim shift' })
    const still = await request(app).get('/api/shifts/shift-1').set(bearer(tokens.admin))
    expect(still.body).toMatchObject({ status: 'open', claimedBy: null })
  })

  it('fills the shift for Maria Lopez', async () => {
    const res = await request(app).post('/api/shifts/shift-1/claim').set(bearer(tokens.maria)).send()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ...SHIFT_1, status: 'filled', claimedBy: 'nurse-1' })
  })
})

describe('5. POST /api/shifts/:id/cancel', () => {
  it('reopens shift-2 as a no-show and reports the previous nurse', async () => {
    const res = await request(app).post('/api/shifts/shift-2/cancel').set(bearer(tokens.sunrise)).send({ reason: 'no-show' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ...SHIFT_2,
      status: 'open',
      claimedBy: null,
      cancellation: { reason: 'no-show', previousNurseId: 'nurse-1' },
    })
  })
})

describe('6. GET /api/agencies/:agencyId/shifts', () => {
  it('returns agency-a its own shifts (shift-1 and shift-2 among them) with their current status', async () => {
    const res = await request(app).get('/api/agencies/agency-a/shifts').set(bearer(tokens.sunrise))
    expect(res.status).toBe(200)
    expect(res.body.agencyId).toBe('agency-a')
    const shifts = res.body.shifts as { id: string; status: string; claimedBy: string | null; agencyId: string }[]
    expect(shifts.every((s) => s.agencyId === 'agency-a')).toBe(true)
    expect(shifts.find((s) => s.id === 'shift-1')).toMatchObject({ status: 'filled', claimedBy: 'nurse-1' })
    expect(shifts.find((s) => s.id === 'shift-2')).toMatchObject({ status: 'open', claimedBy: null })
    expect(shifts.map((s) => s.id)).not.toContain('shift-3')
  })

  it('returns agency-b shift-3 only', async () => {
    const res = await request(app).get('/api/agencies/agency-b/shifts').set(bearer(tokens.metro))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ agencyId: 'agency-b', shifts: [expect.objectContaining({ id: 'shift-3', status: 'open', claimedBy: null })] })
  })

  it('refuses another agency with a string error', async () => {
    const res = await request(app).get('/api/agencies/agency-b/shifts').set(bearer(tokens.sunrise))
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: 'Forbidden' })
  })
})

describe('the same routes without the /api prefix (behind the web proxy)', () => {
  it('serve the same contract', async () => {
    const res = await request(app).get('/shifts/shift-3').set(bearer(tokens.maria))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject(SHIFT_3)
  })
})
