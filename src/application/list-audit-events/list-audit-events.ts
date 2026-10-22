import type { AuditEvent } from '../../domain/admin/admin.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

/** The unified audit log (administration actions and shift history). The database refuses non-admins. */
export function listAuditEvents({ store }: { store: DataStore }, viewer: Viewer): Promise<AuditEvent[]> {
  return store.listAuditEvents(viewer)
}
