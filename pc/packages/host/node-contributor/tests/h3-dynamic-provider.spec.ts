/** Actual file generations are tested without external programs or GPU work. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI, NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_V2,
  NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { createDynamicH3VideoProvider, type H3ProviderConfiguration } from '../src/h3-dynamic-provider.ts'
import type { ArtifactOrderAdapter } from '../src/artifact-order.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const v1 = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME, ownerConfigDigest: `sha256:${'a'.repeat(64)}`,
  executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) }
const v2 = { binding: { schema: 'qianshou.native-h3-execution-binding.v2' as const,
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2, executionRecipeSha256: 'b'.repeat(64),
  modelSha256: 'c'.repeat(64), firstFrameSha256: 'd'.repeat(64) }, localOwnerConfigDigest: `sha256:${'e'.repeat(64)}` }
const canonical = { ...v2, binding: { ...v2.binding, runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL,
  runtime: NATIVE_H3_RUNTIME_CANONICAL } }
async function fixture(generation: 'v1' | 'v2' | 'canonical' = 'v2', options: {
  assertNewExecution?: () => Promise<void>
  adapter?: ArtifactOrderAdapter
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qs-dynamic-h3-')); roots.push(root)
  const path = join(root, 'owner.json')
  await writeFile(path, JSON.stringify({ schema: generation === 'canonical'
    ? 'qianshou.h3-owner.canonical.v1' : `qianshou.h3-owner.${generation}` }))
  const scope = { value: { path, identity: 'owner-profile:1' } as H3ProviderConfiguration | null }
  const changed = vi.fn()
  const calls = { v1: vi.fn(async () => v1), v2: vi.fn(async () => v2), canonical: vi.fn(async () => canonical) }
  const provider = createDynamicH3VideoProvider({ resolveConfiguration: async () => scope.value, onChanged: changed,
    ...options.assertNewExecution === undefined ? {} : { assertNewExecution: options.assertNewExecution },
    createV1: () => ({ nativeAuthorBinding: calls.v1, nativeAuthorBindingV2: async () => { throw new Error('V2 forbidden') },
      loadAndSelfTest: async () => null, status: () => ({ configured: true, ready: true, code: 'H3_REAL_SELF_TEST_VERIFIED' }) }),
    createV2: () => ({ nativeAuthorBindingV2: calls.v2, loadAndSelfTestV2: async () => options.adapter ?? null,
      status: () => ({ configured: true, ready: true, code: 'H3_V2_REAL_SELF_TEST_VERIFIED' }) }),
    createCanonical: () => ({ nativeAuthorBindingCanonical: calls.canonical,
      loadAndSelfTestCanonical: async () => options.adapter ?? null,
      status: () => ({ configured: true, ready: true, code: 'H3_CANONICAL_REAL_SELF_TEST_VERIFIED' }) }) })
  return { path, scope, changed, calls, provider }
}

it('invalidates readiness for a new revision even when the configuration bytes return to the same value', async () => {
  const f = await fixture()
  expect(await f.provider.nativeAuthorBindingV2()).toEqual(v2)
  expect(f.provider.status().ready).toBe(true)
  f.scope.value = { path: f.path, identity: 'owner-profile:2' }
  expect(await f.provider.refreshStatus()).toMatchObject({ ready: false, code: 'H3_NOT_CHECKED' })
  expect(f.changed).toHaveBeenCalledTimes(2)
  await f.provider.nativeAuthorBindingV2()
  f.scope.value = { path: f.path, identity: 'owner-profile:3' }
  expect(await f.provider.refreshStatus()).toMatchObject({ ready: false })
})

it('gates new preparation and execution while preserving pure identity for a retained lease', async () => {
  let blocked = false
  const run = vi.fn<ArtifactOrderAdapter['run']>(async () => ({ path: '/fixture/result.mp4',
    filename: 'result.mp4', contentType: 'video/mp4' }))
  const adapter: ArtifactOrderAdapter = { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
    contractVersion: 'v2', artifactDigest: 'sha256:' + 'a'.repeat(64), packageDigest: v2.localOwnerConfigDigest,
    outputFormats: ['mp4'], run }
  const f = await fixture('v2', { adapter, assertNewExecution: async () => {
    if (blocked) throw new ComputeError('H3_SETUP_SELF_TEST_UNKNOWN', 409)
  } })
  const retained = await f.provider.loadAndSelfTestV2()
  if (retained === null) throw new Error('Expected the guarded fixed adapter')
  blocked = true
  expect(await f.provider.loadAndSelfTestV2()).toBeNull()
  await expect(retained.run({ recipeJson: '{}', outputFormat: 'mp4', workspacePath: '/fixture',
    signal: new AbortController().signal })).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(run).not.toHaveBeenCalled()
  expect(await f.provider.nativeAuthorBindingV2()).toEqual(v2)
  expect(f.calls.v2).toHaveBeenCalledOnce()
})

it('does not invent configuration when new-work admission fails before the first read', async () => {
  const f = await fixture('v2', { assertNewExecution: async () => {
    throw new ComputeError('H3_SETUP_SELF_TEST_UNKNOWN', 409)
  } })
  expect(await f.provider.loadAndSelfTestV2()).toBeNull()
  expect(await f.provider.refreshStatus()).toEqual({ configured: false, ready: false, code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(f.calls.v2).not.toHaveBeenCalled()
  expect(f.changed).not.toHaveBeenCalled()
})

it('rejects a late preparation from the old account/revision without replacing the new ready observation', async () => {
  const f = await fixture()
  let complete: (() => void) | undefined
  const pending = new Promise<void>((resolve) => { complete = resolve })
  let begun: (() => void) | undefined
  const began = new Promise<void>((resolve) => { begun = resolve })
  f.calls.v2.mockImplementationOnce(async () => { begun?.(); await pending; return v2 })
  const old = f.provider.nativeAuthorBindingV2()
  const rejected = expect(old).rejects.toMatchObject({ code: 'H3_OWNER_CONFIGURATION_CHANGED' })
  await began
  f.scope.value = { path: f.path, identity: 'other-owner:1' }
  await f.provider.nativeAuthorBindingV2()
  complete?.(); await rejected
  expect(f.provider.status()).toMatchObject({ ready: true, code: 'H3_V2_REAL_SELF_TEST_VERIFIED' })
})

it('retains the actual V1 failure and never substitutes an unchecked V2 provider', async () => {
  const f = await fixture('v1')
  f.calls.v1.mockRejectedValueOnce(new ComputeError('H3_MODEL_MISSING', 409))
  await expect(f.provider.nativeAuthorBinding()).rejects.toMatchObject({ code: 'H3_MODEL_MISSING' })
  expect(f.provider.status()).toMatchObject({ ready: false, code: 'H3_MODEL_MISSING' })
  expect(await f.provider.loadAndSelfTestV2()).toBeNull()
  expect(f.calls.v2).not.toHaveBeenCalled()
  expect(f.provider.status().code).toBe('H3_MODEL_MISSING')
})

it('withdraws cached readiness after logout and rejects missing or invalid config without failing registration', async () => {
  const f = await fixture()
  await f.provider.nativeAuthorBindingV2()
  f.scope.value = null
  expect(await f.provider.refreshStatus()).toEqual({ configured: false, ready: false, code: 'H3_OWNER_CONFIG_NOT_CONFIGURED' })
  await expect(f.provider.nativeAuthorBindingV2()).rejects.toMatchObject({ code: 'H3_OWNER_CONFIG_NOT_CONFIGURED' })
  f.scope.value = { path: f.path, identity: 'owner-profile:2' }
  await writeFile(f.path, '{invalid')
  expect(await f.provider.loadAndSelfTestV2()).toBeNull()
  expect(f.provider.status()).toMatchObject({ ready: false, code: 'H3_OWNER_CONFIG_INVALID' })
  await rm(f.path)
  expect(await f.provider.loadAndSelfTest()).toBeNull()
  expect(f.calls.v2).toHaveBeenCalledTimes(1)
})

it('detects an in-place byte change at the same scope and path before reusing a prior receipt', async () => {
  const f = await fixture()
  await f.provider.nativeAuthorBindingV2()
  await writeFile(f.path, JSON.stringify({ schema: 'qianshou.h3-owner.v2', changed: true }))
  expect(await f.provider.refreshStatus()).toMatchObject({ ready: false })
  expect(f.changed).toHaveBeenCalledTimes(2)
})

it('selects the actual canonical schema without borrowing V2 evidence or falling back after V2 failure', async () => {
  const f = await fixture('canonical')
  expect(await f.provider.nativeAuthorBindingCurrent()).toEqual(canonical)
  expect(f.calls.v2).not.toHaveBeenCalled()
  expect(await f.provider.loadAndSelfTestV2()).toBeNull()
  await writeFile(f.path, JSON.stringify({ schema: 'qianshou.h3-owner.v2' }))
  f.calls.v2.mockRejectedValueOnce(new ComputeError('H3_V2_REAL_SELF_TEST_REQUIRED', 409))
  await expect(f.provider.nativeAuthorBindingCurrent()).rejects.toMatchObject({ code: 'H3_V2_REAL_SELF_TEST_REQUIRED' })
  expect(f.calls.canonical).toHaveBeenCalledOnce()
  expect(f.provider.status().ready).toBe(false)
})
