import type { Agency } from '../../domain/agency/agency.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Viewer } from '../../domain/viewer/viewer.js'

/** Lists every agency, inactive ones included, as the viewer sees them. */
export function listAgencies({ store }: { store: DataStore }, viewer: Viewer): Promise<Agency[]> {
  return store.listAgencies(viewer)
}
