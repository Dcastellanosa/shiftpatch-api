// Vercel serverless entrypoint. vercel.json rewrites every path here,
// and the Express app handles routing from the original request URL.
import { parseEnv } from '../src/infrastructure/config/env/index.js'
import { createApp } from '../src/composition/create-app/index.js'

export default createApp(parseEnv(process.env))
