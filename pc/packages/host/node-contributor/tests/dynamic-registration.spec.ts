import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { FixtureWebSocketServer } from '../../compute-core/tests/transport/fixture-ws-server.ts'
import { bindInlineEdgeResident, type VerifiedTaskAdapterClaim } from '../src/edge-binding.ts'
import { EdgeWorkerResidentSession } from '@deepseek-ai/dsh-compute-core/transport/edge-worker-session'
import { apply, Config, NODE_CONTRIBUTOR_SERVICE, type NodeContributorService } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
const servers: FixtureWebSocketServer[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber?.dispose()
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
const observation = { challengeNonce: 'f8e42af1-e7a0-4c60-a53d-aa8d04def69b',
  inputDigest: `sha256:${'a'.repeat(64)}`, outputDigest: `sha256:${'b'.repeat(64)}`,
  runtimeDigest: `sha256:${'c'.repeat(64)}`, artifactDigest: `sha256:${'d'.repeat(64)}` }
const fileRuntime = { productId: 'test-file-product', entitlementId: 'author-zero',
  taskType: 'qianshou_quickjs_text_file_v1', capabilityId: 'files.text', outputKind: 'artifact_ref',
  artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: `sha256:${'b'.repeat(64)}`,
  runtimeDigest: `sha256:${'c'.repeat(64)}`, contractVersion: 'v1',
  contractSha256: `sha256:${'d'.repeat(64)}`, fileSchemaSha256: 'e'.repeat(64) }
async function fixture(): Promise<FixtureWebSocketServer> {
  const server = await FixtureWebSocketServer.start({ script(frame, peer) {
    if (frame.type === 'hello') peer.reply('welcome', { hb_interval_s: 60 })
    if (frame.type === 'auth') peer.reply('auth_ok', { worker_id: 'worker-new-file', owner_id: 167 })
    if (frame.type === 'hb') peer.reply('hb_ack', {})
    if (frame.type === 'order_adapter_challenge_result') {
      peer.reply('order_adapter_challenge_ack', { challenge_nonce: frame.payload.challenge_nonce })
    }
  } })
  servers.push(server)
  return server
}

/** Real Loader and real socket; services expose only test account metadata and fake runtime records. */
async function mount(server: FixtureWebSocketServer, catalog: object | ((ctx: Context) => void), mode: 'OFF' | 'BACKGROUND_ONLY' = 'OFF'): Promise<NodeContributorService> {
  const root = await mkdtemp(join(tmpdir(), 'node-dynamic-registration-'))
  roots.push(root)
  const path = join(root, 'cordis.yml')
  await writeFile(path, [
    '- id: bootstrap-services', "  name: 'bootstrap-services'",
    '- id: node-contributor', "  name: '@deepseek-ai/dsh-host-node-contributor'",
    '  config:', '    autoStart: false', `    mode: '${mode}'`, '    allowedTaskTypes: []',
    '    handshakeTimeoutMs: 2000', `    storePath: '${join(root, 'tasks.json')}'`,
    `    workspaceRoot: '${join(root, 'attempts')}'`, '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['bootstrap-services', { name: 'bootstrap-services', apply(ctx: Context) {
      ctx.provide('connection', { fetch: { register: () => async () => undefined } })
      ctx.provide('profileContext', { dir: root })
      ctx.provide('computeCore', { coreOrigin: () => server.origin, ownerAccountId: async () => 167,
        ownerSupplyPolicy: async () => ({ mode: mode === 'OFF' ? 'off' : 'allowed', maxConcurrency: 1, minFreeMemoryBytes: 0,
          minIdleSeconds: 60, enabledServiceIds: mode === 'OFF' ? [] : ['node'], nodeRates: [] }) })
      ctx.provide('accountSession', { ensureAccessToken: async () => 'test-account-token' })
      if (typeof catalog === 'function') catalog(ctx)
      else ctx.provide('qianshouPluginCatalog', catalog)
      ctx.provide('voiceActivity', { active: () => false, subscribe: () => () => undefined })
      ctx.provide('agents', { list: () => [] })
    } }],
    ['@deepseek-ai/dsh-host-node-contributor', { name: 'qianshou-node-contributor', inject: ['connection'], apply, Config }],
  ])
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error('unexpected test module')
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  return ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
}

describe('dynamic provider registration boundary', () => {
  it('recovers first-empty inline proof on a bounded fresh Hello without changing the worker or owner grant', { timeout: 30_000 }, async () => {
    const server = await fixture()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let installed = false
    const inlineRuntime = { ...fileRuntime, taskType: 'qs_one_click_acceptance_20260926_v1',
      capabilityId: 'text.count', outputKind: 'inline_json' }
    const run = vi.fn(async () => { throw new Error('registration must not execute an order') })
    const verify = vi.fn(async (workerId: string) => installed && workerId === 'worker-new-file' ? [inlineRuntime] : [])
    const service = await mount(server, (ctx) => {
      class RestoredCatalog extends Service {
        constructor() { super(ctx, 'qianshouPluginCatalog') }
        async verifiedPurchasedOrderRuntimes(workerId: string) { return verify(workerId) }
        async runPurchasedOrderRuntime() { return run() }
      }
      new RestoredCatalog()
    })
    await service.start()
    await service.tick()
    expect(verify).toHaveBeenCalledOnce()
    expect(server.frames.filter(frame => frame.type === 'hello')).toHaveLength(2)
    expect(service.status().declaredCapabilityIds).toEqual([])
    expect(service.status().acceptingCapabilityIds).toEqual([])

    installed = true
    await service.tick()
    expect(verify).toHaveBeenCalledOnce()
    expect(server.frames.filter(frame => frame.type === 'hello')).toHaveLength(2)
    now += 5_000
    await service.tick()
    expect(verify).toHaveBeenCalledTimes(2)
    const hellos = server.frames.filter(frame => frame.type === 'hello')
    expect(hellos).toHaveLength(3)
    expect(hellos[1]!.payload.worker_id).toBe('worker-new-file')
    expect(hellos[2]!.payload.worker_id).toBe('worker-new-file')
    expect(hellos[2]!.payload.capabilities).toMatchObject({
      provided_capabilities: [{ name: 'text.count', health: 'ok' }],
      verified_task_adapters: [expect.objectContaining({ task_type: inlineRuntime.taskType,
        capability_id: 'text.count', artifact_digest: inlineRuntime.artifactDigest,
        package_digest: inlineRuntime.packageDigest, installation_state: 'installed', self_test: 'passed' })],
    })
    // Admission rereads the just-connected capability snapshot on its next tick.
    await service.tick()
    expect(service.status().declaredCapabilityIds).toEqual(['text.count'])
    expect(service.status().acceptingCapabilityIds).toEqual([])
    expect(service.status().mode).toBe('OFF')
    const refreshed = hellos.length
    await service.tick()
    await service.tick()
    expect(server.frames.filter(frame => frame.type === 'hello')).toHaveLength(refreshed)
    expect(run).not.toHaveBeenCalled()
    await service.stop('test finished')
  })

  it.each(['inline', 'file'] as const)('retains %s claims through real Cordis service proxies without refreshing every tick', { timeout: 30_000 }, async (kind) => {
    const server = await fixture()
    const inlineRuntime = { ...fileRuntime, taskType: 'qianshou_quickjs_text_inline_v1', outputKind: 'inline_json' }
    const service = await mount(server, (ctx) => {
      class TracedCatalog extends Service {
        constructor() { super(ctx, 'qianshouPluginCatalog') }
        async verifiedPurchasedOrderRuntimes() { return kind === 'inline' ? [inlineRuntime] : [] }
        async verifiedPurchasedFileOrderRuntimes() { return kind === 'file' ? [fileRuntime] : [] }
        async runPurchasedOrderRuntime() { throw new Error('registration fixture must not execute') }
        async runPurchasedFileOrderRuntime() { throw new Error('registration fixture must not execute') }
      }
      new TracedCatalog()
    })
    await service.start()
    await service.tick()
    const hello = server.frames.filter(frame => frame.type === 'hello').at(-1)!
    expect((hello.payload.capabilities as Record<string, unknown>).verified_task_adapters).toEqual([
      expect.objectContaining({ task_type: kind === 'inline' ? inlineRuntime.taskType : fileRuntime.taskType,
        installation_state: 'installed', health: 'verified', self_test: 'passed' }),
    ])
    const count = server.frames.filter(frame => frame.type === 'hello').length
    await service.tick()
    await service.tick()
    expect(server.frames.filter(frame => frame.type === 'hello')).toHaveLength(count)
    await service.stop('test finished')
  })

  it('registers a fresh device with empty claims and permits challenge observation, then reconnects exact installed claims through Loader', { timeout: 30_000 }, async () => {
    const server = await fixture()
    let installed = false
    const run = vi.fn(async () => { throw new Error('no task may execute in this test') })
    const verify = vi.fn(async (workerId: string) => installed && workerId === 'worker-new-file' ? [fileRuntime] : [])
    const catalog = { verifiedPurchasedOrderRuntimes: async () => [],
      runPurchasedOrderRuntime: run, verifiedPurchasedFileOrderRuntimes: verify, runPurchasedFileOrderRuntime: run }
    const service = await mount(server, catalog)
    await service.start()
    expect(service.acknowledgedWorkerId()).toBe('worker-new-file')
    const hello = server.frames.find(frame => frame.type === 'hello')!
    expect(hello.payload.capabilities).toMatchObject({ provided_capabilities: [], verified_task_adapters: [] })
    expect(hello.payload).not.toHaveProperty('registrationOnly')
    expect(service.orderExecutorVerified()).toBe(false)
    expect(await service.canEnableLocalService('node')).toBe(false)
    await service.observePurchasedOrderChallenge(observation)
    expect(server.frames.some(frame => frame.type === 'order_adapter_challenge_result')).toBe(true)
    installed = true
    await service.refreshPurchasedOrderAdapters()
    await vi.waitFor(() => expect(server.frames.filter(frame => frame.type === 'hello')).toHaveLength(2))
    const current = server.frames.filter(frame => frame.type === 'hello').at(-1)!
    expect(current.payload.worker_id).toBe('worker-new-file')
    expect((current.payload.capabilities as Record<string, unknown>).verified_task_adapters).toEqual([{
      task_type: fileRuntime.taskType, capability_id: fileRuntime.capabilityId, input_kinds: ['inline'],
      output_kind: 'artifact_ref', contract_version: 'v1', artifact_digest: fileRuntime.artifactDigest,
      package_digest: fileRuntime.packageDigest, installation_state: 'installed', health: 'verified', self_test: 'passed',
    }])
    expect(verify).toHaveBeenCalledWith('worker-new-file')
    expect(server.frames.filter(frame => frame.type === 'hb').every(frame => frame.payload.mode === 'paused')).toBe(true)
    expect(service.status().mode).toBe('OFF')
    expect(await service.canEnableLocalService('node')).toBe(false)
    expect(run).not.toHaveBeenCalled()
    await service.stop('test finished')
  })

  it('refuses provider without runner and rereads runner availability on reconnect', { timeout: 30_000 }, async () => {
    const server = await fixture()
    const missing = await mount(server, { verifiedPurchasedOrderRuntimes: async () => [] })
    await expect(missing.start()).rejects.toThrow()
    expect(server.connectionCount).toBe(0)
    await missing.stop('closed missing runner')
    const run = vi.fn(async () => ({ text: '{}' }))
    const catalog: Record<string, unknown> = { verifiedPurchasedOrderRuntimes: async () => [{ ...fileRuntime, outputKind: 'inline_json' }], runPurchasedOrderRuntime: run }
    const service = await mount(server, catalog)
    await service.start()
    expect(service.acknowledgedWorkerId()).toBe('worker-new-file')
    delete catalog.runPurchasedOrderRuntime
    await expect(service.refreshPurchasedOrderAdapters()).rejects.toThrow('TRANSPORT_NOT_CONFIGURED')
    expect(server.connectionCount).toBe(1)
    expect(run).not.toHaveBeenCalled()
    expect(service.status().intake).not.toBe('running')
    await service.stop('test finished')
  })

  it('retains measured facts without execution advertisements and refuses a static empty binding', async () => {
    const server = await fixture()
    const base = { nodeId: 'test-node', agentVersion: 'test', allowedTaskTypes: [],
      handshakeTimeoutMs: 2_000, maxFrameBytes: 65_536, maxOutputBytes: 4096,
      supply: () => 'running' as const, originOf: () => server.origin, tokenOf: async () => 'test-token',
      ownerIdOf: async () => 167, verification: false as const }
    const staticEmpty = bindInlineEdgeResident(base)
    await expect(staticEmpty.connector.connect(new AbortController().signal)).rejects.toThrow('TRANSPORT_NOT_CONFIGURED')
    let available = true
    let claims: readonly VerifiedTaskAdapterClaim[] = []
    const edge = bindInlineEdgeResident({ ...base, allowEmptyDynamicAdapterRegistration: () => available,
      purchasedFileTaskAdapters: async () => claims, fileOrderRun: async () => { throw new Error('never execute') },
      probe: async () => ({ hardware: { platform: 'linux', arch: 'x64', cpuModel: 'test-cpu', logicalCores: 4,
        totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3, gpus: [], probeErrors: [] },
      localServices: [{ id: 'python3', kind: 'tool', name: 'Python 3', version: '3.12.0', verification: 'verified', reason: null }],
      activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null } }) })
    const session = await edge.connector.connect(new AbortController().signal)
    const hello = server.frames.find(frame => frame.type === 'hello')!
    expect(hello.payload.capabilities).toMatchObject({ protocol: 'qianshou.isolated-inline-session.v1',
      gpu_count: 0, runtimes: ['python3'], software: ['python3'],
      provided_capabilities: [], verified_task_adapters: [] })
    expect(session).toBeInstanceOf(EdgeWorkerResidentSession)
    expect((session as EdgeWorkerResidentSession).state()).toBe('ready') // Authenticated transport, with no dispatch capabilities.
    await edge.observeOrderAdapterChallenge(observation)
    await session.close()
    available = false
    claims = []
    await expect(edge.connector.connect(new AbortController().signal)).rejects.toThrow('TRANSPORT_NOT_CONFIGURED')
    expect(server.connectionCount).toBe(1)
  })

  it('cannot qualify Node intake from an authenticated empty session even when the owner policy enables Node', { timeout: 30_000 }, async () => {
    const server = await fixture()
    const run = vi.fn(async () => { throw new Error('empty provider cannot execute') })
    const service = await mount(server, { verifiedPurchasedOrderRuntimes: async () => [], runPurchasedOrderRuntime: run }, 'BACKGROUND_ONLY')
    await service.start()
    service.setPanelAccepting(true)
    expect(await service.canEnableLocalService('node')).toBe(false)
    expect(service.orderExecutorVerified()).toBe(false)
    expect(service.status().acceptingCapabilityIds).toEqual([])
    await service.tick()
    expect(service.status().intake).toBe('paused')
    expect(server.frames.filter(frame => frame.type === 'hb').every(frame => frame.payload.mode === 'paused')).toBe(true)
    expect(run).not.toHaveBeenCalled()
    await service.stop('test finished')
  })

  it('withdraws a runner removed while its current provider is still awaiting proof', { timeout: 30_000 }, async () => {
    const server = await fixture()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const verify = vi.fn(async () => { await pending; return [fileRuntime] })
    const catalog: Record<string, unknown> = { verifiedPurchasedOrderRuntimes: async () => [],
      runPurchasedOrderRuntime: async () => ({ text: '{}' }),
      verifiedPurchasedFileOrderRuntimes: verify, runPurchasedFileOrderRuntime: async () => { throw new Error('never execute') } }
    const service = await mount(server, catalog)
    await service.start()
    const refreshing = service.refreshPurchasedOrderAdapters()
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())
    delete catalog.runPurchasedFileOrderRuntime
    release()
    await refreshing
    const hello = server.frames.filter(frame => frame.type === 'hello').at(-1)!
    expect((hello.payload.capabilities as Record<string, unknown>).verified_task_adapters).toEqual([])
    expect(service.status().declaredCapabilityIds).toEqual([])
    await service.stop('test finished')
  })
})
