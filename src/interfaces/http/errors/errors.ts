/**
 * The error envelope of every response, exactly as the trial contract reads:
 * `{ "error": "<message>" }`. The message is the safe, user-facing text; no
 * machine code, details or nesting are ever added.
 */
export interface ErrorBody {
  error: string
}

/** An error that maps directly to a safe HTTP response. */
export class AppError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AppError'
    this.status = status
  }

  toBody(): ErrorBody {
    return { error: this.message }
  }
}

export const unauthenticated = () => new AppError(401, 'Authentication required')
export const invalidToken = () => new AppError(401, 'Invalid or expired token')
