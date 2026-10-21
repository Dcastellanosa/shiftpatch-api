import type { AuthAdmin } from '../../domain/ports/auth-admin/auth-admin.js'

/**
 * Asks the provider to send a recovery email. Whether the address exists is
 * never revealed to the caller: the result is the same either way.
 */
export async function requestRecovery(
  { auth }: { auth: AuthAdmin },
  email: string,
  setPasswordUrl: string,
): Promise<void> {
  await auth.sendRecovery(email, setPasswordUrl)
}
