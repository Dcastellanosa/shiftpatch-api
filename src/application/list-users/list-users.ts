import type { AdminUser } from '../../domain/admin/admin.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

/** Every provisioned user with their access, as the (admin) viewer sees them. */
export function listUsers({ store }: { store: DataStore }, viewer: Viewer): Promise<AdminUser[]> {
  return store.listUsers(viewer)
}
