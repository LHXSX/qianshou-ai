import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  loadArtifactAdapterSelection, saveArtifactAdapterSelection,
} from '../src/artifact-adapter-selection.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-artifact-choice-'))
  dirs.push(dir)
  return dir
}

const choice = {
  root: '/private/install/svg-to-video/scripts/order_adapter', digest: 'a'.repeat(64),
  packageDigest: 'b'.repeat(64),
  inventoryAlgorithm: 'qianshou.bar-chart-package.v4' as const,
  pythonPath: '/usr/local/bin/python3', swiftPath: '/usr/bin/swift',
}

it('persists one exact digest-pinned choice with private permissions', async () => {
  const dir = await profile()
  expect(loadArtifactAdapterSelection(dir, null)).toEqual({ selection: null, valid: true })
  await saveArtifactAdapterSelection(dir, choice)
  expect(loadArtifactAdapterSelection(dir, null)).toEqual({ selection: choice, valid: true })
  const file = join(dir, 'qianshou-artifact-adapter.json')
  expect((await lstat(file)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 4, ...choice })
})

it('fails closed on tampering and refuses a symlink destination', async () => {
  const dir = await profile()
  const file = join(dir, 'qianshou-artifact-adapter.json')
  await writeFile(file, JSON.stringify({ version: 2, ...choice, digest: 'bad' }))
  expect(loadArtifactAdapterSelection(dir, choice)).toEqual({ selection: null, valid: false })
  await rm(file)
  const target = join(dir, 'other.json')
  await writeFile(target, '{}')
  await symlink(target, file)
  expect(loadArtifactAdapterSelection(dir, choice)).toEqual({ selection: null, valid: false })
  await expect(saveArtifactAdapterSelection(dir, choice)).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe('{}')
})

it('preserves old v2/v3 choice bytes but never treats their digest as v4', async () => {
  const dir = await profile()
  const file = join(dir, 'qianshou-artifact-adapter.json')
  const legacy = JSON.stringify({ version: 2, ...choice })
  await writeFile(file, legacy)
  expect(loadArtifactAdapterSelection(dir, null)).toEqual({ selection: null, valid: false })
  expect(await readFile(file, 'utf8')).toBe(legacy)
  await writeFile(file, JSON.stringify({ version: 3, ...choice }))
  expect(loadArtifactAdapterSelection(dir, null)).toEqual({ selection: null, valid: false })
})
