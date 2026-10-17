/**
 * Deterministic development fixtures. IDs are fixed so the seed is idempotent
 * and tests can refer to known records. No passwords live here: every seeded
 * account uses SEED_USER_PASSWORD from the environment.
 *
 * Accounts use the reserved `.test` TLD so they can never receive real email.
 */

export type SeedRole = 'admin' | 'agency' | 'nurse'

export interface SeedUser {
  id: string
  email: string
  fullName: string
  role: SeedRole
}

export const AGENCIES = {
  northwind: { id: 'a1000000-0000-4000-8000-000000000001', name: 'Northwind Care Staffing' },
  harbor: { id: 'a1000000-0000-4000-8000-000000000002', name: 'Harbor Health Partners' },
} as const

export const BRANCHES = {
  downtown: {
    id: 'b1000000-0000-4000-8000-000000000001',
    agencyId: AGENCIES.northwind.id,
    name: 'Downtown Clinic',
    address: '120 Main Street, Boston, MA 02108',
    timezone: 'America/New_York',
    requires: ['nursing_license', 'tb_test'],
  },
  riverside: {
    id: 'b1000000-0000-4000-8000-000000000002',
    agencyId: AGENCIES.northwind.id,
    name: 'Riverside Hospital',
    address: '45 River Road, Cambridge, MA 02139',
    timezone: 'America/New_York',
    requires: ['nursing_license', 'tb_test'],
  },
  bayview: {
    id: 'b1000000-0000-4000-8000-000000000003',
    agencyId: AGENCIES.harbor.id,
    name: 'Bayview Medical Center',
    address: '900 Bay Street, San Francisco, CA 94133',
    timezone: 'America/Los_Angeles',
    requires: ['nursing_license', 'tb_test'],
  },
  hillcrest: {
    id: 'b1000000-0000-4000-8000-000000000004',
    agencyId: AGENCIES.harbor.id,
    name: 'Hillcrest Rehabilitation',
    address: '310 Hill Avenue, Oakland, CA 94610',
    timezone: 'America/Los_Angeles',
    requires: ['nursing_license'],
  },
} as const

export const USERS = {
  admin: {
    id: 'c1000000-0000-4000-8000-000000000001',
    email: 'admin@shiftpatch.test',
    fullName: 'Morgan Admin',
    role: 'admin',
  },
  northwindAgency: {
    id: 'c1000000-0000-4000-8000-000000000002',
    email: 'agency.northwind@shiftpatch.test',
    fullName: 'Riley Northwind',
    role: 'agency',
  },
  harborAgency: {
    id: 'c1000000-0000-4000-8000-000000000003',
    email: 'agency.harbor@shiftpatch.test',
    fullName: 'Jordan Harbor',
    role: 'agency',
  },
  /** Fully eligible: active at Downtown, Riverside and Bayview; all credentials valid. */
  ava: {
    id: 'c1000000-0000-4000-8000-000000000011',
    email: 'nurse.ava@shiftpatch.test',
    fullName: 'Ava Thompson',
    role: 'nurse',
  },
  /** Active at Downtown, but the TB test expired. */
  ben: {
    id: 'c1000000-0000-4000-8000-000000000012',
    email: 'nurse.ben@shiftpatch.test',
    fullName: 'Ben Okafor',
    role: 'nurse',
  },
  /** Valid credentials, but no active eligibility (pending at Downtown, suspended at Bayview). */
  cora: {
    id: 'c1000000-0000-4000-8000-000000000013',
    email: 'nurse.cora@shiftpatch.test',
    fullName: 'Cora Lindqvist',
    role: 'nurse',
  },
  /** Active at Downtown, but has no TB test on file. */
  dev: {
    id: 'c1000000-0000-4000-8000-000000000014',
    email: 'nurse.dev@shiftpatch.test',
    fullName: 'Dev Patel',
    role: 'nurse',
  },
  /** Second fully eligible nurse: active at Downtown and Hillcrest. */
  eli: {
    id: 'c1000000-0000-4000-8000-000000000015',
    email: 'nurse.eli@shiftpatch.test',
    fullName: 'Eli Romero',
    role: 'nurse',
  },
} as const satisfies Record<string, SeedUser>

export const MEMBERSHIPS = [
  { profileId: USERS.northwindAgency.id, agencyId: AGENCIES.northwind.id },
  { profileId: USERS.harborAgency.id, agencyId: AGENCIES.harbor.id },
] as const

const VALID_UNTIL = '2030-12-31'
const EXPIRED_ON = '2025-06-30'

export const CREDENTIALS = [
  { id: 'd1000000-0000-4000-8000-000000000001', nurseId: USERS.ava.id, code: 'nursing_license', issuedAt: '2024-01-15', expiresAt: VALID_UNTIL, status: 'valid' },
  { id: 'd1000000-0000-4000-8000-000000000002', nurseId: USERS.ava.id, code: 'tb_test', issuedAt: '2026-01-10', expiresAt: VALID_UNTIL, status: 'valid' },
  { id: 'd1000000-0000-4000-8000-000000000003', nurseId: USERS.ben.id, code: 'nursing_license', issuedAt: '2023-03-01', expiresAt: VALID_UNTIL, status: 'valid' },
  { id: 'd1000000-0000-4000-8000-000000000004', nurseId: USERS.ben.id, code: 'tb_test', issuedAt: '2024-06-30', expiresAt: EXPIRED_ON, status: 'valid' },
  { id: 'd1000000-0000-4000-8000-000000000005', nurseId: USERS.cora.id, code: 'nursing_license', issuedAt: '2024-05-20', expiresAt: VALID_UNTIL, status: 'valid' },
  { id: 'd1000000-0000-4000-8000-000000000006', nurseId: USERS.cora.id, code: 'tb_test', issuedAt: '2026-02-02', expiresAt: VALID_UNTIL, status: 'valid' },
  { id: 'd1000000-0000-4000-8000-000000000007', nurseId: USERS.dev.id, code: 'nursing_license', issuedAt: '2025-08-11', expiresAt: VALID_UNTIL, status: 'valid' },
  { id: 'd1000000-0000-4000-8000-000000000008', nurseId: USERS.eli.id, code: 'nursing_license', issuedAt: '2022-09-09', expiresAt: VALID_UNTIL, status: 'valid' },
  { id: 'd1000000-0000-4000-8000-000000000009', nurseId: USERS.eli.id, code: 'tb_test', issuedAt: '2026-03-03', expiresAt: VALID_UNTIL, status: 'valid' },
] as const

export const ELIGIBILITY = [
  { nurseId: USERS.ava.id, branchId: BRANCHES.downtown.id, status: 'active' },
  { nurseId: USERS.ava.id, branchId: BRANCHES.riverside.id, status: 'active' },
  { nurseId: USERS.ava.id, branchId: BRANCHES.bayview.id, status: 'active' },
  { nurseId: USERS.ben.id, branchId: BRANCHES.downtown.id, status: 'active' },
  { nurseId: USERS.cora.id, branchId: BRANCHES.downtown.id, status: 'pending' },
  { nurseId: USERS.cora.id, branchId: BRANCHES.bayview.id, status: 'suspended' },
  { nurseId: USERS.dev.id, branchId: BRANCHES.downtown.id, status: 'active' },
  { nurseId: USERS.eli.id, branchId: BRANCHES.downtown.id, status: 'active' },
  { nurseId: USERS.eli.id, branchId: BRANCHES.hillcrest.id, status: 'active' },
] as const

export type SeedShiftStatus = 'open' | 'claimed' | 'completed'

export interface SeedShift {
  id: string
  branchId: string
  title: string
  /** Offset from today 00:00 UTC. */
  dayOffset: number
  startHourUtc: number
  hours: number
  status: SeedShiftStatus
  assignedNurseId?: string
  createdById: string
}

export const SHIFTS: readonly SeedShift[] = [
  { id: 'e1000000-0000-4000-8000-000000000001', branchId: BRANCHES.downtown.id, title: 'Med-Surg RN — Day', dayOffset: 3, startHourUtc: 12, hours: 8, status: 'open', createdById: USERS.northwindAgency.id },
  { id: 'e1000000-0000-4000-8000-000000000002', branchId: BRANCHES.riverside.id, title: 'ICU RN — Night', dayOffset: 4, startHourUtc: 23, hours: 12, status: 'open', createdById: USERS.northwindAgency.id },
  { id: 'e1000000-0000-4000-8000-000000000003', branchId: BRANCHES.bayview.id, title: 'ER RN — Swing', dayOffset: 5, startHourUtc: 22, hours: 8, status: 'open', createdById: USERS.harborAgency.id },
  { id: 'e1000000-0000-4000-8000-000000000004', branchId: BRANCHES.hillcrest.id, title: 'Rehab LPN — Day', dayOffset: 6, startHourUtc: 15, hours: 8, status: 'open', createdById: USERS.harborAgency.id },
  { id: 'e1000000-0000-4000-8000-000000000005', branchId: BRANCHES.downtown.id, title: 'Pediatrics RN — Day', dayOffset: 2, startHourUtc: 12, hours: 8, status: 'claimed', assignedNurseId: USERS.ava.id, createdById: USERS.northwindAgency.id },
  // Overlaps shift ...005, so Ava gets a schedule conflict when she tries to claim it.
  { id: 'e1000000-0000-4000-8000-000000000006', branchId: BRANCHES.riverside.id, title: 'Telemetry RN — Mid', dayOffset: 2, startHourUtc: 16, hours: 6, status: 'open', createdById: USERS.northwindAgency.id },
  { id: 'e1000000-0000-4000-8000-000000000007', branchId: BRANCHES.bayview.id, title: 'Oncology RN — Day', dayOffset: 8, startHourUtc: 16, hours: 8, status: 'claimed', assignedNurseId: USERS.ava.id, createdById: USERS.harborAgency.id },
  { id: 'e1000000-0000-4000-8000-000000000008', branchId: BRANCHES.downtown.id, title: 'Med-Surg RN — Day', dayOffset: -5, startHourUtc: 12, hours: 8, status: 'completed', assignedNurseId: USERS.ava.id, createdById: USERS.northwindAgency.id },
]
