import { Router } from 'express'
import { completePassword, type CompletePasswordFailure } from '../../../../application/complete-password/complete-password.js'
import { requestRecovery } from '../../../../application/request-recovery/request-recovery.js'
import { loadSessionPayload } from '../../../../application/session-payload/session-payload.js'
import { signIn } from '../../../../application/sign-in/sign-in.js'
import { signOut } from '../../../../application/sign-out/sign-out.js'
import type { AuthAdmin } from '../../../../domain/ports/auth-admin/auth-admin.js'
import type { AuthProvider } from '../../../../domain/ports/auth-provider/auth-provider.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import { AppError } from '../../errors/errors.js'
import { authUnavailable, requireSession, resolveSession } from '../../middleware/session/session.js'
import { validateBody } from '../../middleware/validate/validate.js'
import { completePasswordBody, loginBody, recoverBody, type CompletePasswordBody, type LoginBody, type RecoverBody } from '../../schemas/auth/auth.js'
import {
  clearSessionCookies,
  readBearerToken,
  readSessionCookies,
  setSessionCookies,
  type SessionCookieConfig,
} from '../../session-cookies/session-cookies.js'
import type { SessionPayload } from '../../../../application/session-payload/session-payload.js'
import type { AuthSession } from '../../../../domain/ports/auth-provider/auth-provider.js'

export interface AuthRouterDependencies {
  provider: AuthProvider | null
  store: DataStore | null
  cookieConfig: SessionCookieConfig
  /** Privileged and one-time-link operations; `null` when no service-role key is configured. */
  authAdmin: AuthAdmin | null
  /** Absolute URL of the web app's set-password page, the base of every emailed link. */
  setPasswordUrl: string
}

const COMPLETE_PASSWORD_ERRORS: Record<CompletePasswordFailure, () => AppError> = {
  invalid_link: () => new AppError(401, 'invalid_or_expired_link', 'This link is invalid or has expired. Request a new one.'),
  weak_password: () => new AppError(422, 'weak_password', 'Choose a longer, less common password'),
}

/**
 * Sign-in responses carry the access token for API clients (`Authorization:
 * Bearer`) next to the safe user payload. The refresh token stays in its
 * HttpOnly cookie only; the web app ignores `token` and relies on cookies.
 */
const signInResponse = (session: AuthSession, payload: SessionPayload) => ({ token: session.accessToken, ...payload })

export function createAuthRouter({ provider, store, cookieConfig, authAdmin, setPasswordUrl }: AuthRouterDependencies) {
  const router = Router()

  router.post('/login', validateBody(loginBody), async (req, res) => {
    if (!provider) throw authUnavailable()
    const { email, password } = req.body as LoginBody

    const result = await signIn({ auth: provider, store }, email, password)
    if (!result.ok) {
      // One generic response for every rejection to avoid account enumeration.
      throw new AppError(401, 'invalid_credentials', 'Invalid email or password')
    }

    setSessionCookies(res, result.session, cookieConfig)
    res.json(signInResponse(result.session, result.payload))
  })

  router.post('/logout', async (req, res) => {
    const accessToken = readBearerToken(req).accessToken ?? readSessionCookies(req, cookieConfig).accessToken
    if (provider && accessToken) await signOut({ auth: provider }, accessToken)
    clearSessionCookies(res, cookieConfig)
    res.status(204).end()
  })

  router.get('/me', resolveSession(provider, cookieConfig), requireSession, async (req, res) => {
    res.json(await loadSessionPayload({ store }, req.auth!.user, req.auth!.accessToken))
  })

  // Public: finishes an invitation or a recovery. Cookies are issued only
  // after the password update succeeded; failures carry no Set-Cookie at all.
  router.post('/complete-password', validateBody(completePasswordBody), async (req, res) => {
    if (!authAdmin) throw authUnavailable()
    const { tokenHash, type, password } = req.body as CompletePasswordBody

    const result = await completePassword({ auth: authAdmin, store }, tokenHash, type, password)
    if (!result.ok) throw COMPLETE_PASSWORD_ERRORS[result.outcome]()

    setSessionCookies(res, result.session, cookieConfig)
    res.json(signInResponse(result.session, result.payload))
  })

  // Public: always 204, whether or not the address exists or email is configured.
  router.post('/recover', validateBody(recoverBody), async (req, res) => {
    const { email } = req.body as RecoverBody
    if (authAdmin) await requestRecovery({ auth: authAdmin }, email, setPasswordUrl)
    res.status(204).end()
  })

  return router
}
