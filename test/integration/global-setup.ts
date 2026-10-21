import { randomBytes } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { localStack, seedWhenReady, type LocalStack } from '../../scripts/local-stack.js'

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
  await seedWhenReady({ url: stack.apiUrl, serviceRoleKey: stack.serviceRoleKey, password: seedPassword })
  project.provide('stack', stack)
  project.provide('seedPassword', seedPassword)
}
