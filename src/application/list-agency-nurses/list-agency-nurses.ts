import type { NurseEligibility } from '../../domain/admin/admin.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

/** Nurses connected to the viewer's agencies, with their status at each branch. */
export function listAgencyNurses({ store }: { store: DataStore }, viewer: Viewer): Promise<NurseEligibility[]> {
  return store.listAgencyNurses(viewer)
}
