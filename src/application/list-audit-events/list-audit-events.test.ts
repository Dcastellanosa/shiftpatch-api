import { describe, expect, it } from 'vitest'
import { ADMIN_PROFILE, auditEventFixture, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { listAuditEvents } from './list-audit-events.js'

describe('listAuditEvents', () => {
  it('reads the audit log as the viewer (the database refuses non-admins)', async () => {
    const event = auditEventFixture()
    const store = fakeDataStore({ listAuditEvents: async () => [event] })
    await expect(listAuditEvents({ store }, viewerFor(ADMIN_PROFILE))).resolves.toEqual([event])
    expect(store.listAuditEvents).toHaveBeenCalledWith(viewerFor(ADMIN_PROFILE))
  })
})
