import { randomBytes } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { localStack, seedWhenReady, type LocalStack } from '../../scripts/local-stack.js'
import { seedDatabase } from '../../scripts/seed.js'
import { FIXTURE_DATASET } from './fixtures.js'

declare module 'vitest' {
  export interface ProvidedContext {
    stack: LocalStack
    seedPassword: string
  }
}

export default async function setup(project: TestProject) {
  const stack = localStack()
  // A throwaway password for this run's seeded accounts.
  const seedPassword = randomBytes(18).toString('base64url')
  // The trial dataset first (what `pnpm seed` loads), then the suite's own fixtures on top.
  await seedWhenReady({ url: stack.apiUrl, serviceRoleKey: stack.serviceRoleKey, password: seedPassword })
  await seedDatabase({
    url: stack.apiUrl,
    serviceRoleKey: stack.serviceRoleKey,
    password: seedPassword,
    dataset: FIXTURE_DATASET,
  })
  project.provide('stack', stack)
  project.provide('seedPassword', seedPassword)
}
