import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USERS as TRIAL_USERS } from '../../scripts/seed-data.js'
import { ALLOWED_ORIGIN, USERS, asUser, buildRealApp, expectSqlState, inRollback, openPool, signIn } from './helpers.js'

/** The audit log is readable only through `list_audit_log_admin()`, and only by administrators. */

const app = buildRealApp()
let pool: Pool

beforeAll(() => {
  pool = openPool()
})

afterAll(async () => {
  await pool.end()
})

describe('list_audit_log_admin()', () => {
  it.each([
    ['a nurse', () => USERS.ava.id],
    ['an agency user', () => USERS.northwindAgency.id],
  ])('refuses %s', async (_who, actor) => {
    await expectSqlState(
      asUser(pool, actor(), (db) => db.query('select * from shiftpatch.list_audit_log_admin()')),
      '42501',
    )
  })

  it('gives an admin the unified timeline with public ids, newest first', async () => {
    await inRollback(pool, async (db) => {
      await db.query('select shiftpatch.create_agency($1, $2)', [USERS.admin.id, 'Audited Agency'])
      // Read as the admin would through PostgREST: the authenticated role with their JWT claims.
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: USERS.admin.id, role: 'authenticated' }),
      ])
      await db.query('set local role authenticated')
      const rows = (await db.query('select * from shiftpatch.list_audit_log_admin()')).rows as Record<string, unknown>[]
      await db.query('reset role')

      expect(rows.length).toBeGreaterThan(1)
      const times = rows.map((r) => new Date(r.occurred_at as string).getTime())
      expect([...times].sort((a, b) => b - a)).toEqual(times)
      expect(rows[0]).toMatchObject({ entity_type: 'agency', action: 'created', actor_slug: 'admin-morgan' })
      expect(rows[0]!.entity_id).toMatch(/^agency-/)

      const claimed = rows.find((r) => r.entity_type === 'shift' && r.entity_id === 'shift-2')
      expect(claimed).toMatchObject({
        action: 'claimed',
        previous_status: 'open',
        new_status: 'claimed',
        actor_slug: 'nurse-1',
      })
    })
  })
})

describe('GET /admin/audit-events', () => {
  it('answers the admin with the log and refuses an agency user', async () => {
    const admin = await signIn(app, TRIAL_USERS.admin)
    const res = await admin.get('/admin/audit-events')
    expect(res.status).toBe(200)
    const events = res.body.events as Record<string, unknown>[]
    expect(events.find((e) => e.entityType === 'shift' && e.entityId === 'shift-2')).toMatchObject({
      action: 'claimed',
      actorId: 'nurse-1',
      actorName: 'Maria Lopez',
      previousStatus: 'open',
      newStatus: 'claimed',
      reason: null,
    })
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        [
          'id',
          'occurredAt',
          'actorId',
          'actorName',
          'entityType',
          'entityId',
          'action',
          'previousStatus',
          'newStatus',
          'reason',
        ].sort(),
      )
    }

    const sunrise = await signIn(app, TRIAL_USERS.sunriseAgency)
    const refused = await sunrise.get('/admin/audit-events').set('Origin', ALLOWED_ORIGIN)
    expect(refused.status).toBe(403)
    expect(Object.keys(refused.body)).toEqual(['error'])
  })
})

describe('GET /timesheets', () => {
  it('scopes the rows by role', async () => {
    const maria = await signIn(app, TRIAL_USERS.maria)
    const mine = (await maria.get('/timesheets')).body.timesheets as Record<string, unknown>[]
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((t) => t.nurseId === 'nurse-1')).toBe(true)
    expect(mine.find((t) => t.shiftId === 'shift-2')).toEqual({
      shiftId: 'shift-2',
      nurseId: 'nurse-1',
      nurseName: 'Maria Lopez',
      agencyId: 'agency-a',
      agencyName: 'Sunrise Health Staffing',
      role: 'LPN',
      date: '2026-10-03',
      startTime: '07:00',
      endTime: '19:00',
      scheduledHours: 12,
      status: 'worked',
    })

    const metro = await signIn(app, TRIAL_USERS.metroAgency)
    const theirs = (await metro.get('/timesheets')).body.timesheets as Record<string, unknown>[]
    expect(theirs.every((t) => t.agencyId === 'agency-b')).toBe(true)
    expect(theirs.map((t) => t.shiftId)).not.toContain('shift-2')

    const admin = await signIn(app, TRIAL_USERS.admin)
    const all = (await admin.get('/timesheets')).body.timesheets as Record<string, unknown>[]
    expect(all.length).toBeGreaterThanOrEqual(mine.length + theirs.length)
  })
})
