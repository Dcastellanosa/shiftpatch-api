/**
 * The trial dataset, exactly as the required specification lists it. This is
 * what `pnpm seed` loads: two agencies with one branch each, one admin, two
 * nurses (one with an expired licence) and three dated shifts.
 *
 * Internal ids are fixed UUIDs so the seed is idempotent; the public ids the
 * contract exposes (`agency-a`, `nurse-1`, `shift-1`) are the slugs. No
 * password lives here: every account uses SEED_USER_PASSWORD from the
 * environment (the trial value is documented in the README).
 */

export type SeedRole = 'admin' | 'agency' | 'nurse'
export type SeedStatus = 'active' | 'inactive'
/** Stored statuses a shift can have: no command produces any other. */
export type SeedShiftStatus = 'open' | 'claimed'

export interface SeedAgency {
  id: string
  slug: string
  name: string
  status: SeedStatus
}

export interface SeedBranch {
  id: string
  agencyId: string
  name: string
  address: string
  /** IANA zone. The trial branches use UTC so facility-local times need no conversion. */
  timezone: string
  requires: readonly string[]
  status: SeedStatus
}

export interface SeedUser {
  id: string
  slug: string
  email: string
  fullName: string
  role: SeedRole
}

export interface SeedMembership {
  profileId: string
  agencyId: string
}

export interface SeedCredential {
  id: string
  nurseId: string
  code: string
  issuedAt: string
  expiresAt: string
  status: 'valid' | 'expired' | 'revoked'
}

export interface SeedEligibility {
  nurseId: string
  branchId: string
  status: 'pending' | 'active' | 'suspended'
}

/** Either a dated shift (facility-local, kept as is) or one relative to the seed run (moved forward on re-runs). */
export type SeedShiftTime =
  { date: string; startTime: string; endTime: string } | { dayOffset: number; startHourUtc: number; hours: number }

export interface SeedShift {
  id: string
  slug: string
  branchId: string
  title: string
  when: SeedShiftTime
  status: SeedShiftStatus
  assignedNurseId?: string
  createdById: string
}

export interface SeedDataset {
  agencies: readonly SeedAgency[]
  branches: readonly SeedBranch[]
  users: readonly SeedUser[]
  memberships: readonly SeedMembership[]
  credentials: readonly SeedCredential[]
  eligibility: readonly SeedEligibility[]
  shifts: readonly SeedShift[]
}

export const AGENCIES = {
  sunrise: {
    id: 'a2000000-0000-4000-8000-00000000000a',
    slug: 'agency-a',
    name: 'Sunrise Health Staffing',
    status: 'active',
  },
  metro: {
    id: 'a2000000-0000-4000-8000-00000000000b',
    slug: 'agency-b',
    name: 'Metro Care Partners',
    status: 'active',
  },
} as const satisfies Record<string, SeedAgency>

export const BRANCHES = {
  sunriseMain: {
    id: 'b2000000-0000-4000-8000-00000000000a',
    agencyId: AGENCIES.sunrise.id,
    name: 'Main',
    address: 'Sunrise Health Staffing',
    timezone: 'UTC',
    requires: ['nursing_license'],
    status: 'active',
  },
  metroMain: {
    id: 'b2000000-0000-4000-8000-00000000000b',
    agencyId: AGENCIES.metro.id,
    name: 'Main',
    address: 'Metro Care Partners',
    timezone: 'UTC',
    requires: ['nursing_license'],
    status: 'active',
  },
} as const satisfies Record<string, SeedBranch>

export const USERS = {
  admin: {
    id: 'c2000000-0000-4000-8000-000000000001',
    slug: 'admin-1',
    email: 'alex.kim@example.com',
    fullName: 'Alex Kim',
    role: 'admin',
  },
  /** Signs in as agency-a; the contract reports the agency slug as this user's id. */
  sunriseAgency: {
    id: 'c2000000-0000-4000-8000-00000000000a',
    slug: 'agency-a-user',
    email: 'admin@sunrisehealth.example',
    fullName: 'Sunrise Health Staffing',
    role: 'agency',
  },
  metroAgency: {
    id: 'c2000000-0000-4000-8000-00000000000b',
    slug: 'agency-b-user',
    email: 'admin@metrocare.example',
    fullName: 'Metro Care Partners',
    role: 'agency',
  },
  /** Valid licence until 2027-01-01; active at both branches; holds shift-2. */
  maria: {
    id: 'c2000000-0000-4000-8000-000000000011',
    slug: 'nurse-1',
    email: 'maria.lopez@example.com',
    fullName: 'Maria Lopez',
    role: 'nurse',
  },
  /** Licence expired 2026-06-01: every claim answers "Credential expired". */
  james: {
    id: 'c2000000-0000-4000-8000-000000000012',
    slug: 'nurse-2',
    email: 'james.cook@example.com',
    fullName: 'James Cook',
    role: 'nurse',
  },
} as const satisfies Record<string, SeedUser>

export const MEMBERSHIPS = [
  { profileId: USERS.sunriseAgency.id, agencyId: AGENCIES.sunrise.id },
  { profileId: USERS.metroAgency.id, agencyId: AGENCIES.metro.id },
] as const satisfies readonly SeedMembership[]

export const CREDENTIALS = [
  {
    id: 'd2000000-0000-4000-8000-000000000011',
    nurseId: USERS.maria.id,
    code: 'nursing_license',
    issuedAt: '2024-01-01',
    expiresAt: '2027-01-01',
    status: 'valid',
  },
  {
    id: 'd2000000-0000-4000-8000-000000000012',
    nurseId: USERS.james.id,
    code: 'nursing_license',
    issuedAt: '2022-06-01',
    expiresAt: '2026-06-01',
    status: 'valid',
  },
] as const satisfies readonly SeedCredential[]

export const ELIGIBILITY = [
  { nurseId: USERS.maria.id, branchId: BRANCHES.sunriseMain.id, status: 'active' },
  { nurseId: USERS.maria.id, branchId: BRANCHES.metroMain.id, status: 'active' },
  { nurseId: USERS.james.id, branchId: BRANCHES.sunriseMain.id, status: 'active' },
  { nurseId: USERS.james.id, branchId: BRANCHES.metroMain.id, status: 'active' },
] as const satisfies readonly SeedEligibility[]

export const SHIFTS = [
  {
    id: 'e2000000-0000-4000-8000-000000000001',
    slug: 'shift-1',
    branchId: BRANCHES.sunriseMain.id,
    title: 'RN',
    when: { date: '2026-10-02', startTime: '19:00', endTime: '07:00' },
    status: 'open',
    createdById: USERS.sunriseAgency.id,
  },
  {
    id: 'e2000000-0000-4000-8000-000000000002',
    slug: 'shift-2',
    branchId: BRANCHES.sunriseMain.id,
    title: 'LPN',
    when: { date: '2026-10-03', startTime: '07:00', endTime: '19:00' },
    status: 'claimed',
    assignedNurseId: USERS.maria.id,
    createdById: USERS.sunriseAgency.id,
  },
  {
    id: 'e2000000-0000-4000-8000-000000000003',
    slug: 'shift-3',
    branchId: BRANCHES.metroMain.id,
    title: 'RN',
    when: { date: '2026-10-04', startTime: '19:00', endTime: '07:00' },
    status: 'open',
    createdById: USERS.metroAgency.id,
  },
] as const satisfies readonly SeedShift[]

export const SPEC_DATASET: SeedDataset = {
  agencies: Object.values(AGENCIES),
  branches: Object.values(BRANCHES),
  users: Object.values(USERS),
  memberships: MEMBERSHIPS,
  credentials: CREDENTIALS,
  eligibility: ELIGIBILITY,
  shifts: SHIFTS,
}
