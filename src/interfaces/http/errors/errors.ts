/**
 * The error envelope of every response: `error` is the safe user-facing
 * message (the shape the trial contract requires), `code` the machine-readable
 * reason, `details` optional field-level validation issues.
 */
export interface ErrorBody {
  error: string
  code: string
  details?: unknown
}

/** An error that maps directly to a safe HTTP response. */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }

  toBody(): ErrorBody {
    return {
      error: this.message,
      code: this.code,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

export const unauthenticated = () => new AppError(401, 'unauthenticated', 'Authentication required')
