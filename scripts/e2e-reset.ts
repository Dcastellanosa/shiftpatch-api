/**
 * `pnpm e2e:reset` — local-only reset for end-to-end runs.
 *
 * Re-creates the local database from `supabase/migrations` and seeds it with
 * the password in SEED_USER_PASSWORD (chosen per run by the caller, never
 * stored). Refuses anything but the local Supabase stack and prints nothing
 * sensitive.
 */
import { execFileSync } from 'node:child_process'
import { localStack, seedWhenReady } from './local-stack.js'

const password = process.env.SEED_USER_PASSWORD ?? ''
if (password.length < 8) {
  console.error('SEED_USER_PASSWORD must be set (at least 8 characters) for the seeded accounts of this run.')
  process.exit(1)
}

const stack = localStack()
execFileSync('supabase', ['db', 'reset', '--local'], { stdio: ['ignore', 'inherit', 'inherit'] })
await seedWhenReady({ url: stack.apiUrl, serviceRoleKey: stack.serviceRoleKey, password })
console.log('Local database reset and seeded for end-to-end tests.')
