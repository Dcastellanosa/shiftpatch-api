export interface ErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
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
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    }
  }
}

export const unauthenticated = () =>
  new AppError(401, 'unauthenticated', 'Authentication required')
