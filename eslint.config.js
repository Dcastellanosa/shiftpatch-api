import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Hexagonal dependency rule: dependencies point inward only.
// domain <- application (use cases + ports) <- adapters (http, supabase) <- create-app (composition root)
const frameworks = [
  { group: ['express', 'express/*', 'cors', 'cookie-parser'], message: 'HTTP frameworks belong in src/adapters/http.' },
  { group: ['@supabase/*'], message: 'Supabase belongs in src/adapters/supabase.' },
  { group: ['zod'], message: 'Input validation belongs in the adapters.' },
]
const outerLayers = (...layers) =>
  layers.map((layer) => ({
    group: [`**/${layer}/**`, `**/${layer}.js`],
    message: `Inner layers must not depend on ${layer}.`,
  }))

export default defineConfig([
  globalIgnores(['dist', 'coverage', '.vercel', 'graphify-out', '.agents', '.claude', '.codex', '.kiro', 'skills']),
  {
    files: ['**/*.{ts,js}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [...frameworks, ...outerLayers('application', 'adapters', 'config', 'create-app')] },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [...frameworks, ...outerLayers('adapters', 'config', 'create-app')] },
      ],
    },
  },
  {
    files: ['src/adapters/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: outerLayers('create-app', 'config') },
      ],
    },
  },
])
