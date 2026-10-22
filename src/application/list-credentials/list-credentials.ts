import type { NurseCredential } from '../../domain/credential/credential.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

/**
 * The viewer's own credentials. A `valid` row whose expiry date has passed
 * is reported as `expired`: the claim rules compare dates, not the status.
 */
export async function listCredentials(
  { store }: { store: DataStore },
  viewer: Viewer,
  now: Date,
): Promise<NurseCredential[]> {
  const today = now.toISOString().slice(0, 10)
  const rows = await store.listNurseCredentials(viewer)
  return rows.map((row) => (row.status === 'valid' && row.expiresAt < today ? { ...row, status: 'expired' } : row))
}
