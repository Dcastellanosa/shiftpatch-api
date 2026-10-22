/**
 * `pnpm e2e:reset` — local-only reset for end-to-end runs.
 *
 * Re-creates the local database from `supabase/migrations` and seeds exactly
 * the trial dataset with its specified password (`Trial2026!`, overridable
 * through SEED_USER_PASSWORD). Refuses anything but the local Supabase stack.
 */
import { execFileSync } from 'node:child_process'
import { TRIAL_SEED_PASSWORD } from '../src/infrastructure/config/env/env.js'
import { localStack, seedWhenReady } from './local-stack.js'

const password = process.env.SEED_USER_PASSWORD || TRIAL_SEED_PASSWORD
if (password.length < 8) {
  console.error('SEED_USER_PASSWORD must be at least 8 characters.')
  process.exit(1)
}

const stack = localStack()
execFileSync('supabase', ['db', 'reset', '--local'], { stdio: ['ignore', 'inherit', 'inherit'] })
await seedWhenReady({ url: stack.apiUrl, serviceRoleKey: stack.serviceRoleKey, password })
console.log('Local database reset and seeded for end-to-end tests.')
