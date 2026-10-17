import { Router } from 'express'
import { z } from 'zod'
import { AppError } from '../http/errors.js'
import { validateBody } from '../http/validate.js'
import type { AuthProvider } from './auth-provider.js'
import {
  clearSessionCookies,
  readSessionCookies,
  setSessionCookies,
  type SessionCookieConfig,
} from './session-cookies.js'
import { authUnavailable, requireSession, resolveSession } from './session-middleware.js'
import { toSessionPayload } from './session-user.js'

const loginBody = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
})

export function createAuthRouter(provider: AuthProvider | null, cookieConfig: SessionCookieConfig) {
  const router = Router()

  router.post('/login', validateBody(loginBody), async (req, res) => {
    if (!provider) throw authUnavailable()
    const { email, password } = req.body as z.infer<typeof loginBody>

    const session = await provider.signInWithPassword(email, password)
    if (!session) {
      // One generic response for every rejection (unknown email, wrong
      // password, unconfirmed account) to avoid account enumeration.
      throw new AppError(401, 'invalid_credentials', 'Invalid email or password')
    }

    setSessionCookies(res, session, cookieConfig)
    res.json(toSessionPayload(session.user))
  })

  router.post('/logout', async (req, res) => {
    const { accessToken } = readSessionCookies(req, cookieConfig)
    if (provider && accessToken) await provider.signOut(accessToken)
    clearSessionCookies(res, cookieConfig)
    res.status(204).end()
  })

  router.get('/me', resolveSession(provider, cookieConfig), requireSession, (req, res) => {
    res.json(toSessionPayload(req.auth!.user))
  })

  return router
}
