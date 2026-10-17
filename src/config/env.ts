import { z } from 'zod'

// Treat empty strings (e.g. `KEY=` copied from .env.example) as unset.
const blankAsUndefined = (value: unknown) => (value === '' ? undefined : value)

const origin = z
  .url({ protocol: /^https?$/ })
  .refine((value) => new URL(value).origin === value, {
    message: 'must be a bare origin like https://app.example.com (no path or trailing slash)',
  })

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      blankAsUndefined,
      z.enum(['development', 'test', 'production']).default('development'),
    ),
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
    // Reserved for future privileged backend-only work. Not used by auth.
    SUPABASE_SERVICE_ROLE_KEY: z.preprocess(blankAsUndefined, z.string().optional()),
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
