/**
 * `pnpm e2e:api` — starts the API against the local Supabase stack for
 * end-to-end runs. Ignores `.env` entirely: every value comes from
 * `supabase status` (local keys, in memory only) or from the E2E_* variables
 * below, so a run can never reach a hosted project.
 *
 *   E2E_API_PORT    port to listen on (default 3100)
 *   E2E_WEB_ORIGIN  the web app's origin, allowed for CORS and used in
 *                   invitation/recovery links (default http://localhost:5173)
 */
import { createApp } from '../src/composition/create-app/create-app.js'
import { parseEnv } from '../src/infrastructure/config/env/env.js'
import { localStack } from './local-stack.js'

const stack = localStack()
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:5173'
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(webOrigin)) {
  console.error('E2E_WEB_ORIGIN must be a local http origin such as http://localhost:5173')
  process.exit(1)
}

const env = parseEnv({
  NODE_ENV: 'test',
  PORT: process.env.E2E_API_PORT ?? '3100',
  CORS_ORIGINS: webOrigin,
  WEB_ORIGIN: webOrigin,
  SUPABASE_URL: stack.apiUrl,
  SUPABASE_PUBLISHABLE_KEY: stack.publishableKey,
  SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
  SUPABASE_JWT_SECRET: stack.jwtSecret,
})

createApp(env).listen(env.PORT, () => {
  console.log(`shiftpatch-api (e2e) listening on http://localhost:${env.PORT} against the local Supabase stack`)
})
