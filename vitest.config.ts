import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests live next to the file they cover (`foo.ts` + `foo.test.ts`).
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test-support/**',
        'src/types/**',
        // Local-only entrypoint; it just calls createApp().listen().
        'src/dev-server.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
})
