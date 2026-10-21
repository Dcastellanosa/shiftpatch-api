import { Router } from 'express'
import { z } from 'zod'
import type { AuthProvider } from '../../../../domain/ports/auth-provider/index.js'
import type { DataStore } from '../../../../domain/ports/data-store/index.js'
import { loadSessionPayload } from '../../../../application/session-payload/index.js'
import { signIn } from '../../../../application/sign-in/index.js'
import { signOut } from '../../../../application/sign-out/index.js'
import { AppError } from '../../errors/index.js'
import {
  clearSessionCookies,
  readSessionCookies,
  setSessionCookies,
  type SessionCookieConfig,
} from '../../session-cookies/index.js'
import { authUnavailable, requireSession, resolveSession } from '../../middleware/session/index.js'
import { validateBody } from '../../middleware/validate/index.js'

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

  router.post('/login', validateBody(loginBody), async (req, res) => {
    if (!provider) throw authUnavailable()
    const { email, password } = req.body as z.infer<typeof loginBody>

    const result = await signIn({ auth: provider, store }, email, password)
    if (!result.ok) {
      // One generic response for every rejection to avoid account enumeration.
      throw new AppError(401, 'invalid_credentials', 'Invalid email or password')
    }

    setSessionCookies(res, result.session, cookieConfig)
    res.json(result.payload)
  })

  router.post('/logout', async (req, res) => {
    const { accessToken } = readSessionCookies(req, cookieConfig)
    if (provider && accessToken) await signOut({ auth: provider }, accessToken)
    clearSessionCookies(res, cookieConfig)
    res.status(204).end()
  })

  router.get('/me', resolveSession(provider, cookieConfig), requireSession, async (req, res) => {
    res.json(await loadSessionPayload({ store }, req.auth!.user, req.auth!.accessToken))
  })

  return router
}
