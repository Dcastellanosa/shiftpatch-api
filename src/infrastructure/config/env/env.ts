import { z } from 'zod'

// Treat empty strings (e.g. `KEY=` copied from .env.example) as unset.
const blankAsUndefined = (value: unknown) => (value === '' ? undefined : value)

const origin = z.url({ protocol: /^https?$/ }).refine((value) => new URL(value).origin === value, {
  message: 'must be a bare origin like https://app.example.com (no path or trailing slash)',
})

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(blankAsUndefined, z.enum(['development', 'test', 'production']).default('development')),
    PORT: z.preprocess(blankAsUndefined, z.coerce.number().int().positive().default(3000)),
    CORS_ORIGINS: z.preprocess(
      blankAsUndefined,
      z
        .string('is required (comma-separated list of allowed origins)')
        .transform((value) =>
          value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        )
        .pipe(z.array(origin).min(1)),
    ),
    SUPABASE_URL: z.preprocess(blankAsUndefined, z.url({ protocol: /^https?$/ }).optional()),
    SUPABASE_PUBLISHABLE_KEY: z.preprocess(blankAsUndefined, z.string().optional()),
    // Server-only. Used for the SECURITY DEFINER commands (which client roles
    // cannot execute), public-id resolution and the Auth admin API.
    SUPABASE_SERVICE_ROLE_KEY: z.preprocess(blankAsUndefined, z.string().optional()),
    // Server-only. Verifies HS256 access tokens (local CLI stack, legacy hosted
    // projects). Projects signing with asymmetric keys are verified through
    // their JWKS and leave this unset. Never logged or echoed.
    SUPABASE_JWT_SECRET: z.preprocess(blankAsUndefined, z.string().min(32).optional()),
    // Origin of the web app that receives invitation and recovery links
    // (<origin>/set-password). Defaults to the first CORS origin.
    WEB_ORIGIN: z.preprocess(blankAsUndefined, origin.optional()),
  })
  .refine((env) => Boolean(env.SUPABASE_URL) === Boolean(env.SUPABASE_PUBLISHABLE_KEY), {
    message: 'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set together',
    path: ['SUPABASE_PUBLISHABLE_KEY'],
  })

export type Env = z.infer<typeof envSchema>

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    // Only key paths and messages are reported; values are never echoed.
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return result.data
}

/**
 * The trial specification's password for every sample account. It is a
 * required public test credential, not an application secret, so it is the
 * default of `pnpm seed`, `pnpm e2e:reset` and the integration suite.
 */
export const TRIAL_SEED_PASSWORD = 'Trial2026!'

const seedEnvSchema = z.object({
  NODE_ENV: z.preprocess(blankAsUndefined, z.enum(['development', 'test', 'production']).default('development')),
  SUPABASE_URL: z.preprocess(blankAsUndefined, z.url({ protocol: /^https?$/ })),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(blankAsUndefined, z.string('is required')),
  SEED_USER_PASSWORD: z.preprocess(
    blankAsUndefined,
    z.string().min(8, 'must be at least 8 characters').default(TRIAL_SEED_PASSWORD),
  ),
})

export type SeedEnv = z.infer<typeof seedEnvSchema>

/** Environment for `pnpm seed`. Same reporting rules as `parseEnv`: values are never echoed. */
export function parseSeedEnv(source: NodeJS.ProcessEnv): SeedEnv {
  const result = seedEnvSchema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid seed configuration:\n${issues}`)
  }
  return result.data
}
