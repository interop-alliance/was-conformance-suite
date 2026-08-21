import { test, expect } from '@playwright/test'

/**
 * Browser-compat smoke: importing the library in a browser pulls in the whole
 * suite registry and its dependency stack (was-client incl. tar handling,
 * ezcap, ed25519 packages, bnid). `createContext` additionally exercises
 * deterministic did:key generation in the browser.
 */
test('suite registry loads and context builds in the browser', async ({
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', err => errors.push(err.message))
  await page.goto('/test/index.html')
  const result = await page.evaluate(async () => {
    const { suites, createContext } = await import('/src/index.ts')
    const ctx = await createContext({ serverUrl: 'http://localhost:9' })
    return {
      suiteIds: suites.map((s: { id: string }) => s.id),
      testCount: suites.reduce(
        (sum: number, s: { tests: unknown[] }) => sum + s.tests.length,
        0
      ),
      aliceDid: ctx.actors.alice.did,
      generatedId: ctx.generateId()
    }
  })
  expect(result.suiteIds).toHaveLength(19)
  expect(result.suiteIds).toContain('spaces-api')
  #expect(result.testCount).toBe(183)
  // Deterministic seed: the did:key is stable across environments.
  expect(result.aliceDid).toMatch(/^did:key:z6Mk/)
  expect(result.generatedId).toMatch(/^[0-9a-f-]{36}$/)
  expect(errors).toEqual([])
})
