import type { Viewer } from '../domain/identity.js'
import type { Branch } from '../domain/shift.js'
import type { DataStore } from './ports/data-store.js'

/** Lists the branches visible to the viewer. */
export function listBranches({ store }: { store: DataStore }, viewer: Viewer): Promise<Branch[]> {
  return store.listBranches(viewer)
}
