/** Actual Loader/socket and signed proof brands; the fixed provider fixture never runs GPU work. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI, NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_V2,
  parseAnyNativeH3Declaration, parseNativeH3ExecutionBindingV2, nativeH3LogicalBindingSha256,
  NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL, parseNativeH3CanonicalExecutionBinding,
  type NativeH3CanonicalExecutionBinding,
  type NativeH3AuthorBinding, type NativeH3ExecutionBindingV2 } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3DeviceProof, verifyNativeH3DeviceProof, verifyNativeH3DeviceProofV2, type NativeH3DeviceProof }
  from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { canonicalNativeH3ReviewJson, verifyNativeH3ReviewChallengeV2 } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { afterEach, expect, it, vi } from 'vitest'
import { FixtureWebSocketServer } from '../../compute-core/tests/transport/fixture-ws-server.ts'
import { apply, Config, NODE_CONTRIBUTOR_SERVICE, type NodeContributorService } from '../src/index.ts'
import type { NativeH3PublishedBinding } from '../src/native-h3-publication.ts'
import type { ArtifactOrderAdapter } from '../src/artifact-order.ts'
import { H3OwnerSetup } from '../src/h3-owner-setup.ts'
import type { H3OwnerSetupSelection } from '../src/h3-owner-setup-types.ts'
import type { NativeProgramRunner } from '../src/command-artifact.ts'
import { prepareH3OrderInput } from '../src/h3-video.ts'

const provider = vi.hoisted(() => ({ available: true, binding: null as NativeH3AuthorBinding | null,
  bindingV2: null as NativeH3ExecutionBindingV2 | null, bindingCanonical: null as NativeH3CanonicalExecutionBinding | null, privateDigest: '',
  recipe: '', run: vi.fn<ArtifactOrderAdapter['run']>(async () => { throw new Error('Preflight must never run GPU') }) }))
const trialProgram = vi.hoisted(() => vi.fn<NativeProgramRunner>(async () => { throw new Error('Simulated external outcome unknown') }))
vi.mock('../src/command-artifact.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/command-artifact.ts')>(), executeNativeProgram: trialProgram,
}))
vi.mock('../src/h3-video.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/h3-video.ts')>()
  return { ...original, createH3VideoProvider: () => ({
    async nativeAuthorBinding() {
      if (provider.binding === null) throw new Error('No actual provider')
      return { ...provider.binding, executionRecipeSha256: provider.recipe }
    },
    async loadAndSelfTest(): Promise<ArtifactOrderAdapter | null> {
      return provider.available ? { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
        contractVersion: 'v1', artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: `sha256:${'b'.repeat(64)}`,
        outputFormats: ['mp4'], prepareRequest: original.prepareH3OrderInput, run: provider.run } : null
    },
    status: () => ({ configured: true, ready: provider.available,
      code: provider.available ? 'H3_REAL_SELF_TEST_VERIFIED' : 'H3_REAL_SELF_TEST_REQUIRED' }),
  }) }
})
vi.mock('../src/h3-video-v2.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/h3-video-v2.ts')>()
  return { ...original, createH3VideoProviderV2: () => ({
    async nativeAuthorBindingV2() {
      if (provider.bindingV2 === null) throw new Error('No actual V2 provider')
      return { binding: { ...provider.bindingV2, executionRecipeSha256: provider.recipe },
        localOwnerConfigDigest: provider.privateDigest }
    },
    async loadAndSelfTestV2(): Promise<ArtifactOrderAdapter | null> {
      return provider.available ? { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
        contractVersion: 'v2', artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: provider.privateDigest,
        outputFormats: ['mp4'], prepareRequest: prepareH3OrderInput, run: provider.run } : null
    },
    status: () => ({ configured: true, ready: provider.available,
      code: provider.available ? 'H3_V2_REAL_SELF_TEST_VERIFIED' : 'H3_V2_REAL_SELF_TEST_REQUIRED' }),
  }) }
})

vi.mock('../src/h3-canonical-provider.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/h3-canonical-provider.ts')>()
  return { ...original, createH3CanonicalProvider: () => ({
    async nativeAuthorBindingCanonical() {
      if (provider.bindingCanonical === null) throw new Error('No actual canonical provider')
      return { binding: { ...provider.bindingCanonical, executionRecipeSha256: provider.recipe },
        localOwnerConfigDigest: provider.privateDigest }
    },
    async loadAndSelfTestCanonical(): Promise<ArtifactOrderAdapter | null> {
      return provider.available ? { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
        contractVersion: 'v2', artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: provider.privateDigest,
        outputFormats: ['mp4'], prepareRequest: prepareH3OrderInput, run: provider.run } : null
    },
    status: () => ({ configured: true, ready: provider.available,
      code: provider.available ? 'H3_CANONICAL_REAL_SELF_TEST_VERIFIED' : 'H3_CANONICAL_REAL_SELF_TEST_REQUIRED' }),
  }) }
})

// CPU-only static SVG port qualifies through the real Loader/Hello path; no renderer is invoked.
vi.mock('../src/pinned-svg-video.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/pinned-svg-video.ts')>()
  return { ...original, createPinnedSvgVideoAdapter: async () => ({
    taskType: 'bar_chart_svg_v1', inputKind: 'inline' as const, outputKind: 'artifact_ref' as const,
    contractVersion: 'v1' as const, artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: `sha256:${'b'.repeat(64)}`,
    outputFormats: ['mp4'], run: async () => { throw new Error('Static renderer is outside this test') },
  }), selfTestPinnedSvgVideoAdapter: async () => {} }
})
vi.mock('../src/artifact-publication-readiness.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/artifact-publication-readiness.ts')>()
  return { ...original, readArtifactPublicationReadiness: async () => ({ ready: true, publicationId: 'static-svg-fixture' }) }
})

const worker = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const connection = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const publicationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const owner = 7
const contexts: Context[] = []
const roots: string[] = []
const servers: FixtureWebSocketServer[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  provider.run.mockClear(); trialProgram.mockClear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

async function fixture(options: {
  staticSvg?: boolean
  staleText?: boolean
  configured?: boolean
  version?: 'v1' | 'v2' | 'canonical'
  autoConfigure?: boolean
  managed?: boolean
  home?: string
  owner?: number
} = {}) {
  const runsBefore = provider.run.mock.calls.length
  provider.available = true
  provider.binding = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
    ownerConfigDigest: `sha256:${'b'.repeat(64)}`, executionRecipeSha256: 'c'.repeat(64), modelSha256: 'd'.repeat(64) }
  provider.recipe = provider.binding.executionRecipeSha256
  provider.bindingV2 = parseNativeH3ExecutionBindingV2({ schema: 'qianshou.native-h3-execution-binding.v2',
    runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
    executionRecipeSha256: provider.recipe, modelSha256: 'd'.repeat(64), firstFrameSha256: 'a'.repeat(64) })
  provider.privateDigest = `sha256:${'b'.repeat(64)}`
  provider.bindingCanonical = parseNativeH3CanonicalExecutionBinding({ schema: 'qianshou.native-h3-execution-binding.v2',
    runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL,
    executionRecipeSha256: provider.recipe, modelSha256: 'd'.repeat(64), firstFrameSha256: 'a'.repeat(64) })
  const canonical = options.version === 'canonical'
  const v2 = options.version === 'v2' || canonical
  const portable = canonical ? provider.bindingCanonical : provider.bindingV2
  const declaration = parseAnyNativeH3Declaration({ ...(v2 ? portable : provider.binding),
    schema: v2 ? 'qianshou.native-h3-binding.v2' : 'qianshou.native-h3-binding.v1',
    taskType: v2 ? 'qianshou_h3_native_fixture_v2' : 'qianshou_h3_native_fixture_v1',
    capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref',
    contractVersion: v2 ? 'v2' : 'v1', category: 'video', platformDispatchable: true })
  const fixtureOwner = options.owner ?? owner
  const common = { publication_id: publicationId, owner_id: fixtureOwner, device_id: worker,
    task_type: declaration.taskType, capability_id: 'video.render' as const,
    contract_sha256: 'e'.repeat(64), artifact_digest: `sha256:${'a'.repeat(64)}`, source_digest: `sha256:${'a'.repeat(64)}` }
  const tuple = { ...common, contract_version: 'v1' as const, config_digest: provider.binding.ownerConfigDigest }
  const tupleV2 = { ...common, contract_version: 'v2' as const,
    logical_binding_sha256: nativeH3LogicalBindingSha256(portable),
    local_owner_config_digest: provider.privateDigest, device_binding_revision: 1 }
  const now = Math.floor(Date.now() / 1000)
  const payload: NativeH3DeviceProof = { ...tuple, schema: 'qianshou.native-h3-device-proof.v1',
    purpose: 'qianshou:native-h3-device-attestor', challenge_nonce: 'fixture-proof-nonce',
    challenge_input_sha256: 'f'.repeat(64), challenge_result_sha256: 'f'.repeat(64), result: 'pass',
    publication_status: 'approved', installation_state: 'installed', issued_at: now, expires_at: now + 300 }
  const pair = generateKeyPairSync('ed25519')
  const payloadV2 = { ...tupleV2, schema: 'qianshou.native-h3-device-proof.v2' as const,
    purpose: 'qianshou:native-h3-device-attestor.v2' as const, challenge_nonce: Buffer.alloc(32, 1).toString('base64url'),
    challenge_input_sha256: 'f'.repeat(64), challenge_result_sha256: 'f'.repeat(64), result: 'pass' as const,
    publication_status: 'approved' as const, installation_state: 'installed' as const, issued_at: now, expires_at: now + 300 }
  const deviceProof = v2 ? verifyNativeH3DeviceProofV2({ key_id: 'fixture', payload: payloadV2,
    signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payloadV2)), pair.privateKey).toString('base64url') },
  tupleV2, new Map([['fixture', pair.publicKey]]), now) : verifyNativeH3DeviceProof({ key_id: 'fixture', payload,
    signature: sign(null, Buffer.from(canonicalNativeH3DeviceProof(payload)), pair.privateKey).toString('base64url') },
  tuple, new Map([['fixture', pair.publicKey]]), now)
  const binding: NativeH3PublishedBinding = { declaration, publicationId, sourceDigest: tuple.source_digest,
    taskDefinitionSha256: `sha256:${'f'.repeat(64)}`, contractSha256: tuple.contract_sha256, deviceProof,
    ...(v2 ? { localOwnerConfigDigest: provider.privateDigest, connectionId: connection, deviceKeyId: 'native-device-fixture' } : {}) }
  const state = { owner: fixtureOwner, bindings: [binding] }
  const update = { rejected: false, connectionId: connection, beforeAck: () => {} }
  const server = await FixtureWebSocketServer.start({ script(frame, peer) {
    if (frame.type === 'hello') peer.reply('welcome', { hb_interval_s: 60 })
    if (frame.type === 'auth') peer.reply('auth_ok', { worker_id: worker, owner_id: fixtureOwner, connection_id: connection })
    if (frame.type === 'native_h3_adapter_update') {
      update.beforeAck()
      peer.reply('native_h3_adapter_update_ack', {
        request_id: frame.payload.request_id, connection_id: update.connectionId, status: update.rejected ? 'rejected' : 'accepted',
        task_types: update.rejected ? [] : (frame.payload.adapters as { task_type: string }[]).map(item => item.task_type),
      })
    }
    if (frame.type === 'hb') peer.reply('hb_ack', {})
  } }); servers.push(server)
  const root = await mkdtemp(join(await realpath(tmpdir()), 'native-node-preflight-')); roots.push(root)
  vi.stubEnv('DSH_HOME', options.home ?? root)
  if (options.staleText) await writeFile(join(root, 'qianshou-order-executor.json'), '{"version":2,"kind":"plugin"}')
  // The provider is mocked; the production version selector still reads this real, explicit owner file.
  const h3OwnerConfigPath = join(root, 'h3-owner-v1.json')
  const ownerConfiguration = JSON.stringify({ schema: canonical ? 'qianshou.h3-owner.canonical.v1' : v2 ? 'qianshou.h3-owner.v2' : 'qianshou.h3-owner.v1',
    pythonPath: join(root, 'python'), ffmpegPath: join(root, 'ffmpeg'), ffprobePath: join(root, 'ffprobe'),
    entryPath: join(root, 'video_generate.py'), runtimePath: join(root, 'h3_runtime.py'),
    firstFramePath: join(root, 'first.png'), workflowPath: join(root, 'workflow.json'), modelPath: join(root, 'model'),
    workflow: 'qs_new4', adapterBase: 'http://127.0.0.1:8790', outputRoot: root,
    selfTestReceiptPath: join(root, 'self-test.json') })
  const path = join(root, 'cordis.yml')
  await writeFile(path, ['- name: bootstrap', '- name: node-fixture', '  config:', '    autoStart: false',
    "    mode: 'BACKGROUND_ONLY'", '    allowWhileUserActive: true', '    allowedTaskTypes: []', '    handshakeTimeoutMs: 2000',
    ...(options.configured === false || options.managed ? [] : [`    h3OwnerConfigPath: '${h3OwnerConfigPath}'`]),
    ...(options.staticSvg ? [`    localArtifactAdapterRoot: '${join(root, 'static-svg')}'`,
      `    localArtifactAdapterDigest: '${'a'.repeat(64)}'`, `    localArtifactPackageDigest: '${'b'.repeat(64)}'`,
      `    localArtifactPythonPath: '${join(root, 'python')}'`, `    localArtifactSwiftPath: '${join(root, 'swift')}'`] : []),
    `    storePath: '${join(root, 'tasks.json')}'`, `    workspaceRoot: '${join(root, 'attempts')}'`, ''].join('\n'))
  const read = vi.fn(async () => state.bindings)
  const modules = new Map<string, unknown>([
    ['bootstrap', { apply(ctx: Context) {
      ctx.provide('connection', { fetch: { register: () => async () => undefined } })
      ctx.provide('profileContext', { dir: root })
      ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: String(state.owner) } }) })
      ctx.provide('computeCore', { coreOrigin: () => server.origin, ownerAccountId: async () => state.owner,
        ownerSupplyPolicy: async () => ({ mode: 'allowed', maxConcurrency: 1, minFreeMemoryBytes: 0,
          minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }) })
      ctx.provide('accountSession', { ensureAccessToken: async () => 'test-native-account-token' })
      ctx.provide('qianshouPluginCatalog', { verifiedNativeH3OrderBindings: read })
      ctx.provide('voiceActivity', { active: () => false, subscribe: () => () => undefined })
      ctx.provide('agents', { list: () => [] })
    } }],
    ['node-fixture', { name: 'qianshou-node-contributor', inject: ['connection'], apply, Config }],
  ])
  const ctx = new Context(); contexts.push(ctx); ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Native preflight fixture requires the real Node module loader')
  const shared = { loadCache: internal.loadCache, register: internal.register.bind(internal), load: internal.load.bind(internal),
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('Unexpected fixture module')
      return modules.get(specifier)
    } }
  ctx.loader.internal = internal.version === 'v2'
    ? { ...shared, version: 'v2', getOrCreateModuleJob: internal.getOrCreateModuleJob.bind(internal),
      resolveSync: internal.resolveSync.bind(internal) }
    : { ...shared, version: 'v1', getModuleJobForImport: internal.getModuleJobForImport.bind(internal),
      resolve: internal.resolve.bind(internal), resolveSync: internal.resolveSync.bind(internal) }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
  const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
  await service.start()
  expect(await service.canEnableLocalService('node')).toBe(false)
  expect(provider.run.mock.calls).toHaveLength(runsBefore)
  const configure = async () => {
    await writeFile(h3OwnerConfigPath, ownerConfiguration)
    await service.refreshNativeH3OrderAdapters()
  }
  if (options.configured !== false && options.autoConfigure !== false && !options.managed) await configure()
  return { service, state, read, server, binding, update, configure, root, ctx, h3OwnerConfigPath, pair, tupleV2 }
}

it('qualifies an H3-only native service from current signed proof and fixed provider without a text executor or GPU', async () => {
  const f = await fixture()
  expect(f.service.orderExecutorVerified()).toBe(false)
  expect(f.service.acknowledgedConnectionId()).toBe(connection)
  expect(await f.service.canEnableLocalService('node')).toBe(true)
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(true)
  expect(f.service.h3VideoReadiness()).toEqual({ configured: true, ready: true, code: 'H3_REAL_SELF_TEST_VERIFIED' })
  expect(f.read).toHaveBeenCalledWith(worker)
  expect(provider.run).not.toHaveBeenCalled()
  await f.service.stop('fixture complete')
})

it('cannot borrow a mocked ready provider when no owner configuration is mounted', async () => {
  const f = await fixture({ configured: false })
  expect(await f.service.canEnableLocalService('node')).toBe(false)
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(false)
  expect(f.service.h3VideoReadiness()).toEqual({ configured: false, ready: false, code: 'H3_OWNER_CONFIG_NOT_CONFIGURED' })
  expect(f.server.frames.some(frame => frame.type === 'native_h3_adapter_update'
    && Array.isArray(frame.payload.adapters) && frame.payload.adapters.length > 0)).toBe(false)
  expect(provider.run).not.toHaveBeenCalled()
  await f.service.stop('fixture complete')
})

it('authenticates an unconfigured V2 fixed provider, then admits its saved V2 identity only on the same socket ACK', async () => {
  const f = await fixture({ version: 'v2', autoConfigure: false })
  const hello = f.server.frames.find(frame => frame.type === 'hello')
  expect(hello?.payload.capabilities).toMatchObject({ provided_capabilities: [], verified_task_adapters: [] })
  expect(f.service.acknowledgedConnectionId()).toBe(connection)
  expect(await f.service.canEnableLocalService('node')).toBe(false)
  await f.configure()
  expect(await f.service.canEnableLocalService('node')).toBe(true)
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(true)
  expect(f.service.h3VideoReadiness()).toEqual({ configured: true, ready: true, code: 'H3_V2_REAL_SELF_TEST_VERIFIED' })
  const update = f.server.frames.find(frame => frame.type === 'native_h3_adapter_update')
  expect(update?.payload).toMatchObject({ adapters: [{ contract_version: 'v2', native_binding: provider.bindingV2,
    local_owner_config_digest: provider.privateDigest, device_binding_revision: 1 }] })
  if (update === undefined || !Array.isArray(update.payload.adapters) || update.payload.adapters.length !== 1) {
    throw new Error('Expected one actual V2 adapter update')
  }
  const claim: unknown = update.payload.adapters[0]
  if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('Expected actual V2 metadata')
  expect(Object.keys(claim)).toHaveLength(16)
  expect(f.server.connectionCount).toBe(1)
  expect(f.service.acknowledgedConnectionId()).toBe(connection)
  f.state.owner = 8
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(false)
  expect(provider.run).not.toHaveBeenCalled()
  await f.service.stop('fixture complete')
})

it('refuses a V2 adapter update acknowledged for a different connection without running GPU', async () => {
  const f = await fixture({ version: 'v2', autoConfigure: false })
  f.update.connectionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  await expect(f.configure()).rejects.toThrow()
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(false)
  expect(f.service.status()).toMatchObject({ intake: 'paused', acceptingCapabilityIds: [] })
  expect(provider.run).not.toHaveBeenCalled()
  await f.service.stop('fixture complete')
})

it('admits a native offer on the same ACK socket after an empty registration Hello', async () => {
  const f = await fixture({ staleText: true })
  const hello = f.server.frames.find(frame => frame.type === 'hello')
  expect(hello?.payload.capabilities).toMatchObject({ verified_task_adapters: [] })
  expect(f.server.frames.find(frame => frame.type === 'native_h3_adapter_update')?.payload).toMatchObject({
    adapters: [{ task_type: f.binding.declaration.taskType, publication_id: publicationId,
      native_binding: provider.binding }] })
  expect(await f.service.tick()).toMatchObject({ intake: 'running', acceptingCapabilityIds: ['video.render'] })
  f.server.send('shard_assign', { workload_id: 'native-fixture-work', shard_id: 'native-fixture-shard', attempt: 0,
    task_type: f.binding.declaration.taskType, runtime: 'python3', input_kind: 'inline', inline_input: '虚构场景',
    input_ref: '', input_refs: [], code_url: '', code_sha256: '', timeout_s: 60,
    verification_policy: 'semantic', execution_model: '', capability: '', capability_version: '',
    lease_token: 'fixture-only-private-lease', params: { seconds: 5, seed: 1 } })
  await vi.waitFor(async () => { await f.service.tick(); expect(provider.run, JSON.stringify(f.server.frames
    .filter(frame => frame.type === 'shard_result').map(frame => frame.payload))).toHaveBeenCalledOnce() })
  expect(f.server.connectionCount).toBe(1)
  expect(f.service.acknowledgedConnectionId()).toBe(connection)
  // The controlled runner deliberately throws: admission is proven, playable output is not claimed.
  await f.service.stop('fixture complete')
})

it.each(['missing-proof', 'expired-proof', 'missing-provider'] as const)(
  'keeps native intake independent of stale text selection and pauses again after %s', async (failure) => {
    const f = await fixture({ staleText: true })
    expect(f.service.orderExecutor()).toEqual({ kind: 'unavailable' })
    expect(await f.service.canEnableLocalService('node')).toBe(true)
    await f.service.refreshNativeH3OrderAdapters()
    expect(await f.service.tick()).toMatchObject({ intake: 'running', acceptingCapabilityIds: ['video.render'] })
    if (failure === 'missing-proof') f.state.bindings = []
    if (failure === 'expired-proof') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000)
    if (failure === 'missing-provider') provider.available = false
    await f.service.refreshNativeH3OrderAdapters()
    const paused = await f.service.tick()
    expect(paused).toMatchObject({ intake: 'paused', acceptingCapabilityIds: [] })
    expect(paused.intakeReasons).toContain('LOCAL_ORDER_PLUGIN_UNAVAILABLE')
    expect(await f.service.canEnableLocalService('node')).toBe(false)
    expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(false)
    expect(provider.run).not.toHaveBeenCalled()
    await f.service.stop('fixture complete')
  })

it('reads acknowledged native readiness without renewing metadata and invalidates it on owner change or disconnect', async () => {
  const f = await fixture()
  const updates = f.server.frames.filter(frame => frame.type === 'native_h3_adapter_update').length
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(true)
  expect(f.server.frames.filter(frame => frame.type === 'native_h3_adapter_update')).toHaveLength(updates)
  f.state.owner = 8
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(false)
  f.state.owner = owner
  await f.service.stop('fixture complete')
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(false)
  expect(provider.run).not.toHaveBeenCalled()
})

it.each(['rejected', 'provider-changed-after-ack', 'over-bound'] as const)(
  'never revives native intake after %s', async (failure) => {
    const f = await fixture({ staleText: true })
    if (failure === 'over-bound') f.state.bindings = Array.from({ length: 17 }, () => f.binding)
    // Force a real new server request while retaining the same bound identities.
    if (failure !== 'over-bound') {
      f.state.bindings = []
      await f.service.refreshNativeH3OrderAdapters().catch(() => undefined)
      f.state.bindings = [f.binding]
    }
    if (failure === 'rejected') f.update.rejected = true
    if (failure === 'provider-changed-after-ack') f.update.beforeAck = () => { provider.available = false }
    await expect(f.service.refreshNativeH3OrderAdapters()).rejects.toThrow()
    expect(f.service.status()).toMatchObject({ intake: 'paused', acceptingCapabilityIds: [] })
    expect(f.server.connectionCount).toBe(1)
    expect(provider.run).not.toHaveBeenCalled()
    await f.service.stop('fixture complete')
  })

it.each(['missing-proof', 'serialized-proof', 'actual-recipe', 'missing-provider', 'owner-changed'] as const)(
  'refuses %s without borrowing the default word-count executor or running GPU', async (failure) => {
    const f = await fixture()
    if (failure === 'missing-proof') f.state.bindings = []
    if (failure === 'serialized-proof') f.state.bindings = [{ ...f.binding, deviceProof: structuredClone(f.binding.deviceProof) }]
    if (failure === 'actual-recipe') provider.recipe = 'f'.repeat(64)
    if (failure === 'missing-provider') provider.available = false
    if (failure === 'owner-changed') f.state.owner = 8
    expect(await f.service.canEnableLocalService('node')).toBe(false)
    expect(provider.run).not.toHaveBeenCalled()
    await f.service.stop('fixture complete')
  })


async function managedFiles(root: string) {
  const selection: H3OwnerSetupSelection = { runtime: 'v2', pythonPath: join(root, 'python'),
    ffmpegPath: join(root, 'ffmpeg'), ffprobePath: join(root, 'ffprobe'), firstFramePath: join(root, 'first.png'),
    workflowPath: join(root, 'workflow.json'), modelPath: join(root, 'model.safetensors'),
    adapterOutputRoot: join(root, 'adapter-output'), adapterBase: 'http://127.0.0.1:8790' }
  await mkdir(selection.adapterOutputRoot)
  for (const path of [selection.pythonPath, selection.ffmpegPath, selection.ffprobePath]) await writeFile(path, '# fixture', { mode: 0o700 })
  const frame = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
  await writeFile(selection.firstFramePath, frame); await writeFile(selection.workflowPath, '{}'); await writeFile(selection.modelPath, 'fixture weights')
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === 'media.fixture.test') {
      expect(init?.method).toBe('PUT')
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return new Response(null, { headers: { 'x-amz-version-id': 'immutable-fixture-version' } })
    }
    if (url.pathname === '/api/v8/files/result-upload-url') {
      if (typeof init?.body !== 'string') throw new Error('Expected lease-bound metadata')
      const row: unknown = JSON.parse(init.body)
      if (row === null || typeof row !== 'object' || !('shard_id' in row) || !('result_id' in row)
        || !('sha256' in row) || typeof row.sha256 !== 'string') throw new Error('Expected bounded artifact metadata')
      return Response.json({ schema_version: 'artifact.v1', method: 'PUT',
        object_key: `v8/account-999/workload-dddddddd-dddd-4ddd-8ddd-dddddddddddd/shard-${row.shard_id}/result/${row.result_id}/result.mp4`,
        upload_url: 'https://media.fixture.test/result.mp4', expires_at: Math.floor(Date.now() / 1000) + 300,
        headers: { 'x-amz-checksum-sha256': Buffer.from(row.sha256, 'hex').toString('base64') } })
    }
    if (url.pathname === '/health') return Response.json({ ok: true, workflows: ['qs_new4'] })
    expect(url.pathname).toBe('/v2/recipes/qs_new4/identity')
    return Response.json({ schemaVersion: 'qs.h3.recipe-identity.v2', workflow: 'qs_new4', recipeVersion: 'fixture-v2',
      graphTemplateSha256: 'e'.repeat(64), builderSourceSha256: 'f'.repeat(64), executionRecipeSha256: provider.recipe,
      modelSha256: 'd'.repeat(64), localConfigSha256: 'f'.repeat(64),
      firstFrameSha256: createHash('sha256').update(frame).digest('hex'), negativeSha256: url.searchParams.get('negativeSha256'),
      modelSetSha256: 'd'.repeat(64), weightSha256ByRole: { audioVae: '1'.repeat(64), clip: '2'.repeat(64),
        lora: '3'.repeat(64), unet: '4'.repeat(64), videoVae: '5'.repeat(64) } })
  })
  vi.stubGlobal('fetch', http)
  return { selection, http }
}

it('saves actual managed V2 files through the Loader service without GPU, reconnect or implicit readiness, and blocks a concurrent old trial', async () => {
  const f = await fixture({ version: 'v2', managed: true })
  provider.available = false
  const { selection, http } = await managedFiles(f.root)
  expect(await f.service.inspectH3OwnerSetup()).toMatchObject({ kind: 'current', revision: 0, configured: false })
  expect(http).not.toHaveBeenCalled()
  const inspection = await f.service.inspectH3OwnerSetup(selection)
  if (inspection.kind !== 'inspection') throw new Error('Actual selected files must produce an inspection')
  let release: (() => void) | undefined; let entered: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const beginning = new Promise<void>((resolve) => { entered = resolve })
  const saveSpy = vi.spyOn(H3OwnerSetup.prototype, 'save')
  saveSpy.mockImplementationOnce(async function (this: H3OwnerSetup, request, signal) {
    entered?.(); await gate; saveSpy.mockRestore(); return this.save(request, signal)
  })
  const saved = f.service.saveH3OwnerSetup({ inspectionId: inspection.inspectionId, expectedRevision: 0 }, new AbortController().signal)
  await beginning
  try {
    await expect(f.service.startH3OwnerSelfTest({ contextId: inspection.contextId, revision: 0, prompt: '旧配置不得执行' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'H3_SETUP_BUSY' })
  } finally { release?.() }
  expect(await saved).toMatchObject({ state: 'saved', revision: 1 })
  expect(await f.service.inspectH3OwnerSetup()).toMatchObject({ revision: 1, configured: true, state: 'saved' })
  expect(f.service.acknowledgedConnectionId()).toBe(connection)
  expect(await f.service.canEnableLocalService('node')).toBe(false)
  expect(f.service.h3VideoReadiness().ready).toBe(false)
  expect(provider.run).not.toHaveBeenCalled()
  expect(f.server.frames.filter(frame => frame.type === 'auth')).toHaveLength(1)
  expect(f.server.frames.filter(frame => frame.type === 'native_h3_adapter_update').every(frame =>
    Array.isArray(frame.payload.adapters) && frame.payload.adapters.length === 0)).toBe(true)
  expect(http.mock.calls.every(([input]) =>
    new URL(input instanceof Request ? input.url : String(input)).origin === selection.adapterBase)).toBe(true)
  // Once the mutex is released, only a fresh independently ready provider/proof
  // and same-socket ACK can qualify; the save's temporary veto must not stick.
  provider.available = true
  await f.service.refreshNativeH3OrderAdapters()
  expect(await f.service.canEnableLocalService('node')).toBe(true)
  expect(await f.service.tick()).toMatchObject({ intake: 'running', acceptingCapabilityIds: ['video.render'] })
  expect(f.server.frames.filter(frame => frame.type === 'auth')).toHaveLength(1)
  expect(provider.run).not.toHaveBeenCalled()
  await f.service.stop('fixture complete')
})

it('exposes canonical setup through the actual Loader without borrowing a V2 configuration or starting GPU work', async () => {
  const f = await fixture({ version: 'canonical', managed: true })
  const canonical = await f.service.inspectH3CanonicalSetup()
  expect(canonical).toMatchObject({ kind: 'current', configured: false, runtime: null,
    state: 'unconfigured', revision: 0 })
  expect(await f.service.inspectH3OwnerSetup()).toMatchObject({ kind: 'current', configured: false, revision: 0 })
  expect(await f.service.canEnableLocalService('node')).toBe(false)
  expect(f.service.h3VideoReadiness().ready).toBe(false)
  expect(provider.run).not.toHaveBeenCalled()
  expect(trialProgram).not.toHaveBeenCalled()
  expect(f.server.frames.filter(frame => frame.type === 'native_h3_adapter_update').every(frame =>
    Array.isArray(frame.payload.adapters) && frame.payload.adapters.length === 0)).toBe(true)
  await f.service.stop('fixture complete')
})

it('retains an actual unknown trial across Loader restart and another owner while a different home remains independent', async () => {
  const a = await fixture({ version: 'v2', managed: true })
  const { selection } = await managedFiles(a.root)
  const inspection = await a.service.inspectH3OwnerSetup(selection)
  if (inspection.kind !== 'inspection') throw new Error('Actual files require an inspection')
  const saved = await a.service.saveH3OwnerSetup({ inspectionId: inspection.inspectionId,
    expectedRevision: 0 }, new AbortController().signal)

  const warm = await fixture({ version: 'v2', owner: 8, home: a.root })
  expect(await warm.service.canEnableLocalService('node')).toBe(true)
  expect(await warm.service.tick()).toMatchObject({ intake: 'running', acceptingCapabilityIds: ['video.render'] })
  const workload = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const shard = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  let entered = false; let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => { release = resolve })
  provider.run.mockImplementationOnce(async (input) => {
    entered = true; await pending
    const path = join(input.workspacePath, 'result.mp4')
    await writeFile(path, '0000ftyp simulated media; no GPU was run')
    return { path, filename: 'result.mp4', contentType: 'video/mp4' }
  })
  const proof = warm.binding.deviceProof.payload
  if (proof.contract_version !== 'v2') throw new Error('Expected actual signed V2 tuple')
  warm.server.send('shard_assign', { workload_id: workload, shard_id: shard, attempt: 1, account_id: 999,
    task_type: warm.binding.declaration.taskType, runtime: 'python3', input_kind: 'inline', inline_input: '在途任务',
    input_ref: '', input_refs: [], code_url: '', code_sha256: '', timeout_s: 60, verification_policy: 'artifact',
    execution_model: '', capability: '', capability_version: '', lease_token: 'fixture-only-private-lease', params: { seconds: 5 },
    native_device_lease: { schema: 'qianshou.native-h3-task-lease.v2', publication_id: proof.publication_id,
      owner_id: proof.owner_id, device_id: proof.device_id, task_type: proof.task_type, capability_id: proof.capability_id,
      contract_version: proof.contract_version, contract_sha256: proof.contract_sha256,
      artifact_digest: proof.artifact_digest, source_digest: proof.source_digest,
      logical_binding_sha256: proof.logical_binding_sha256, local_owner_config_digest: proof.local_owner_config_digest,
      device_binding_revision: proof.device_binding_revision, connection_id: connection,
      device_key_id: 'native-device-fixture', workload_id: workload, shard_id: shard, attempt: 1 } })
  await vi.waitFor(async () => { await warm.service.tick(); expect(entered).toBe(true) })
  await expect(a.service.startH3OwnerSelfTest({ contextId: saved.contextId,
    revision: saved.revision, prompt: '不能与普通任务争抢 GPU' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'H3_SETUP_BUSY' })
  expect(trialProgram).not.toHaveBeenCalled()
  try {
    expect(await warm.service.canEnableLocalService('node')).toBe(false)
    await warm.service.refreshNativeH3OrderAdapters()
    expect(await warm.service.tick()).toMatchObject({ intake: 'paused', acceptingCapabilityIds: [] })
  } finally { release?.() }
  await vi.waitFor(async () => {
    await warm.service.tick()
    expect(warm.server.frames.find(frame => frame.type === 'shard_result' && frame.payload.shard_id === shard)?.payload)
      .toMatchObject({ ok: true, artifact: { schema: 'artifact.v1', account_id: 999 } })
  })
  expect(provider.run).toHaveBeenCalledOnce()
  expect(warm.server.connectionCount).toBe(1)
  await warm.service.stop('fixture complete')
  const operation = await a.service.startH3OwnerSelfTest({ contextId: saved.contextId,
    revision: saved.revision, prompt: '原任务完成后显式试片，模拟未知结果' }, new AbortController().signal)
  await vi.waitFor(async () => {
    expect(await a.service.h3OwnerSelfTestStatus(operation.operationId)).toMatchObject({ state: 'unknown' })
  })
  expect(trialProgram).toHaveBeenCalledOnce()
  await a.ctx.fiber.dispose()

  // This is a new Loader, profile, authenticated owner and current signed proof.
  // Its ready external provider cannot treat another scope's retained operation as idle.
  const b = await fixture({ version: 'v2', owner: 8, home: a.root })
  expect(b.service.acknowledgedConnectionId()).toBe(connection)
  expect(await b.service.canEnableLocalService('node')).toBe(false)
  expect(await b.service.nativeH3OrderAdapterReady(b.binding.declaration.taskType)).toBe(false)
  expect(await b.service.tick()).toMatchObject({ intake: 'paused', acceptingCapabilityIds: [] })
  b.service.setPanelAccepting(true)
  expect(b.service.status().intake).toBe('paused')
  await expect(b.service.selectArtifactAdapter({ root: b.root, digest: 'a'.repeat(64),
    pythonPath: join(b.root, 'python'), swiftPath: join(b.root, 'swift') }))
    .rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(b.server.frames.filter(frame => frame.type === 'native_h3_adapter_update').every(frame =>
    Array.isArray(frame.payload.adapters) && frame.payload.adapters.length === 0)).toBe(true)
  expect(trialProgram).toHaveBeenCalledOnce()
  expect(provider.run).toHaveBeenCalledOnce()
  await b.service.stop('fixture complete')

  const independent = await fixture({ version: 'v2', owner: 8 })
  expect(await independent.service.canEnableLocalService('node')).toBe(true)
  expect(await independent.service.nativeH3OrderAdapterReady(independent.binding.declaration.taskType)).toBe(true)
  expect(trialProgram).toHaveBeenCalledOnce()
  expect(provider.run).toHaveBeenCalledOnce()
  await independent.service.stop('fixture complete')
})

it('does not discover H3 on repeated ticks for an unconfigured host and keeps the original ACK connection', async () => {
  const f = await fixture({ configured: false })
  const calls = f.read.mock.calls.length
  for (let i = 0; i < 3; i++) await f.service.tick()
  expect(f.read.mock.calls).toHaveLength(calls)
  expect(calls).toBe(0)
  expect(f.server.connectionCount).toBe(1)
  expect(provider.run).not.toHaveBeenCalled()
})

it('backs off an actually empty native discovery for 30 seconds while explicit refresh bypasses scheduling only', async () => {
  const f = await fixture({ version: 'v2' })
  f.state.bindings = []
  await f.service.refreshNativeH3OrderAdapters()
  const calls = f.read.mock.calls.length
  for (let i = 0; i < 3; i++) await f.service.tick()
  expect(f.read.mock.calls).toHaveLength(calls)
  expect(f.server.connectionCount).toBe(1)
  const actualNow = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(actualNow + 30_001)
  try { await f.service.tick() } finally { clock.mockRestore() }
  expect(f.read.mock.calls).toHaveLength(calls + 1)
  f.state.bindings = [f.binding]
  await f.service.refreshNativeH3OrderAdapters()
  expect(await f.service.nativeH3OrderAdapterReady(f.binding.declaration.taskType)).toBe(true)
  expect(f.server.connectionCount).toBe(1)
  expect(provider.run).not.toHaveBeenCalled()
})

it('withdraws a removed actual H3 configuration once without cloud discovery or repeated empty updates', async () => {
  const f = await fixture({ version: 'v2' })
  const calls = f.read.mock.calls.length
  await unlink(f.h3OwnerConfigPath)
  await f.service.tick()
  const updates = f.server.frames.filter(frame => frame.type === 'native_h3_adapter_update')
  expect(updates.at(-1)?.payload.adapters).toEqual([])
  for (let i = 0; i < 3; i++) await f.service.tick()
  expect(f.read.mock.calls).toHaveLength(calls)
  expect(f.server.frames.filter(frame => frame.type === 'native_h3_adapter_update')).toHaveLength(updates.length)
  expect(f.server.connectionCount).toBe(1)
  expect(provider.run).not.toHaveBeenCalled()
})

it('runs two purpose-signed canonical reviews under the actual Loader shared reservation and restores the same ACK after upload', async () => {
  const f = await fixture({ version: 'canonical' })
  for (const seed of [101, 102]) {
    provider.run.mockImplementationOnce(async (input) => {
      const path = join(input.workspacePath, 'result.mp4')
      await writeFile(path, '0000ftyp controlled review bytes, no GPU')
      return { path, filename: 'result.mp4', contentType: 'video/mp4' }
    })
    const now = Math.floor(Date.now() / 1000)
    const challengeInput = { prompt: '真实中文独立审核试片', seconds: 5, seed }
    const payload = { ...f.tupleV2, schema: 'qianshou.native-h3-review-challenge.v2',
      purpose: 'qianshou:native-h3-review-challenge.v2', challenge_nonce: Buffer.alloc(32, seed).toString('base64url'),
      challenge_input: challengeInput,
      challenge_input_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(challengeInput)).digest('hex'),
      issued_at: now - 1, expires_at: now + 899 }
    const challenge = verifyNativeH3ReviewChallengeV2({ key_id: 'fixture', payload,
      signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), f.pair.privateKey).toString('base64url') },
    f.tupleV2, new Map([['fixture', f.pair.publicKey]]), now)
    let entered = false
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => { release = resolve })
    const result = f.service.runNativeH3ReviewChallenge({ selection: f.binding,
      publicationId, contractSha256: f.binding.contractSha256, challenge, signal: new AbortController().signal,
      assertBindingCurrent: async () => { expect(f.state.bindings[0]).toBe(f.binding) },
      upload: async (media) => {
        entered = true
        expect(JSON.parse(await readFile(join(f.root, 'qianshou-h3-owner', 'execution-reservation.json'), 'utf8')))
          .toMatchObject({ runtime: 'canonical', state: 'pending' })
        await wait
        return { schema: 'artifact.v1', object_key: 'review/result.mp4', object_version_id: `immutable-${seed}`,
          filename: media.filename, content_type: media.contentType, size_bytes: media.bytes.byteLength,
          sha256: media.sha256, result_id: `review-${seed}` }
      } })
    // Observe rejection immediately while waiting on the CPU-only upload fixture.
    const observed = result.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await vi.waitFor(() => { expect(entered).toBe(true) })
      expect(await f.service.tick()).toMatchObject({ intake: 'paused', acceptingCapabilityIds: [] })
      expect(await f.service.canEnableLocalService('node')).toBe(false)
      const second = f.service.runNativeH3ReviewChallenge({ selection: f.binding,
        publicationId, contractSha256: f.binding.contractSha256, challenge, signal: new AbortController().signal,
        assertBindingCurrent: async () => {}, upload: async () => { throw new Error('No second upload') } })
      await expect(second).rejects.toThrow()
    } finally { release?.() }
    const completed = await observed
    if ('error' in completed) throw completed.error
    expect(completed.value).toMatchObject({ schema: 'qianshou.native-h3-review-execution.v2',
      challenge_nonce: challenge.payload.challenge_nonce, device_binding_revision: 1 })
    expect(await f.service.tick()).toMatchObject({ intake: 'running', acceptingCapabilityIds: ['video.render'] })
  }
  expect(provider.run).toHaveBeenCalledTimes(2)
  expect(f.server.connectionCount).toBe(1)
})

it('does not use a verified static SVG artifact as authority to discover H3 on each tick', async () => {
  const f = await fixture({ configured: false, staticSvg: true })
  const hello = f.server.frames.find(frame => frame.type === 'hello')
  expect(hello?.payload.capabilities).toMatchObject({ verified_task_adapters: [{ task_type: 'bar_chart_svg_v1' }] })
  for (let i = 0; i < 3; i++) {
    expect(await f.service.tick()).toMatchObject({ intake: 'running', acceptingCapabilityIds: ['video.render'] })
  }
  expect(f.read).not.toHaveBeenCalled()
  expect(f.server.frames.filter(frame => frame.type === 'native_h3_adapter_update')).toHaveLength(0)
  expect(f.server.connectionCount).toBe(1)
  expect(provider.run).not.toHaveBeenCalled()
})
