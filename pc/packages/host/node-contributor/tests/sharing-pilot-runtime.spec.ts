/** Run the shipped Node-only runtime against real CPU HTTP/SQLite fixtures. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('preserves one GPU submission and denies late owner access across eight real runtime CPU regressions', { timeout: 30_000 }, async () => {
  const result = await promisify(execFile)(process.execPath, ['--test', fileURLToPath(new URL('./fixtures/comfy-pilot-node-tests.mjs', import.meta.url))],
    { timeout: 25_000, maxBuffer: 1024 * 1024 })
  expect(result.stdout).toMatch(/# pass 8/u)
  expect(result.stdout).toMatch(/# fail 0/u)
})
