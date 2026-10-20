import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import { createAuthRouter } from './adapters/http/auth-routes.js'
import { errorHandler, notFoundHandler } from './adapters/http/error-handler.js'
import { requireTrustedOrigin } from './adapters/http/origin-check.js'
import { requireSession, resolveSession } from './adapters/http/session-middleware.js'
import { createShiftRouter } from './adapters/http/shift-routes.js'
import { createSupabaseAuthProvider } from './adapters/supabase/supabase-auth-provider.js'
import { createSupabaseDataStore } from './adapters/supabase/supabase-data-store.js'
import type { AuthProvider } from './application/ports/auth-provider.js'
import type { DataStore } from './application/ports/data-store.js'
import type { Env } from './config/env.js'

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
