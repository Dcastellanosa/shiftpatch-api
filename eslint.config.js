import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Hexagonal dependency rule: dependencies point inward only.
// domain (types + ports) <- application (use cases) <- interfaces (http) / infrastructure (supabase, config) <- composition (create-app)
const httpFrameworks = [
  { group: ['express', 'express/*', 'cors', 'cookie-parser'], message: 'HTTP frameworks belong in src/interfaces/http.' },
]
const supabase = [{ group: ['@supabase/*'], message: 'Supabase belongs in src/infrastructure.' }]
const validation = [{ group: ['zod'], message: 'Input validation belongs in src/interfaces/http or an infrastructure adapter.' }]
const frameworks = [...httpFrameworks, ...supabase, ...validation]
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
        { patterns: [...frameworks, ...outerLayers('application', 'interfaces', 'infrastructure', 'composition')] },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [...frameworks, ...outerLayers('interfaces', 'infrastructure', 'composition')] },
      ],
    },
  },
  {
    files: ['src/interfaces/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [...supabase, ...outerLayers('composition', 'infrastructure')] },
      ],
    },
  },
  {
    files: ['src/infrastructure/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [...httpFrameworks, ...outerLayers('composition', 'interfaces')] },
      ],
    },
  },
])
