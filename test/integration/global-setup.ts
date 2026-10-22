import type { TestProject } from 'vitest/node'
import { TRIAL_SEED_PASSWORD } from '../../src/infrastructure/config/env/env.js'
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
  // The trial's own public password: the local database must look exactly like the evaluation one.
  const seedPassword = TRIAL_SEED_PASSWORD
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
