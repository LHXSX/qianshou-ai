/** Real immutable source + signed HTTP proof; listing never selects, renders, enrolls or grants. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_CANONICAL,
  NATIVE_H3_RUNTIME_CANONICAL, nativeH3LogicalBindingSha256, parseNativeH3PortableExecutionBinding }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import Catalog from '../src/index.ts'
import { nativeH3AuthoringTemplate, readNativeH3OrderSource } from '../src/native-h3-order-source.ts'

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const OWNER = 7
const WORKER = 'fixture-worker'
const CONNECTION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PUBLICATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PRIVATE = `sha256:${'a'.repeat(64)}`

async function fixture(runtime: 'python-v2' | 'canonical') {
  const binding = parseNativeH3PortableExecutionBinding({ schema: 'qianshou.native-h3-execution-binding.v2',
    ...(runtime === 'canonical' ? { runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL }
      : { runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2 }),
    executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64), firstFrameSha256: 'd'.repeat(64) })
  const home = await realpath(await mkdtemp(join(tmpdir(), 'h3-portable-inventory-'))); homes.push(home)
  const root = join(home, 'skills', 'native-inventory')
  for (const [path, bytes] of Object.entries(nativeH3AuthoringTemplate(binding, 'native-inventory', 'qianshou_inventory_v2').files)) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes)
  }
  const path = join(root, 'SKILL.md')
  const source = await readNativeH3OrderSource(path)
  const definition = source.files.find(file => file.path === 'task-definition.json')
  if (definition === undefined) throw new Error('Expected immutable task definition')
  const sourceDigest = `sha256:${source.digest}`
  const logical = nativeH3LogicalBindingSha256(binding)
  const pair = generateKeyPairSync('ed25519')
  const rawKey = (pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const challengeKey = (generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const issuanceKey = (generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const current = { owner: OWNER, connection: CONNECTION, ready: true, privateDigest: PRIVATE, expired: false,
    firstFrame: binding.firstFrameSha256, identityUnavailable: false }
  const forbidden = vi.fn(() => { throw new Error('Listing must not execute or grant') })
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString()); calls.push(url.toString())
    expect(init?.method ?? 'GET').toBe('GET')
    expect(url.pathname).toBe('/api/v8/task-adapter-publications/native-bindings')
    const version = url.searchParams.get('binding_version') === '2'
    const now = Math.floor(Date.now() / 1000)
    const payload = { schema: 'qianshou.native-h3-device-proof.v2', purpose: 'qianshou:native-h3-device-attestor.v2',
      publication_id: PUBLICATION, owner_id: OWNER, device_id: WORKER, task_type: source.declaration.taskType,
      capability_id: 'video.render', contract_version: 'v2', contract_sha256: 'e'.repeat(64), artifact_digest: sourceDigest,
      source_digest: sourceDigest, logical_binding_sha256: logical, local_owner_config_digest: PRIVATE, device_binding_revision: 1,
      challenge_nonce: Buffer.alloc(32, 8).toString('base64url'), challenge_input_sha256: 'f'.repeat(64),
      challenge_result_sha256: '1'.repeat(64), result: 'pass', publication_status: 'approved', installation_state: 'installed',
      issued_at: now - 10, expires_at: current.expired ? now : now + 290 }
    return Response.json({ schema: `qianshou.native-h3-order-bindings.v${version ? 2 : 1}`, owner_id: OWNER,
      worker_id: WORKER, bindings: version ? [{ publication_id: PUBLICATION, owner_id: OWNER, device_id: WORKER,
        task_type: source.declaration.taskType, capability_id: 'video.render', input_kinds: ['inline'], output_kind: 'artifact_ref',
        contract_version: 'v2', input_contract: 'h3-prompt-fixed-frame.v1', result_strategy: 'external-media.v1',
        artifact_digest: sourceDigest, source_digest: sourceDigest, package_digest: `sha256:${logical}`,
        logical_binding_sha256: logical, local_owner_config_digest: PRIVATE, device_binding_revision: 1,
        device_key_id: 'fixture-device', connection_id: CONNECTION, contract_sha256: payload.contract_sha256,
        task_definition_sha256: createHash('sha256').update(definition.bytes).digest('hex'), native_binding: binding,
        device_proof: { key_id: 'fixture', payload,
          signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), pair.privateKey).toString('base64url') } }] : [] })
  })
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('profileContext', { dir: home })
  ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: String(current.owner) } }) })
  ctx.provide('accountSession', { ensureAccessToken: async () => 'fixture-private-token' })
  ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [{ source: 'user-agents', name: 'native-inventory', path }] }) })
  ctx.provide('computeCore', { ownerSupplyPolicy: async () => ({ mode: 'idle', maxConcurrency: 2, enabledServiceIds: ['node'] }),
    updateOwnerSupply: forbidden, querySupplySnapshot: async () => ({ localServices: [] }) })
  const read = async () => {
    if (current.identityUnavailable) throw new Error('Actual provider unavailable')
    return { binding: { ...binding, firstFrameSha256: current.firstFrame }, localOwnerConfigDigest: current.privateDigest }
  }
  ctx.provide('nodeContributor', { acknowledgedWorkerId: () => WORKER, acknowledgedConnectionId: () => current.connection,
    ...(runtime === 'canonical' ? { nativeH3AuthorBindingCanonical: read, nativeH3AuthorBindingV2: forbidden }
      : { nativeH3AuthorBindingV2: read, nativeH3AuthorBindingCanonical: forbidden }),
    nativeH3AuthorBinding: forbidden, nativeH3OrderAdapterReady: async () => current.ready,
    selectNativeH3AuthorBinding: forbidden, runNativeH3ReviewChallenge: forbidden, refreshNativeH3OrderAdapters: forbidden,
    orderExecutor: () => ({ kind: 'unavailable' }), orderExecutorVerified: () => false })
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000, connection: 'shipped',
    apiBaseUrl: '', coreOrigin: 'https://control.invalid', installHome: '', publisherKeys: {},
    orderNativeH3AttestorKeys: { fixture: rawKey }, orderNativeH3ChallengeKeys: { fixture: challengeKey },
    orderNativeH3UploadIssuanceKeys: { fixture: issuanceKey } })
  const catalog = ctx.qianshouPluginCatalog
  vi.spyOn(catalog, 'myOrderSkillPublications').mockResolvedValue({ items: [{ source: 'user-agents', name: 'native-inventory',
    runtimeKind: 'native-h3', publicationId: PUBLICATION, status: 'approved', taskType: source.declaration.taskType,
    artifactDigest: sourceDigest, archiveStatus: 'confirmed', reviewReasons: [] }] })
  vi.spyOn(catalog, 'verifiedPurchasedOrderRuntimes').mockResolvedValue([])
  vi.spyOn(catalog, 'verifiedPurchasedFileOrderRuntimes').mockResolvedValue([])
  const listed = async () => (await catalog.orderSources()).sources.find(item => item.kind === 'skill')
  return { current, forbidden, calls, listed }
}

it.each(['python-v2', 'canonical'] as const)('restores only the exact %s provider and current signed proof without a fake V1 provider', async (runtime) => {
  const f = await fixture(runtime)
  expect(await f.listed()).toMatchObject({ runtimeKind: 'native-h3', eligible: true, enabled: true, reason: 'ready' })
  expect(f.calls).toHaveLength(2); expect(f.forbidden).not.toHaveBeenCalled()
  f.current.privateDigest = `sha256:${'9'.repeat(64)}`
  expect(await f.listed()).toMatchObject({ eligible: false, enabled: false })
  f.current.privateDigest = PRIVATE; f.current.firstFrame = '9'.repeat(64)
  expect(await f.listed()).toMatchObject({ eligible: false, enabled: false })
  expect(f.forbidden).not.toHaveBeenCalled()
})

it.each(['python-v2', 'canonical'] as const)('withdraws %s inventory readiness when actual provider, proof, socket or ACK is unavailable', async (runtime) => {
  const f = await fixture(runtime)
  for (const state of [{ identityUnavailable: true }, { expired: true }, { ready: false }, { connection: 'changed' }]) {
    Object.assign(f.current, { identityUnavailable: false, expired: false, ready: true, connection: CONNECTION }, state)
    expect(await f.listed()).toMatchObject({ eligible: false, enabled: false })
  }
  expect(f.forbidden).not.toHaveBeenCalled()
})
