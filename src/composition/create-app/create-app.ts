import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import { createAuthRouter } from '../../interfaces/http/routes/auth-routes/index.js'
import { errorHandler, notFoundHandler } from '../../interfaces/http/error-handler/index.js'
import { requireTrustedOrigin } from '../../interfaces/http/middleware/origin-check/index.js'
import { requireSession, resolveSession } from '../../interfaces/http/middleware/session/index.js'
import { createShiftRouter } from '../../interfaces/http/routes/shift-routes/index.js'
import { createSupabaseAuthProvider } from '../../infrastructure/auth/supabase-auth-provider/index.js'
import { createSupabaseDataStore } from '../../infrastructure/persistence/supabase-data-store/index.js'
import type { AuthProvider } from '../../domain/ports/auth-provider/index.js'
import type { DataStore } from '../../domain/ports/data-store/index.js'
import type { Env } from '../../infrastructure/config/env/index.js'

export interface AppDependencies {
  /** Override for tests. `null` means auth is not configured. */
  authProvider?: AuthProvider | null
  /** Override for tests. `null` means the data layer is not configured. */
  dataStore?: DataStore | null
}

/**
 * Composition root: wires the driven adapters (Supabase) into the driving
 * adapter (Express). Tests inject fake ports through `deps`.
 */
export function createApp(env: Env, deps: AppDependencies = {}) {
  const app = express()
  const allowedOrigins = new Set(env.CORS_ORIGINS)
  const cookieConfig = { secure: env.NODE_ENV === 'production' }
  const authProvider =
    deps.authProvider !== undefined
      ? deps.authProvider
      : env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY
        ? createSupabaseAuthProvider({
            url: env.SUPABASE_URL,
            publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
          })
        : null
  const dataStore =
    deps.dataStore !== undefined
      ? deps.dataStore
      : env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY
        ? createSupabaseDataStore({
            url: env.SUPABASE_URL,
            publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
            serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
          })
        : null

  app.disable('x-powered-by')

  // The frontend calls this API same-origin through its /api proxy, so CORS
  // only matters for direct cross-origin calls (testing, future clients).
  app.use(
    cors({
      // Requests without an Origin header (curl, server-to-server) are allowed;
      // browser requests from unlisted origins get no CORS headers.
      origin: (requestOrigin, callback) => {
        callback(null, !requestOrigin || allowedOrigins.has(requestOrigin))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      maxAge: 600,
    }),
  )
  app.use(requireTrustedOrigin(allowedOrigins))
  app.use(cookieParser())
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.use('/auth', createAuthRouter(authProvider, dataStore, cookieConfig))
  app.use(createShiftRouter(dataStore, [resolveSession(authProvider, cookieConfig), requireSession]))

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
