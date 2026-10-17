// Local development only. On Vercel, api/index.ts is the entrypoint.
import { existsSync } from 'node:fs'
import { parseEnv } from './config/env.js'
import { createApp } from './create-app.js'

if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

const env = parseEnv(process.env)

createApp(env).listen(env.PORT, () => {
  console.log(`shiftpatch-api listening on http://localhost:${env.PORT}`)
})
