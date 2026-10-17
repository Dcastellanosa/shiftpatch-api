// Vercel serverless entrypoint. vercel.json rewrites every path here,
// and the Express app handles routing from the original request URL.
import { parseEnv } from '../src/config/env.js'
import { createApp } from '../src/create-app.js'

export default createApp(parseEnv(process.env))
