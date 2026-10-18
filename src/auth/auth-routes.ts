import { Router } from 'express'
import { z } from 'zod'
import { toSessionPayload } from '../application/session-payload.js'
import { AppError } from '../http/errors.js'
import { validateBody } from '../http/validate.js'
import type { DataStore } from '../data/data-store.js'
import type { AuthProvider, AuthUser } from './auth-provider.js'
import {
  clearSessionCookies,
  readSessionCookies,
  setSessionCookies,
  type SessionCookieConfig,
} from './session-cookies.js'
import { authUnavailable, requireSession, resolveSession } from './session-middleware.js'

const loginBody = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
})

export function createAuthRouter(
  provider: AuthProvider | null,
  store: DataStore | null,
  cookieConfig: SessionCookieConfig,
) {
  const router = Router()

  // Profile fields are filled from the caller's own profile row when the data
  // layer is configured; otherwise they stay null.
  const payloadFor = async (user: AuthUser, accessToken: string) =>
    toSessionPayload(user, store ? await store.getProfile(accessToken, user.id) : null)

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
    res.json(await payloadFor(session.user, session.accessToken))
  })

  router.post('/logout', async (req, res) => {
    const { accessToken } = readSessionCookies(req, cookieConfig)
    if (provider && accessToken) await provider.signOut(accessToken)
    clearSessionCookies(res, cookieConfig)
    res.status(204).end()
  })

  router.get('/me', resolveSession(provider, cookieConfig), requireSession, async (req, res) => {
    res.json(await payloadFor(req.auth!.user, req.auth!.accessToken))
  })

  return router
}
