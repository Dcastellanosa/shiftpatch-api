import { describe, expect, it } from 'vitest'
import { NURSE_PROFILE, credentialFixture, fakeDataStore, viewerFor } from '../../test-support/fakes.js'
import { listCredentials } from './list-credentials.js'

describe('listCredentials', () => {
  it('returns the viewer’s credentials, marking date-expired ones as expired', async () => {
    const valid = credentialFixture({ id: 'd1', expiresAt: '2030-01-01' })
    const lapsed = credentialFixture({ id: 'd2', type: 'tb_test', expiresAt: '2026-06-01' })
    const revoked = credentialFixture({ id: 'd3', expiresAt: '2030-01-01', status: 'revoked' })
    const store = fakeDataStore({ listNurseCredentials: async () => [valid, lapsed, revoked] })

    const result = await listCredentials({ store }, viewerFor(NURSE_PROFILE), new Date('2026-10-21T12:00:00Z'))

    expect(result.map((c) => [c.id, c.status])).toEqual([
      ['d1', 'valid'],
      ['d2', 'expired'],
      ['d3', 'revoked'],
    ])
    expect(store.listNurseCredentials).toHaveBeenCalledWith(viewerFor(NURSE_PROFILE))
  })

  it('treats a credential expiring today as still valid', async () => {
    const today = credentialFixture({ expiresAt: '2026-10-21' })
    const store = fakeDataStore({ listNurseCredentials: async () => [today] })
    const [result] = await listCredentials({ store }, viewerFor(NURSE_PROFILE), new Date('2026-10-21T23:59:00Z'))
    expect(result!.status).toBe('valid')
  })
})
