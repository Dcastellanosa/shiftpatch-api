import cors from 'cors'
import express, { type ErrorRequestHandler } from 'express'
import type { Env } from './config/env.js'

export function createApp(env: Env) {
  const app = express()
  const allowedOrigins = new Set(env.CORS_ORIGINS)

  app.disable('x-powered-by')

  app.use(
    cors({
      // Requests without an Origin header (curl, server-to-server) are allowed;
      // browser requests from unlisted origins get no CORS headers.
      origin: (requestOrigin, callback) => {
        callback(null, !requestOrigin || allowedOrigins.has(requestOrigin))
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  )
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } })
  })

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err)
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } })
  }
  app.use(errorHandler)

  return app
}
