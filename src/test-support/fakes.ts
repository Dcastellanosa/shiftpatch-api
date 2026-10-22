import { vi } from 'vitest'
import type { AuthAdmin } from '../domain/ports/auth-admin/auth-admin.js'
import type { AuthProvider, AuthSession } from '../domain/ports/auth-provider/auth-provider.js'
import type { DataStore } from '../domain/ports/data-store/data-store.js'
import type { FileStore } from '../domain/ports/file-store/file-store.js'
import type { NurseCredential } from '../domain/credential/credential.js'
import type { TokenVerifier } from '../domain/ports/token-verifier/token-verifier.js'
import { parseEnv } from '../infrastructure/config/env/env.js'
import { createApp } from '../composition/create-app/create-app.js'
import type { AuthUser, Profile, Viewer } from '../domain/viewer/viewer.js'
import type { AdminUser, AuditEvent, EligibilityRecord, NurseEligibility } from '../domain/admin/admin.js'
import type { Agency, AgencyBranch } from '../domain/agency/agency.js'
import type { Shift } from '../domain/shift/shift.js'

export const ALLOWED_ORIGIN = 'http://localhost:5173'

export const USER: AuthUser = { id: '7c1e0d52-0000-4000-8000-000000000001', email: 'nurse@example.com' }

export const SESSION: AuthSession = {
  accessToken: 'access-token-value-1',
  refreshToken: 'refresh-token-value-1',
  expiresIn: 3600,
  user: USER,
}

/** Authorization header of a request carrying SESSION's access token. */
export const BEARER = { Authorization: `Bearer ${SESSION.accessToken}` }

/** Every method is a spy; overrides become the spy's implementation. */
export function fakeAuthProvider(overrides: Partial<AuthProvider> = {}) {
  return {
    signInWithPassword: vi.fn<AuthProvider['signInWithPassword']>(overrides.signInWithPassword ?? (async () => null)),
    signOut: vi.fn<AuthProvider['signOut']>(overrides.signOut ?? (async () => undefined)),
  }
}

/** Rejects every token unless `verify` is overridden. */
export function fakeTokenVerifier(overrides: Partial<TokenVerifier> = {}) {
  return { verify: vi.fn<TokenVerifier['verify']>(overrides.verify ?? (async () => null)) }
}

/** Every method is a spy; unconfigured methods fail loudly so unexpected calls surface. */
export function fakeDataStore(overrides: Partial<DataStore> = {}) {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected DataStore.${name} call`)
  }
  return {
    getProfile: vi.fn<DataStore['getProfile']>(overrides.getProfile ?? (async () => null)),
    listShifts: vi.fn<DataStore['listShifts']>(overrides.listShifts ?? unexpected('listShifts')),
    getShift: vi.fn<DataStore['getShift']>(overrides.getShift ?? unexpected('getShift')),
    listAssignedShifts: vi.fn<DataStore['listAssignedShifts']>(
      overrides.listAssignedShifts ?? unexpected('listAssignedShifts'),
    ),
    listShiftEvents: vi.fn<DataStore['listShiftEvents']>(overrides.listShiftEvents ?? unexpected('listShiftEvents')),
    listBranches: vi.fn<DataStore['listBranches']>(overrides.listBranches ?? unexpected('listBranches')),
    createShift: vi.fn<DataStore['createShift']>(overrides.createShift ?? unexpected('createShift')),
    claimShift: vi.fn<DataStore['claimShift']>(overrides.claimShift ?? unexpected('claimShift')),
    cancelClaim: vi.fn<DataStore['cancelClaim']>(overrides.cancelClaim ?? unexpected('cancelClaim')),
    listAgencies: vi.fn<DataStore['listAgencies']>(overrides.listAgencies ?? unexpected('listAgencies')),
    getAgency: vi.fn<DataStore['getAgency']>(overrides.getAgency ?? unexpected('getAgency')),
    getAgencyBranch: vi.fn<DataStore['getAgencyBranch']>(overrides.getAgencyBranch ?? unexpected('getAgencyBranch')),
    createAgency: vi.fn<DataStore['createAgency']>(overrides.createAgency ?? unexpected('createAgency')),
    updateAgency: vi.fn<DataStore['updateAgency']>(overrides.updateAgency ?? unexpected('updateAgency')),
    deleteAgency: vi.fn<DataStore['deleteAgency']>(overrides.deleteAgency ?? unexpected('deleteAgency')),
    createBranch: vi.fn<DataStore['createBranch']>(overrides.createBranch ?? unexpected('createBranch')),
    updateBranch: vi.fn<DataStore['updateBranch']>(overrides.updateBranch ?? unexpected('updateBranch')),
    listUsers: vi.fn<DataStore['listUsers']>(overrides.listUsers ?? unexpected('listUsers')),
    getUser: vi.fn<DataStore['getUser']>(overrides.getUser ?? unexpected('getUser')),
    provisionUser: vi.fn<DataStore['provisionUser']>(overrides.provisionUser ?? unexpected('provisionUser')),
    deleteUser: vi.fn<DataStore['deleteUser']>(overrides.deleteUser ?? unexpected('deleteUser')),
    listAgencyNurses: vi.fn<DataStore['listAgencyNurses']>(
      overrides.listAgencyNurses ?? unexpected('listAgencyNurses'),
    ),
    getEligibility: vi.fn<DataStore['getEligibility']>(overrides.getEligibility ?? unexpected('getEligibility')),
    setBranchEligibility: vi.fn<DataStore['setBranchEligibility']>(
      overrides.setBranchEligibility ?? unexpected('setBranchEligibility'),
    ),
    listNurseCredentials: vi.fn<DataStore['listNurseCredentials']>(
      overrides.listNurseCredentials ?? unexpected('listNurseCredentials'),
    ),
    upsertNurseCredential: vi.fn<DataStore['upsertNurseCredential']>(
      overrides.upsertNurseCredential ?? unexpected('upsertNurseCredential'),
    ),
    listAuditEvents: vi.fn<DataStore['listAuditEvents']>(overrides.listAuditEvents ?? unexpected('listAuditEvents')),
  }
}

export function auditEventFixture(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'f3000000-0000-4000-8000-000000000001',
    occurredAt: '2026-10-21T12:00:00.000Z',
    actorId: ADMIN_PROFILE.slug,
    actorName: ADMIN_PROFILE.fullName,
    entityType: 'agency',
    entityId: AGENCY_ID,
    action: 'created',
    previousStatus: null,
    newStatus: 'active',
    reason: null,
    ...overrides,
  }
}

/** Every method is a spy; by default storage accepts every write. */
export function fakeFileStore(overrides: Partial<FileStore> = {}) {
  return {
    put: vi.fn<FileStore['put']>(overrides.put ?? (async () => undefined)),
    remove: vi.fn<FileStore['remove']>(overrides.remove ?? (async () => undefined)),
  }
}

export function credentialFixture(overrides: Partial<NurseCredential> = {}): NurseCredential {
  return {
    id: 'd2000000-0000-4000-8000-000000000001',
    type: 'nursing_license',
    expiresAt: '2028-01-01',
    status: 'valid',
    fileName: 'licence.pdf',
    uploadedAt: '2026-10-21T12:00:00.000Z',
    ...overrides,
  }
}

/** Public ids used across the fakes. */
export const AGENCY_ID = 'agency-a'
export const AGENCY_UUID = 'a1000000-0000-4000-8000-000000000001'
export const NURSE_SLUG = 'nurse-1'
export const NURSE_ID = NURSE_SLUG
export const SHIFT_ID = 'shift-1'
export const BRANCH_ID = 'b1000000-0000-4000-8000-000000000001'

export const NURSE_PROFILE: Profile = {
  id: USER.id,
  slug: NURSE_SLUG,
  fullName: 'Ava Thompson',
  role: 'nurse',
  agencyIds: [],
  agencySlugs: [],
  agencyId: null,
  agencySlug: null,
}
export const AGENCY_PROFILE: Profile = {
  id: USER.id,
  slug: 'agency-a-user',
  fullName: 'Riley Northwind',
  role: 'agency',
  agencyIds: [AGENCY_UUID],
  agencySlugs: [AGENCY_ID],
  agencyId: AGENCY_UUID,
  agencySlug: AGENCY_ID,
}
export const ADMIN_PROFILE: Profile = {
  id: USER.id,
  slug: 'admin-1',
  fullName: 'Morgan Admin',
  role: 'admin',
  agencyIds: [],
  agencySlugs: [],
  agencyId: null,
  agencySlug: null,
}

/** The viewer `loadViewer` would build for the given profile in a session. */
export function viewerFor(profile: Profile): Viewer {
  return { ...profile, accessToken: SESSION.accessToken }
}

export function shiftFixture(overrides: Partial<Shift> = {}): Shift {
  return {
    id: SHIFT_ID,
    agencyId: AGENCY_ID,
    agencyName: 'Northwind Care Staffing',
    role: 'RN',
    date: '2030-01-10',
    startTime: '07:00',
    endTime: '15:00',
    status: 'open',
    claimedBy: null,
    claimedByName: null,
    branch: {
      id: BRANCH_ID,
      name: 'Downtown Clinic',
      address: '120 Main Street',
      timezone: 'America/New_York',
      status: 'active',
    },
    startsAt: '2030-01-10T12:00:00.000Z',
    endsAt: '2030-01-10T20:00:00.000Z',
    createdAt: '2029-12-01T00:00:00.000Z',
    updatedAt: '2029-12-01T00:00:00.000Z',
    ...overrides,
  }
}

/** The fixture shift as the nurse of `NURSE_PROFILE` holds it. */
export const claimedShiftFixture = (overrides: Partial<Shift> = {}) =>
  shiftFixture({ status: 'claimed', claimedBy: NURSE_SLUG, claimedByName: NURSE_PROFILE.fullName, ...overrides })

export function buildApp(
  authProvider: AuthProvider | null = fakeAuthProvider(),
  nodeEnv: 'test' | 'production' = 'test',
  dataStore: DataStore | null = null,
  authAdmin: AuthAdmin | null = null,
  tokenVerifier: TokenVerifier | null = fakeTokenVerifier(),
  fileStore: FileStore | null = null,
) {
  const env = parseEnv({ NODE_ENV: nodeEnv, CORS_ORIGINS: ALLOWED_ORIGIN })
  return createApp(env, { authProvider, dataStore, authAdmin, tokenVerifier, fileStore })
}

/** An app that accepts SESSION's bearer token as USER, with the given data store (and auth admin, file store). */
export function buildSignedInApp(
  dataStore: DataStore | null,
  authAdmin: AuthAdmin | null = null,
  fileStore: FileStore | null = null,
) {
  return buildApp(
    fakeAuthProvider(),
    'test',
    dataStore,
    authAdmin,
    fakeTokenVerifier({ verify: async () => USER }),
    fileStore,
  )
}

/** Every method is a spy; unconfigured methods fail loudly so unexpected calls surface. */
export function fakeAuthAdmin(overrides: Partial<AuthAdmin> = {}) {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected AuthAdmin.${name} call`)
  }
  return {
    inviteUser: vi.fn<AuthAdmin['inviteUser']>(overrides.inviteUser ?? unexpected('inviteUser')),
    deleteUser: vi.fn<AuthAdmin['deleteUser']>(overrides.deleteUser ?? (async () => undefined)),
    completePassword: vi.fn<AuthAdmin['completePassword']>(
      overrides.completePassword ?? unexpected('completePassword'),
    ),
    sendRecovery: vi.fn<AuthAdmin['sendRecovery']>(overrides.sendRecovery ?? (async () => undefined)),
  }
}

/** Auth UUID of a freshly invited user (before it has a public id). */
export const INVITED_USER_ID = '7c1e0d52-0000-4000-8000-000000000099'
export const INVITED_USER_SLUG = 'nurse-7'

export function adminUserFixture(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: INVITED_USER_SLUG,
    email: 'new.nurse@example.test',
    fullName: 'Nina Nurse',
    role: 'nurse',
    status: 'invited',
    invitedAt: '2030-01-01T00:00:00.000Z',
    lastSignInAt: null,
    agencies: [],
    eligibleBranches: [
      {
        id: BRANCH_ID,
        name: 'Downtown Clinic',
        agency: { id: AGENCY_ID, name: 'Northwind Care Staffing' },
        status: 'active',
      },
    ],
    ...overrides,
  }
}

export function agencyFixture(overrides: Partial<Agency> = {}): Agency {
  return {
    id: AGENCY_ID,
    name: 'Northwind Care Staffing',
    status: 'active',
    branchCount: 2,
    createdAt: '2029-11-01T00:00:00.000Z',
    updatedAt: '2029-11-02T00:00:00.000Z',
    ...overrides,
  }
}

export function agencyBranchFixture(overrides: Partial<AgencyBranch> = {}): AgencyBranch {
  return {
    id: BRANCH_ID,
    agencyId: AGENCY_ID,
    name: 'Downtown Clinic',
    address: '120 Main Street',
    timezone: 'America/New_York',
    status: 'active',
    createdAt: '2029-11-01T00:00:00.000Z',
    updatedAt: '2029-11-02T00:00:00.000Z',
    ...overrides,
  }
}

export function eligibilityFixture(overrides: Partial<EligibilityRecord> = {}): EligibilityRecord {
  return {
    nurseId: NURSE_SLUG,
    branchId: BRANCH_ID,
    status: 'active',
    activatedAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function nurseEligibilityFixture(overrides: Partial<NurseEligibility> = {}): NurseEligibility {
  return {
    nurse: { id: NURSE_SLUG, fullName: 'Ava Thompson' },
    branches: [
      {
        branch: { id: BRANCH_ID, name: 'Downtown Clinic', agency: { id: AGENCY_ID, name: 'Northwind Care Staffing' } },
        status: 'active',
        activatedAt: '2030-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  }
}
