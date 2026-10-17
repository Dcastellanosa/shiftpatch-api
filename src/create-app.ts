import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type ErrorRequestHandler } from 'express'
import {
  AuthRateLimitedError,
  AuthUnavailableError,
  type AuthProvider,
} from './auth/auth-provider.js'
import { createAuthRouter } from './auth/auth-routes.js'
import { createSupabaseAuthProvider } from './auth/supabase-auth-provider.js'
import type { Env } from './config/env.js'
import { AppError } from './http/errors.js'
import { requireTrustedOrigin } from './http/origin-check.js'

export interface AppDependencies {
  /** Override for tests. `null` means auth is not configured. */
  authProvider?: AuthProvider | null
}

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

  app.use('/auth', createAuthRouter(authProvider, cookieConfig))

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } })
  })

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json(err.toBody())
      return
    }
    if (err instanceof AuthRateLimitedError) {
      res.status(429).json({ error: { code: 'rate_limited', message: err.message } })
      return
    }
    if (err instanceof AuthUnavailableError) {
      res.status(503).json({ error: { code: 'auth_unavailable', message: err.message } })
      return
    }
    const parserType = (err as { type?: unknown }).type
    if (parserType === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } })
      return
    }
    if (parserType === 'entity.too.large') {
      res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } })
      return
    }

    // Log only the error name and message: never request data, cookies,
    // tokens, headers, or third-party error objects.
    const name = err instanceof Error ? err.name : 'UnknownError'
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Unhandled error: ${name}: ${message}`)
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } })
  }
  app.use(errorHandler)

  return app
}
