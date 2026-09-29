/** Actual Catalog/import services exercise the local-only RPC boundary and real destination. */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2,
  NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import SkillImport from '../../qianshou-skill-import/src/index.ts'
import Catalog from '../src/index.ts'
import type { H3OwnerSetupContextId, H3OwnerSelfTestId, H3CanonicalSetupContextId,
  H3CanonicalTrialId } from '../src/types.ts'
import { readNativeH3OrderSource } from '../src/native-h3-order-source.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllGlobals() })
const contextId = brandString<H3OwnerSetupContextId>('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const canonicalContextId = brandString<H3CanonicalSetupContextId>('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
const canonicalTrialId = brandString<H3CanonicalTrialId>('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
const binding = { binding: { schema: 'qianshou.native-h3-execution-binding.v2' as const,
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2, executionRecipeSha256: 'b'.repeat(64),
  modelSha256: 'c'.repeat(64), firstFrameSha256: 'd'.repeat(64) }, localOwnerConfigDigest: `sha256:${'e'.repeat(64)}` }
const canonicalBinding = { ...binding, binding: { ...binding.binding,
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL } }
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'qs-h3-facade-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SkillImport, { installRoot: join(root, 'skills'), agentsRoot: '' })
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: root, publisherKeys: {} })
  const state = { phase: 'authenticated', account: { id: '7' } }
  ctx.provide('qianshouAccount', { state: async () => state })
  ctx.provide('profileContext', { dir: root })
  const verify = vi.fn(async (revision: number, providedContext: H3OwnerSetupContextId) => {
    if (revision !== 1 || providedContext !== contextId || state.account.id !== '7') throw new Error('H3_SETUP_OWNER_CHANGED')
    return binding
  })
  const start = vi.fn(async () => { throw new Error('H3_SETUP_SELF_TEST_UNKNOWN') })
  const canonicalStart = vi.fn(async () => { throw new Error('H3_CANONICAL_TRIAL_UNKNOWN') })
  const verifyCanonical = vi.fn(async (request: { revision: number; contextId: H3CanonicalSetupContextId }) => {
    if (request.revision !== 1 || request.contextId !== canonicalContextId || state.account.id !== '7') {
      throw new Error('H3_SETUP_OWNER_CHANGED')
    }
    return canonicalBinding
  })
  ctx.provide('nodeContributor', { inspectH3OwnerSetup: async () => ({ contextId, kind: 'current', runtime: 'v2',
    revision: 1, configured: true, state: 'ready', code: 'H3_SETUP_SELF_TEST_VERIFIED' }),
  verifiedH3OwnerSetupBinding: verify, startH3OwnerSelfTest: start,
  inspectH3CanonicalSetup: async () => ({ kind: 'current', contextId: canonicalContextId, runtime: 'canonical',
    configured: true, revision: 1, state: 'saved', code: 'H3_CANONICAL_SAVED', samples: [] }),
  saveH3CanonicalSetup: async () => ({ contextId: canonicalContextId, revision: 1, state: 'saved' }),
  startH3CanonicalTrial: canonicalStart,
  h3CanonicalTrialStatus: async () => ({ operationId: canonicalTrialId, revision: 1, sample: 1,
    state: 'unknown', code: 'H3_CANONICAL_TRIAL_UNKNOWN', startedAt: 1 }),
  verifiedH3CanonicalSetupBinding: verifyCanonical,
  h3OwnerSelfTestStatus: async () => ({ operationId: brandString<H3OwnerSelfTestId>('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    revision: 1, state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN', startedAt: 1 }) })
  const network = vi.fn(() => { throw new Error('No cloud or GPU call is allowed') }); vi.stubGlobal('fetch', network)
  return { ctx, root, state, verify, start, verifyCanonical, canonicalStart, network, catalog: ctx.qianshouPluginCatalog }
}
const request = { contextId, revision: 1, name: 'qs-facade-draft', displayName: '我的视频技能', description: '中文描述生成五秒视频。' }
const canonicalRequest = { ...request, contextId: canonicalContextId, name: 'qs-canonical-draft' }

it('routes the canonical namespace to its own real local draft and never calls the V2 verifier', async () => {
  const f = await fixture()
  expect(await f.catalog.createH3CanonicalSkillDraft(canonicalRequest)).toEqual({ state: 'draft', revision: 1,
    name: canonicalRequest.name, displayName: canonicalRequest.displayName, published: false })
  const source = await readNativeH3OrderSource(join(f.root, 'skills', canonicalRequest.name, 'SKILL.md'))
  expect(source.taskDefinition.nativeBinding.runtimeAbi).toBe(NATIVE_H3_RUNTIME_ABI_CANONICAL)
  expect(f.verifyCanonical).toHaveBeenCalled()
  expect(f.verify).not.toHaveBeenCalled()
  expect(f.network).not.toHaveBeenCalled()
  expect(f.canonicalStart).not.toHaveBeenCalled()
})

it('reads an unknown canonical operation without retrying either runtime', async () => {
  const f = await fixture()
  expect(await f.catalog.h3CanonicalTrialStatus(canonicalTrialId)).toMatchObject({ state: 'unknown' })
  await expect(f.catalog.startH3CanonicalTrial({ contextId: canonicalContextId, revision: 1,
    sample: 1, prompt: '山峦清晨' })).rejects.toThrow('H3_CANONICAL_TRIAL_UNKNOWN')
  expect(f.canonicalStart).toHaveBeenCalledOnce()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.network).not.toHaveBeenCalled()
})

it('routes actual local creation through the real importer and verifies the same V2 source with no cloud call', async () => {
  const f = await fixture()
  expect(await f.catalog.inspectH3OwnerSetup()).toMatchObject({ contextId, state: 'ready' })
  expect(await f.catalog.createH3SkillDraft(request)).toEqual({ state: 'draft', revision: 1, name: request.name,
    displayName: request.displayName, published: false })
  const skill = join(f.root, 'skills', request.name, 'SKILL.md')
  expect((await readNativeH3OrderSource(skill)).declaration.contractVersion).toBe('v2')
  expect(await readFile(skill, 'utf8')).toContain('我的视频技能')
  expect(f.verify.mock.calls.every(([revision, id]) => revision === 1 && id === contextId)).toBe(true)
  expect(f.network).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})

it('requires current normal authentication and never falls back to any account-session token', async () => {
  const f = await fixture(); f.state.phase = 'anonymous'
  f.ctx.provide('accountSession', { ensureAccessToken: async () => { throw new Error('Token fallback forbidden') } })
  await expect(f.catalog.createH3SkillDraft(request)).rejects.toThrow('H3_SETUP_LOGIN_REQUIRED')
  expect(f.verify).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled()
})

it('does not relabel an old author request as a new author with the same revision', async () => {
  const f = await fixture(); f.state.account.id = '8'
  await expect(f.catalog.createH3SkillDraft(request)).rejects.toThrow('H3_SETUP_OWNER_CHANGED')
  await expect(readFile(join(f.root, 'skills', request.name, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.network).not.toHaveBeenCalled()
})

it('returns the real unknown operation without retrying generation or leaking diagnostics', async () => {
  const f = await fixture()
  expect(await f.catalog.h3OwnerSelfTestStatus(brandString<H3OwnerSelfTestId>('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')))
    .toMatchObject({ state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  await expect(f.catalog.startH3OwnerSelfTest({ contextId, revision: 1, prompt: '自然中文描述' }))
    .rejects.toThrow('H3_SETUP_SELF_TEST_UNKNOWN')
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.network).not.toHaveBeenCalled()
})
