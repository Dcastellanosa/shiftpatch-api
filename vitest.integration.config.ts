import { defineConfig } from 'vitest/config'

// Database integration suite (`pnpm test:db`). Runs against the local Supabase
// stack (`supabase start`) after `supabase db reset` re-applies migrations.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/integration/global-setup.ts'],
    // One shared database: run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
