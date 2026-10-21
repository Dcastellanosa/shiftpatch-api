import { vi } from 'vitest'
import type { AuthProvider, AuthSession } from '../domain/ports/auth-provider/auth-provider.js'
import type { DataStore } from '../domain/ports/data-store/data-store.js'
import { parseEnv } from '../infrastructure/config/env/env.js'
import { createApp } from '../composition/create-app/create-app.js'
import type { AuthUser, Profile, Viewer } from '../domain/viewer/viewer.js'
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
  }
}

export const NURSE_PROFILE: Profile = { id: USER.id, fullName: 'Ava Thompson', role: 'nurse', agencyId: null }
export const AGENCY_PROFILE: Profile = {
  id: USER.id,
  fullName: 'Riley Northwind',
  role: 'agency',
  agencyId: 'a1000000-0000-4000-8000-000000000001',
}
export const ADMIN_PROFILE: Profile = { id: USER.id, fullName: 'Morgan Admin', role: 'admin', agencyId: null }

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
    branch: { id: BRANCH_ID, name: 'Downtown Clinic', address: '120 Main Street', timezone: 'America/New_York' },
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
) {
  const env = parseEnv({ NODE_ENV: nodeEnv, CORS_ORIGINS: ALLOWED_ORIGIN })
  return createApp(env, { authProvider, dataStore })
}

/** An app whose cookie session resolves to USER, with the given data store. */
export function buildSignedInApp(dataStore: DataStore | null) {
  return buildApp(fakeAuthProvider({ getUser: async () => USER }), 'test', dataStore)
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
