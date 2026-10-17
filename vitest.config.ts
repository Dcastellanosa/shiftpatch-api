import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Database integration tests need a running Supabase stack: `pnpm test:db`.
    exclude: ['test/integration/**', 'node_modules/**'],
    environment: 'node',
  },
})
