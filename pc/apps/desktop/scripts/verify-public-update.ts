/** Read back a packaged release from its public updater URL after upload. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createDesktopUploadPlan } from './desktop-upload-plan.ts'
import { verifyPublicDesktopUpdate } from './public-update-readback.ts'
import type { DesktopPackageTargetName } from './package-target.ts'

const TARGETS = new Set<DesktopPackageTargetName>(['mac-arm64', 'mac-x64', 'win-x64'])

async function main(): Promise<void> {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true })
  const target = positionals[0] as DesktopPackageTargetName | undefined
  if (target === undefined || positionals.length !== 1 || !TARGETS.has(target)) {
    throw new Error('desktop update readback: expected one target: mac-arm64, mac-x64, or win-x64')
  }
  const environment = loadDesktopPackageEnvironment(target === 'win-x64' ? 'win32' : 'darwin')
  const plan = await createDesktopUploadPlan(target, { environment, purpose: 'public-readback' })
  const parent = resolve(import.meta.dirname, '../.desktop-build/public-readback')
  await mkdir(parent, { recursive: true })
  const record = await mkdtemp(join(parent, `${plan.environment}-${target}-`))
  let result: object
  try {
    const artifacts = await verifyPublicDesktopUpdate(plan)
    result = { schemaVersion: 1, success: true, environment: plan.environment,
      target, version: plan.version, artifacts, observedAt: new Date().toISOString() }
  } catch (error) {
    result = { schemaVersion: 1, success: false, environment: plan.environment, target,
      version: plan.version, reason: error instanceof Error ? error.message : 'public readback failed',
      observedAt: new Date().toISOString() }
  }
  const output = join(record, 'result.json')
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true })
  process.stdout.write(`DESKTOP_PUBLIC_UPDATE_READBACK ${output}\n`)
  if (!('success' in result) || result.success !== true) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`desktop update readback: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
