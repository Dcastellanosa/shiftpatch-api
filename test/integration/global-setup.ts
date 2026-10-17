import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { seedDatabase } from '../../scripts/seed.js'

export interface LocalStack {
  apiUrl: string
  publishableKey: string
  serviceRoleKey: string
  dbUrl: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    stack: LocalStack
    seedPassword: string
  }
}

/**
 * Connection details for the local Supabase stack. These are the CLI's
 * per-machine local development keys, read at runtime and never printed.
 */
function localStack(): LocalStack {
  let raw: string
  try {
    raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    throw new Error('Local Supabase is not running. Start it with `supabase start` (see README).')
  }
  const status = JSON.parse(raw) as Record<string, string | undefined>
  const required = (key: string) => {
    const value = status[key]
    if (!value) throw new Error(`supabase status did not report ${key}`)
    return value
  }
  const apiUrl = required('API_URL')
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(apiUrl)) {
    throw new Error('Refusing to run integration tests against a non-local Supabase instance')
  }
  return {
    apiUrl,
    publishableKey: status.PUBLISHABLE_KEY ?? required('ANON_KEY'),
    serviceRoleKey: status.SECRET_KEY ?? required('SERVICE_ROLE_KEY'),
    dbUrl: required('DB_URL'),
  }
}

export default async function setup(project: TestProject) {
  const stack = localStack()
  // A throwaway password for this run's seeded accounts.
  const seedPassword = randomBytes(18).toString('base64url')
  await seedDatabase({ url: stack.apiUrl, serviceRoleKey: stack.serviceRoleKey, password: seedPassword })
  project.provide('stack', stack)
  project.provide('seedPassword', seedPassword)
}
