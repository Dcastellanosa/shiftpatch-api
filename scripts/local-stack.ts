/**
 * Connection details of the local Supabase stack (`supabase start`), read from
 * the CLI at run time. These are the CLI's per-machine development keys: they
 * are passed along in memory and never printed or written anywhere.
 *
 * Every caller is a local-only tool (integration tests, end-to-end reset and
 * API launcher), so anything that is not a loopback address is refused.
 */
import { execFileSync } from 'node:child_process'
import { seedDatabase } from './seed.js'

export interface LocalStack {
  apiUrl: string
  publishableKey: string
  serviceRoleKey: string
  dbUrl: string
  /** Mailpit, where the local stack delivers every email. */
  mailUrl: string
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/

export function localStack(cwd = process.cwd()): LocalStack {
  let raw: string
  try {
    raw = execFileSync('supabase', ['status', '-o', 'json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    throw new Error('Local Supabase is not running. Start it with `pnpm db:start` (see README).')
  }
  const status = JSON.parse(raw) as Record<string, string | undefined>
  const required = (key: string) => {
    const value = status[key]
    if (!value) throw new Error(`supabase status did not report ${key}`)
    return value
  }
  const apiUrl = required('API_URL')
  const mailUrl = status.MAILPIT_URL ?? required('INBUCKET_URL')
  if (!LOOPBACK.test(apiUrl) || !LOOPBACK.test(mailUrl)) {
    throw new Error('Refusing to use a Supabase stack that is not local')
  }
  return {
    apiUrl,
    publishableKey: status.PUBLISHABLE_KEY ?? required('ANON_KEY'),
    serviceRoleKey: status.SECRET_KEY ?? required('SERVICE_ROLE_KEY'),
    dbUrl: required('DB_URL'),
    mailUrl,
  }
}

/** PostgREST reloads its schema cache shortly after `db reset`; seeding before that fails transiently. */
export async function seedWhenReady(options: Parameters<typeof seedDatabase>[0]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await seedDatabase(options)
    } catch (error) {
      if (attempt >= 15 || !/schema cache/i.test(String((error as Error).message))) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}
