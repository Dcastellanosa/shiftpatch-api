import { vi } from 'vitest'
import type { AuthAdmin } from '../domain/ports/auth-admin/auth-admin.js'
import type { AuthProvider, AuthSession } from '../domain/ports/auth-provider/auth-provider.js'
import type { DataStore } from '../domain/ports/data-store/data-store.js'
import { parseEnv } from '../infrastructure/config/env/env.js'
import { createApp } from '../composition/create-app/create-app.js'
import type { AuthUser, Profile, Viewer } from '../domain/viewer/viewer.js'
import type { AdminUser, EligibilityRecord, NurseEligibility } from '../domain/admin/admin.js'
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

export const REFRESHED_SESSION: AuthSession = {
  accessToken: 'access-token-value-2',
  refreshToken: 'refresh-token-value-2',
  expiresIn: 3600,
  user: USER,
}

/** Every method is a spy; overrides become the spy's implementation. */
export function fakeAuthProvider(overrides: Partial<AuthProvider> = {}) {
  return {
    signInWithPassword: vi.fn<AuthProvider['signInWithPassword']>(
      overrides.signInWithPassword ?? (async () => null),
    ),
    getUser: vi.fn<AuthProvider['getUser']>(overrides.getUser ?? (async () => null)),
    refreshSession: vi.fn<AuthProvider['refreshSession']>(overrides.refreshSession ?? (async () => null)),
    signOut: vi.fn<AuthProvider['signOut']>(overrides.signOut ?? (async () => undefined)),
  }
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
    listAgencyNurses: vi.fn<DataStore['listAgencyNurses']>(overrides.listAgencyNurses ?? unexpected('listAgencyNurses')),
    getEligibility: vi.fn<DataStore['getEligibility']>(overrides.getEligibility ?? unexpected('getEligibility')),
    setBranchEligibility: vi.fn<DataStore['setBranchEligibility']>(overrides.setBranchEligibility ?? unexpected('setBranchEligibility')),
  }
}

export const NURSE_PROFILE: Profile = { id: USER.id, fullName: 'Ava Thompson', role: 'nurse', agencyIds: [], agencyId: null }
export const AGENCY_PROFILE: Profile = {
  id: USER.id,
  fullName: 'Riley Northwind',
  role: 'agency',
  agencyIds: ['a1000000-0000-4000-8000-000000000001'],
  agencyId: 'a1000000-0000-4000-8000-000000000001',
}
export const ADMIN_PROFILE: Profile = { id: USER.id, fullName: 'Morgan Admin', role: 'admin', agencyIds: [], agencyId: null }

/** The viewer `loadViewer` would build for the given profile in a session. */
export function viewerFor(profile: Profile): Viewer {
  return { ...profile, accessToken: SESSION.accessToken }
}

export const SHIFT_ID = 'e1000000-0000-4000-8000-0000000000aa'
export const BRANCH_ID = 'b1000000-0000-4000-8000-000000000001'

export function shiftFixture(overrides: Partial<Shift> = {}): Shift {
  return {
    id: SHIFT_ID,
    title: 'Med-Surg RN — Day',
    startsAt: '2030-01-10T12:00:00.000Z',
    endsAt: '2030-01-10T20:00:00.000Z',
    status: 'open',
    branch: { id: BRANCH_ID, name: 'Downtown Clinic', address: '120 Main Street', timezone: 'America/New_York', status: 'active' },
    agency: { id: 'a1000000-0000-4000-8000-000000000001', name: 'Northwind Care Staffing' },
    assignedNurse: null,
    createdAt: '2029-12-01T00:00:00.000Z',
    updatedAt: '2029-12-01T00:00:00.000Z',
    ...overrides,
  }
}

export function buildApp(
  authProvider: AuthProvider | null = fakeAuthProvider(),
  nodeEnv: 'test' | 'production' = 'test',
  dataStore: DataStore | null = null,
  authAdmin: AuthAdmin | null = null,
) {
  const env = parseEnv({ NODE_ENV: nodeEnv, CORS_ORIGINS: ALLOWED_ORIGIN })
  return createApp(env, { authProvider, dataStore, authAdmin })
}

/** An app whose cookie session resolves to USER, with the given data store (and auth admin). */
export function buildSignedInApp(dataStore: DataStore | null, authAdmin: AuthAdmin | null = null) {
  return buildApp(fakeAuthProvider({ getUser: async () => USER }), 'test', dataStore, authAdmin)
}

/** Every method is a spy; unconfigured methods fail loudly so unexpected calls surface. */
export function fakeAuthAdmin(overrides: Partial<AuthAdmin> = {}) {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected AuthAdmin.${name} call`)
  }
  return {
    inviteUser: vi.fn<AuthAdmin['inviteUser']>(overrides.inviteUser ?? unexpected('inviteUser')),
    deleteUser: vi.fn<AuthAdmin['deleteUser']>(overrides.deleteUser ?? (async () => undefined)),
    completePassword: vi.fn<AuthAdmin['completePassword']>(overrides.completePassword ?? unexpected('completePassword')),
    sendRecovery: vi.fn<AuthAdmin['sendRecovery']>(overrides.sendRecovery ?? (async () => undefined)),
  }
}

export const INVITED_USER_ID = '7c1e0d52-0000-4000-8000-000000000099'

export function adminUserFixture(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: INVITED_USER_ID,
    email: 'new.nurse@example.test',
    fullName: 'Nina Nurse',
    role: 'nurse',
    status: 'invited',
    invitedAt: '2030-01-01T00:00:00.000Z',
    lastSignInAt: null,
    agencies: [],
    eligibleBranches: [{ id: BRANCH_ID, name: 'Downtown Clinic', agency: { id: AGENCY_ID, name: 'Northwind Care Staffing' }, status: 'active' }],
    ...overrides,
  }
}

export const SESSION_COOKIE = `sp_access=${SESSION.accessToken}`

/** Returns the Set-Cookie header lines as an array. */
export function setCookies(headers: Record<string, unknown>): string[] {
  const value = headers['set-cookie']
  if (value === undefined) return []
  return Array.isArray(value) ? value : [String(value)]
}

export function cookieFor(cookies: string[], name: string): string | undefined {
  return cookies.find((line) => line.startsWith(`${name}=`))
}

export const AGENCY_ID = 'a1000000-0000-4000-8000-000000000001'

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

export const NURSE_ID = 'c1000000-0000-4000-8000-000000000011'

export function eligibilityFixture(overrides: Partial<EligibilityRecord> = {}): EligibilityRecord {
  return { nurseId: NURSE_ID, branchId: BRANCH_ID, status: 'active', activatedAt: '2030-01-01T00:00:00.000Z', ...overrides }
}

export function nurseEligibilityFixture(overrides: Partial<NurseEligibility> = {}): NurseEligibility {
  return {
    nurse: { id: NURSE_ID, fullName: 'Ava Thompson' },
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
