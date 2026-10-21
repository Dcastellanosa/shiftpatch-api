import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import { createAuthRouter } from '../../interfaces/http/routes/auth-routes/auth-routes.js'
import { errorHandler, notFoundHandler } from '../../interfaces/http/error-handler/error-handler.js'
import { requireTrustedOrigin } from '../../interfaces/http/middleware/origin-check/origin-check.js'
import { requireSession, resolveSession } from '../../interfaces/http/middleware/session/session.js'
import { createAdminRouter } from '../../interfaces/http/routes/admin-routes/admin-routes.js'
import { createEligibilityRouter } from '../../interfaces/http/routes/eligibility-routes/eligibility-routes.js'
import { createShiftRouter } from '../../interfaces/http/routes/shift-routes/shift-routes.js'
import { createSupabaseAuthAdmin } from '../../infrastructure/auth/supabase-auth-admin/supabase-auth-admin.js'
import { createSupabaseAuthProvider } from '../../infrastructure/auth/supabase-auth-provider/supabase-auth-provider.js'
import { createSupabaseDataStore } from '../../infrastructure/persistence/supabase-data-store/supabase-data-store.js'
import type { AuthAdmin } from '../../domain/ports/auth-admin/auth-admin.js'
import type { AuthProvider } from '../../domain/ports/auth-provider/auth-provider.js'
import type { DataStore } from '../../domain/ports/data-store/data-store.js'
import type { Env } from '../../infrastructure/config/env/env.js'

export interface AppDependencies {
  /** Override for tests. `null` means auth is not configured. */
  authProvider?: AuthProvider | null
  /** Override for tests. `null` means the data layer is not configured. */
  dataStore?: DataStore | null
  /** Override for tests. `null` means invitations and link exchanges are not configured. */
  authAdmin?: AuthAdmin | null
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

  const authAdmin =
    deps.authAdmin !== undefined
      ? deps.authAdmin
      : env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY
        ? createSupabaseAuthAdmin({
            url: env.SUPABASE_URL,
            publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
            serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
          })
        : null
  // Invitation and recovery links point at the web app, never at this API.
  const setPasswordUrl = `${env.WEB_ORIGIN ?? env.CORS_ORIGINS[0]!}/set-password`

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
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      // Authorization: API clients may call cross-origin with a bearer token.
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  )
  app.use(requireTrustedOrigin(allowedOrigins))
  app.use(cookieParser())
  app.use(express.json({ limit: '100kb' }))

  // One router, mounted twice: the web app reaches it with the `/api` prefix
  // already stripped by its proxy; API clients hitting this host directly
  // keep the prefix (`/api/auth/login`, as the trial contract reads).
  const routes = express.Router()
  routes.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })
  routes.use('/auth', createAuthRouter({ provider: authProvider, store: dataStore, cookieConfig, authAdmin, setPasswordUrl }))
  const authenticate = [resolveSession(authProvider, cookieConfig), requireSession]
  routes.use(createShiftRouter(dataStore, authenticate))
  routes.use(createEligibilityRouter(dataStore, authenticate))
  routes.use('/admin', createAdminRouter({ store: dataStore, authAdmin, setPasswordUrl }, authenticate))
  app.use(routes)
  app.use('/api', routes)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
