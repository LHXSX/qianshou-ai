import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { providedCapabilityAdsForIds } from '@deepseek-ai/dsh-compute-core/node-capability'
import {
  keepAdvertisableCapabilityIds,
  marketCapabilityAds,
  readDeclaredCapabilityIds,
  readInstalledCapabilityIds,
  readMarketIds,
} from '../src/market-declarations.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Write one declaration file into a fresh home and return that home. */
async function homeWith(installed: readonly Record<string, unknown>[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-market-file-'))
  roots.push(home)
  await mkdir(join(home, 'qianshou'))
  await writeFile(join(home, 'qianshou', 'market-installed.json'), JSON.stringify({ version: 1, installed }))
  return home
}

it('drops capabilities this node cannot accept', () => {
  expect(keepAdvertisableCapabilityIds(['image.generate', 'text.transform', 'image.generate', 'nope'])).toEqual(['text.transform'])
  expect(marketCapabilityAds(['image.generate', 'text.transform'])).toEqual(providedCapabilityAdsForIds(['text.transform']))
  expect(JSON.stringify(marketCapabilityAds(['image.generate']))).not.toContain('image.generate')
})

it('treats a throwing reader as no market declaration', () => {
  expect(readMarketIds(undefined)).toEqual([])
  expect(readMarketIds(() => { throw new Error('unreadable') })).toEqual([])
})

it('repeats only a row its owner published, and only for a capability this node can accept', async () => {
  const home = await homeWith([
    { id: 'qianshou.article', capabilityId: 'text.transform', version: '1', installedAt: '2026-09-23T00:00:00.000Z', visibility: 'draft' },
    { id: 'qianshou.private', capabilityId: 'text.transform', version: '1', installedAt: '2026-09-23T00:00:00.000Z', visibility: 'private' },
    { id: 'qianshou.invited', capabilityId: 'text.transform', version: '1', installedAt: '2026-09-23T00:00:00.000Z', visibility: 'invite', inviteAccountIds: ['7'] },
    { id: 'qianshou.image', capabilityId: 'image.generate', version: '1', installedAt: '2026-09-23T00:00:00.000Z', visibility: 'public' },
    { id: 'qianshou.article', capabilityId: 'text.transform', version: '1', installedAt: '2026-09-23T00:00:00.000Z', visibility: 'public' },
  ])
  expect(readDeclaredCapabilityIds(join(home, 'qianshou', 'market-installed.json'))).toEqual(['text.transform'])
  // A published unknown row cannot borrow the built-in runner: `image.generate` is never advertised.
  expect(readInstalledCapabilityIds(home)).toEqual(['text.transform'])
})

it('keeps package-backed and unknown public rows out of hello, including a package that reused the built-in id', async () => {
  const home = await homeWith([
    { id: 'qianshou.article', capabilityId: 'text.transform', version: '1', packageSpec: 'other-package@1.0.0', visibility: 'public' },
    { id: 'qianshou.other', capabilityId: 'text.transform', version: '1', visibility: 'public' },
  ])
  expect(readInstalledCapabilityIds(home)).toEqual([])
})

it('treats a row written before visibility existed as a draft', async () => {
  const home = await homeWith([
    { id: 'qianshou.article', capabilityId: 'text.transform', version: '1', installedAt: '2026-09-23T00:00:00.000Z' },
  ])
  expect(readInstalledCapabilityIds(home)).toEqual([])
})

it('treats a visibility this build does not know as a draft', async () => {
  const home = await homeWith([
    { id: 'qianshou.article', capabilityId: 'text.transform', version: '1', installedAt: '2026-09-23T00:00:00.000Z', visibility: 'PUBLIC' },
  ])
  expect(readInstalledCapabilityIds(home)).toEqual([])
})

it('keeps the runner advertisement independent of what the market file published', async () => {
  const home = await homeWith([])
  const declared = marketCapabilityAds(readMarketIds(() => readInstalledCapabilityIds(home)))
  const runner = providedCapabilityAdsForIds(['text.transform'])
  expect(declared).toEqual([])
  // The runner's own advertisement is the caller's own list, not this reader's result.
  expect(JSON.stringify(runner)).toContain('text.transform')
})
