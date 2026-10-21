import type { PasswordLinkType } from '../../admin/admin.js'
import type { AuthSession } from '../auth-provider/auth-provider.js'

/**
 * Driven port: privileged and one-time-link authentication operations.
 * Methods resolve to a string outcome for conditions the caller handles and
 * throw `AuthUnavailableError` / `AuthRateLimitedError` otherwise. Nothing
 * here ever returns a link, token hash or password.
 */
export interface AuthAdmin {
  /** Creates the Auth user and sends the invitation email with `redirectTo` as the link base. */
  inviteUser(email: string, options: { fullName: string; redirectTo: string }): Promise<{ id: string } | 'email_exists'>
  /** Removes an Auth user (compensation when provisioning fails). */
  deleteUser(userId: string): Promise<void>
  /**
   * Exchanges a one-time link hash for a session and sets the password. The
   * session is returned only when the password update succeeded; on every
   * failure the provisional session is revoked best-effort.
   */
  completePassword(tokenHash: string, type: PasswordLinkType, password: string): Promise<AuthSession | 'invalid_link' | 'weak_password'>
  /** Sends a recovery email when the address exists; silent otherwise. */
  sendRecovery(email: string, redirectTo: string): Promise<void>
}
