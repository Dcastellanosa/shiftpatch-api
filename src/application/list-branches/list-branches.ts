import type { Viewer } from '../../domain/identity/index.js'
import type { Branch } from '../../domain/shift/index.js'
import type { DataStore } from '../../domain/ports/data-store/index.js'

/** Lists the branches visible to the viewer. */
export function listBranches({ store }: { store: DataStore }, viewer: Viewer): Promise<Branch[]> {
  return store.listBranches(viewer)
}
