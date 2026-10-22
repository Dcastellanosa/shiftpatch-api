import { Router } from 'express'
import {
  completePassword,
  type CompletePasswordFailure,
} from '../../../../application/complete-password/complete-password.js'
import { requestRecovery } from '../../../../application/request-recovery/request-recovery.js'
import { loadSessionPayload } from '../../../../application/session-payload/session-payload.js'
import { signIn } from '../../../../application/sign-in/sign-in.js'
import { signOut } from '../../../../application/sign-out/sign-out.js'
import type { AuthAdmin } from '../../../../domain/ports/auth-admin/auth-admin.js'
import type { AuthProvider } from '../../../../domain/ports/auth-provider/auth-provider.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import type { TokenVerifier } from '../../../../domain/ports/token-verifier/token-verifier.js'
import { AppError } from '../../errors/errors.js'
import { authUnavailable, requireSession, resolveSession } from '../../middleware/session/session.js'
import { validateBody } from '../../middleware/validate/validate.js'
import {
  completePasswordBody,
  loginBody,
  recoverBody,
  type CompletePasswordBody,
  type LoginBody,
  type RecoverBody,
} from '../../schemas/auth/auth.js'
import { readBearer } from '../../bearer/bearer.js'
import type { SignInPayload } from '../../../../application/session-payload/session-payload.js'
import type { AuthSession } from '../../../../domain/ports/auth-provider/auth-provider.js'

export interface AuthRouterDependencies {
  provider: AuthProvider | null
  store: DataStore | null
  /** Validates bearer tokens for `GET /me`; `null` when auth is not configured. */
  verifier: TokenVerifier | null
  /** Privileged and one-time-link operations; `null` when no service-role key is configured. */
  authAdmin: AuthAdmin | null
  /** Absolute URL of the web app's set-password page, the base of every emailed link. */
  setPasswordUrl: string
}

const COMPLETE_PASSWORD_ERRORS: Record<CompletePasswordFailure, () => AppError> = {
  invalid_link: () => new AppError(401, 'This link is invalid or has expired. Request a new one.'),
  weak_password: () => new AppError(422, 'Choose a longer, less common password'),
}

/**
 * Sign-in responses carry the access token next to the safe user payload.
 * Clients keep it in memory and send it as `Authorization: Bearer`; the
 * refresh token is never returned, so an expired token means signing in again.
 */
const signInResponse = (session: AuthSession, payload: SignInPayload) => ({
  token: session.accessToken,
  user: payload.user,
})

export function createAuthRouter({ provider, store, verifier, authAdmin, setPasswordUrl }: AuthRouterDependencies) {
  const router = Router()

  router.post('/login', validateBody(loginBody), async (req, res) => {
    if (!provider) throw authUnavailable()
    const { email, password } = req.body as LoginBody

    const result = await signIn({ auth: provider, store }, email, password)
    if (!result.ok) {
      // One generic response for every rejection to avoid account enumeration.
      throw new AppError(401, 'Invalid email or password')
    }

    res.json(signInResponse(result.session, result.payload))
  })

  // Best-effort revocation of the presented token; always 204 so a client can
  // drop its token even when the provider is unreachable.
  router.post('/logout', async (req, res) => {
    const bearer = readBearer(req)
    if (provider && bearer.kind === 'token') await signOut({ auth: provider }, bearer.token)
    res.status(204).end()
  })

  router.get('/me', resolveSession(verifier), requireSession, async (req, res) => {
    res.json(await loadSessionPayload({ store }, req.auth!.user, req.auth!.accessToken))
  })

  // Public: finishes an invitation or a recovery and signs the user in; the
  // response is the same bearer session shape as `/login`.
  router.post('/complete-password', validateBody(completePasswordBody), async (req, res) => {
    if (!authAdmin) throw authUnavailable()
    const { tokenHash, type, password } = req.body as CompletePasswordBody

    const result = await completePassword({ auth: authAdmin, store }, tokenHash, type, password)
    if (!result.ok) throw COMPLETE_PASSWORD_ERRORS[result.outcome]()

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
