// Local development only. On Vercel, api/index.ts is the entrypoint.
import { existsSync } from 'node:fs'
import { parseEnv } from './infrastructure/config/env/env.js'
import { createApp } from './composition/create-app/create-app.js'

if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

const env = parseEnv(process.env)

createApp(env).listen(env.PORT, () => {
  console.log(`shiftpatch-api listening on http://localhost:${env.PORT}`)
  if (!env.SUPABASE_URL) {
    console.warn('Supabase is not configured: /auth/login and session validation will return 503.')
  }
})
