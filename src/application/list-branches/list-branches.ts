import type { Viewer } from '../../domain/viewer/viewer.js'
import type { Branch } from '../../domain/shift/shift.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'

/** Lists the branches visible to the viewer. */
export function listBranches({ store }: { store: DataStore }, viewer: Viewer): Promise<Branch[]> {
  return store.listBranches(viewer)
}
