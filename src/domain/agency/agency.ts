/**
 * Agency administration model. Plain types with no framework or I/O
 * dependencies; every timestamp is an ISO 8601 UTC string.
 */

export const ENTITY_STATUSES = ['active', 'inactive'] as const
export type EntityStatus = (typeof ENTITY_STATUSES)[number]

export interface Agency {
  /** Public id (slug), e.g. `agency-a`. */
  id: string
  name: string
  status: EntityStatus
  branchCount: number
  createdAt: string
  updatedAt: string
}

export interface AgencyBranch {
  /** Branch ids are UUIDs (branches are an internal refinement of the contract's agency-level shifts). */
  id: string
  /** Public id of the agency. */
  agencyId: string
  name: string
  address: string
  timezone: string
  status: EntityStatus
  createdAt: string
  updatedAt: string
}

export interface AgencyDetail {
  agency: Agency
  branches: AgencyBranch[]
}

export interface CreateAgencyInput {
  name: string
}

/** Absent fields stay unchanged. */
export interface UpdateAgencyInput {
  name?: string | undefined
  status?: EntityStatus | undefined
}

export interface CreateBranchInput {
  name: string
  address: string
  /** IANA zone name, used for display only. */
  timezone: string
}

/** Absent fields stay unchanged. */
export interface UpdateBranchInput {
  name?: string | undefined
  address?: string | undefined
  timezone?: string | undefined
  status?: EntityStatus | undefined
}
