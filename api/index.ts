// Vercel serverless entrypoint. vercel.json rewrites every path here,
// and the Express app handles routing from the original request URL.
import { parseEnv } from '../src/infrastructure/config/env/env.js'
import { createApp } from '../src/composition/create-app/create-app.js'

export default createApp(parseEnv(process.env))
