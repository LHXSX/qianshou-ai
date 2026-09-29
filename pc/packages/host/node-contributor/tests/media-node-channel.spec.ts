/** Real PC consumer talks to the Guangzhou HTTP routes and SQLite inbox, without GPU or accounting. */
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MediaNodeChannel, mediaNodeOrigin, type MediaNodeChannelOptions, type MediaNodeDelivery } from '../src/media-node-channel.ts'
import { discoverLocalMedia, localMediaOrigin } from '../src/local-media-discovery.ts'
import { registerMediaNodeRoutes, type MediaNodeControl, type MediaNodeExecutionPort } from '../src/media-node-routes.ts'
import { SharingCoordinator } from '../src/sharing-coordinator.ts'
import { SharingStore } from '../src/sharing-store.ts'
import { NodeContributorError } from '../src/errors.ts'
import type { Context } from '@deepseek-ai/cordis'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'media-channel-integration-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(new URL('./fixtures/media-node-gateway.mjs', import.meta.url))], {
    env: { ...process.env, MEDIA_NODE_TEST_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const replies = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 0
  let diagnostics = ''
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
  const rpc = (method: string, value?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++nextId; replies.set(id, { resolve, reject }); child.send({ id, method, value })
  })
  const origin = await new Promise<string>((resolve, reject) => {
    child.on('message', (message: unknown) => {
      const value = message as { ready?: boolean; origin?: string; id?: number; result?: unknown; error?: string }
      if (value.ready === true && value.origin !== undefined) { resolve(value.origin); return }
      const reply = value.id === undefined ? undefined : replies.get(value.id)
      if (reply !== undefined) {
        replies.delete(value.id as number)
        if (value.error !== undefined) reply.reject(new Error(value.error)); else reply.resolve(value.result)
      }
    })
    child.once('exit', () =>{  reject(new Error('gateway fixture exited: ' + diagnostics)) })
  })
  const paths = async () => await rpc('paths') as string[]
  const store = { directory: async () => await rpc('directory') as Record<string, unknown>[],
    dispatch: (value: unknown) => rpc('dispatch', value) }
  cleanup.push(async () => { await rpc('close'); if (child.exitCode === null) await once(child, 'exit') })
  const options: MediaNodeChannelOptions = { origin, directory: join(root, 'host'), ownerId: '21',
    adapterVersion: 'fixture.v1', capabilityRevision: 'fixture-profile.v1', maxConcurrency: 1,
    capabilities: [{ profile_id: 'fixture-video', profile_version: 1, model_sha256: 'a'.repeat(64),
      workflow_sha256: 'b'.repeat(64), validation_receipt_sha256: 'c'.repeat(64) }],
    waitMs: 200, requestTimeoutMs: 2000, maxResponseBytes: 17 * 1024 * 1024,
    readAccessToken: async () => 'owner-access-token-fixture', assertOwner: async () => {},
    readHeartbeat: async () => ({ freeSlots: 1, runningAttemptIds: [], freeVramMb: 8192, availableSeconds: 60 }), onTask: async () => {} }
  const client = (override: Partial<MediaNodeChannelOptions> = {}) => {
    const channel = new MediaNodeChannel({ ...options, ...override })
    cleanup.push(() => channel.close())
    return channel
  }
  const online = async (channel: MediaNodeChannel) => {
    void channel.run().catch(() => undefined)
    await vi.waitFor(async () => {
      expect(channel.status().state).toBe('connected')
      expect((await store.directory())[0]).toMatchObject({ online: true })
    })
  }
  const dispatch = (channel: MediaNodeChannel) => store.dispatch({ deviceId: channel.status().deviceId!,
    taskId: 'fixture-task', attemptId: 'fixture-attempt', leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
    quoteId: 'fixture-quote', authorizationId: 'fixture-authorization', envelope: { spec: { task_type: 'video_generate', media_input: { capability: 'video', mode: 'image_to_video', prompt: 'integration video', negative_prompt: '', quality: 'fast', orientation: 'landscape', seconds: 5, assets: [{ asset_id: 'first-frame', sha256: 'd'.repeat(64), role: 'first_frame' }], profile_id: 'fixture-video', profile_version: 1 } } } })
  return { root, paths, store, options, client, online, dispatch, failChannelOnce: () => rpc('failChannelOnce'),
    failDisconnectOnce: () => rpc('failDisconnectOnce'), adminList: () => rpc('adminList') }
}

function ownerRoutes(f: Awaited<ReturnType<typeof fixture>>, executor: MediaNodeExecutionPort, ownerId = async () => 21) {
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  const effects: (() => unknown)[] = []
  const ctx = {
    get: (key: string) => key === 'qianshouMediaNodeExecutor' ? executor : undefined,
    connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      handlers.set(route.path, route.fetch); return () => handlers.delete(route.path)
    } } },
    effect: (activate: () => () => unknown) => { effects.push(activate()) },
  } as unknown as Context
  const control = registerMediaNodeRoutes(ctx, { gatewayOrigin: f.options.origin, directory: join(f.root, 'routes'), adapterVersion: 'fixture.v1',
    ownerId, accessToken: f.options.readAccessToken, reconnectInitialMs: 100, reconnectMaxMs: 200,
    requestTimeoutMs: 2000, waitMs: 200, discoveryTimeoutMs: 2000 })
  cleanup.push(async () => { for (const dispose of effects.reverse()) await dispose() })
  return Object.assign(async (action: 'connect' | 'disconnect' | 'status') => {
    const handler = handlers.get('/api/qianshou/node/media/' + action)
    if (handler === undefined) throw new Error('route missing')
    return handler(new Request('http://127.0.0.1/api/qianshou/node/media/' + action, { method: action === 'status' ? 'GET' : 'POST' }))
  }, { control })
}

function sharingPresence(f: Awaited<ReturnType<typeof fixture>>, channel: () => MediaNodeControl,
  owner: () => Promise<string>, presenceAllowed: () => Promise<boolean>) {
  const coordinator = new SharingCoordinator({ directory: join(f.root, 'sharing'), gatewayOrigin: f.options.origin,
    metadataPublicKey: '', metadataKeyId: '', guangzhouPublicKey: '', guangzhouKeyId: '', uploadPublicKey: '', uploadKeyId: '', authorizationPublicKey: '',
    authorizationKeyId: '', orderPublicKey: '', orderKeyId: '', downloadOrigins: [], owner,
    executionState: async () => 'idle', token: f.options.readAccessToken, workerId: () => null, coreOrigin: () => null, channel, presenceAllowed,
    admission: async action => action(), occupancyChanged: () => {}, legacyBusy: () => false })
  return coordinator
}

async function confirmed(coordinator: SharingCoordinator, mode: 'image' | 'video', action: 'enable' | 'pause' | 'resume' | 'revoke', requestId: string) {
  const snapshot = await coordinator.snapshot()
  return coordinator.command(mode, action, requestId, snapshot.scopeId ?? undefined,
    action === 'enable' || action === 'resume' ? { version: 'qianshou.media-sharing-consent.v1', connection: true,
      execution: 'idle_only' } : undefined)
}

it('owns only its presence start across automatic epochs and withdraws empty capabilities when policy is revoked', async () => {
  const f = await fixture(); let allowed = true
  const coordinator = sharingPresence(f, () => routes.control, async () => '21', async () => allowed)
  const routes = ownerRoutes(f, coordinator.executor); const control = routes.control
  cleanup.push(() => coordinator.close())
  await coordinator.snapshot(); expect(await f.store.directory()).toEqual([])
  await confirmed(coordinator, 'image', 'enable', randomUUID())
  await vi.waitFor(async () => {
    expect((await f.store.directory())[0]).toMatchObject({ online: true, freeSlots: 0, media_profiles: [] })
    expect((await coordinator.snapshot()).connection).toMatchObject({ deviceAuthorization: 'authorized',
      channel: 'connected', heartbeat: 'accepted' })
  }, { timeout: 3000 })
  expect(coordinator.executor.capabilities).toEqual([])
  await vi.waitFor(async () => { expect((await coordinator.snapshot()).modes[0]).toMatchObject({ phase: 'blocked',
    reason: 'catalog_unavailable' }) })
  await expect(f.store.dispatch({ deviceId: control.status()?.deviceId, taskId: 'fixture-task',
    attemptId: 'fixture-attempt', leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
    quoteId: 'fixture-quote', authorizationId: 'fixture-authorization', envelope: { spec: { task_type: 'video_generate',
      media_input: { capability: 'video', mode: 'image_to_video', prompt: 'fixture', negative_prompt: '', quality: 'fast',
        orientation: 'landscape', seconds: 5, assets: [{ asset_id: 'first-frame', sha256: 'd'.repeat(64), role: 'first_frame' }],
        profile_id: 'fixture-video', profile_version: 1 } } } })).rejects.toThrow('MEDIA_NODE_PROFILE_UNAVAILABLE')
  const epoch = control.status()!.connectionEpoch
  await f.failChannelOnce()
  await vi.waitFor(() => { expect(control.status()?.state).toBe('connected'); expect(control.status()?.connectionEpoch).toBeGreaterThan(epoch) },
    { timeout: 3000 })
  allowed = false
  await confirmed(coordinator, 'image', 'resume', randomUUID())
  await vi.waitFor(() => { expect(control.status()).toMatchObject({ state: 'closed', withdrawalConfirmed: true }) })
  expect((await f.store.directory())[0]).toMatchObject({ online: false, freeSlots: 0 })
  expect((await coordinator.snapshot()).modes[0]).toMatchObject({ phase: 'blocked', reason: 'owner_policy_blocked' })
  const activePaths = async () => (await f.paths()).filter(path => !path.startsWith('/v1/nodes/probe?'))
  const requests = (await activePaths()).length
  await confirmed(coordinator, 'video', 'enable', randomUUID())
  expect((await activePaths()).length).toBe(requests); expect(coordinator.executor.capabilities).toEqual([])
})

it('does not acquire or disconnect a manual channel and never projects its authorization onto a different owner', async () => {
  const f = await fixture(); let owner = '21'
  const routes = ownerRoutes(f, { capabilityRevision: f.options.capabilityRevision, capabilities: f.options.capabilities,
    maxConcurrency: 1, readHeartbeat: f.options.readHeartbeat, onTask: f.options.onTask })
  await routes('connect')
  await vi.waitFor(() => { expect(routes.control.status()?.state).toBe('connected'); expect(routes.control.status()?.heartbeatAt).toBeTypeOf('number') })
  const coordinator = sharingPresence(f, () => routes.control, async () => owner, async () => true)
  let closed = false; cleanup.push(async () => { if (!closed) await coordinator.close() })
  expect(await routes.control.connectOwned?.()).toBeNull()
  await coordinator.snapshot(); coordinator.start()
  await vi.waitFor(async () => { expect((await coordinator.snapshot()).hardware).not.toBeNull() })
  expect(routes.control.status()?.state).toBe('connected')
  owner = '22'
  expect((await coordinator.snapshot()).connection).toMatchObject({ deviceAuthorization: 'unknown', channel: 'idle',
    heartbeat: 'unknown', heartbeatAt: null })
  await coordinator.close(); closed = true
  expect(routes.control.status()?.state).toBe('connected')
  expect((await f.paths()).filter(path => path === '/v1/nodes/disconnect')).toHaveLength(0)
})

it('keeps only the original zero-slot epoch and status recovery while an admitted attempt drains after policy withdrawal', async () => {
  const f = await fixture(); let allowed = true
  const coordinator = sharingPresence(f, () => routes.control, async () => '21', async () => allowed)
  const routes = ownerRoutes(f, coordinator.executor); const control = routes.control
  cleanup.push(() => coordinator.close())
  await confirmed(coordinator, 'image', 'enable', randomUUID())
  await vi.waitFor(() => { expect(control.status()?.state).toBe('connected') })
  const store = await SharingStore.open(join(f.root, 'sharing')); cleanup.push(async () => { store.close() })
  const task = { taskId: randomUUID(), attemptId: randomUUID(), sequence: 1, quoteId: 'fixture-quote',
    authorizationId: randomUUID(), leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
    expired: false, envelope: { plan: {}, spec: { media_input: { capability: 'image' } } } }
  store.admit({ task, owner: '21', mode: 'image', state: 'unknown', assetId: randomUUID(),
    outputPath: join(f.root, 'original.png'), eventSequence: 0, result: null })
  const epoch = control.status()!.connectionEpoch
  allowed = false; await confirmed(coordinator, 'image', 'pause', randomUUID())
  await vi.waitFor(async () => {
    expect((await f.store.directory())[0]).toMatchObject({ online: true, freeSlots: 0, connectionEpoch: epoch })
    expect(await coordinator.executor.readHeartbeat()).toMatchObject({ freeSlots: 0, runningAttemptIds: [task.attemptId] })
    expect((await f.paths()).some(path => path === '/v1/nodes/media/task-status')).toBe(true)
  })
  expect((await coordinator.snapshot()).modes[0]?.phase).toBe('paused')
  expect(store.active()[0]?.state).toBe('unknown'); expect(coordinator.executor.capabilities).toEqual([])
  expect((await f.paths()).filter(path => path === '/v1/nodes/disconnect')).toHaveLength(0)
})

it('issues a new private lease for a coordinator capability transition without letting the old lease close it', async () => {
  const f = await fixture()
  const executor = { capabilityRevision: 'presence-empty', capabilities: f.options.capabilities.slice(0, 0),
    maxConcurrency: 1, readHeartbeat: f.options.readHeartbeat, onTask: f.options.onTask }
  const routes = ownerRoutes(f, executor)
  await routes.control.prepare() // A prepare-only identity does not consume channel-start ownership.
  const old = await routes.control.connectOwned?.(); expect(old).not.toBeNull()
  await vi.waitFor(() => { expect(old?.current()?.state).toBe('connected') })
  executor.capabilityRevision = f.options.capabilityRevision
  executor.capabilities = f.options.capabilities.map(capability => ({ ...capability }))
  const replacement = await routes.control.connectOwned?.(); expect(replacement).not.toBeNull()
  await vi.waitFor(() => { expect(replacement?.current()?.state).toBe('connected') })
  expect(old?.current()).toBeUndefined()
  const current = replacement?.current()
  if (replacement === undefined || replacement === null || current === undefined) throw new Error('fixture lease unavailable')
  expect(await old?.disconnect(current.connectionEpoch)).toBe(false)
  expect(await replacement.disconnect(current.connectionEpoch)).toBe(true)
  expect(routes.control.status()).toMatchObject({ state: 'closed', withdrawalConfirmed: true })
})

it('serializes owner connect actions and automatically recovers a network interruption before withdrawing on close', async () => {
  const f = await fixture()
  const request = ownerRoutes(f, { capabilityRevision: f.options.capabilityRevision, capabilities: f.options.capabilities,
    maxConcurrency: 1, readHeartbeat: f.options.readHeartbeat, onTask: f.options.onTask })
  await Promise.all([request('connect'), request('connect'), request('connect')])
  await vi.waitFor(async () =>{  expect((await f.store.directory())[0]).toMatchObject({ online: true }) }, { timeout: 3000 })
  expect((await f.paths()).filter(path => path === '/v1/nodes/register')).toHaveLength(1)
  const epoch = (await f.store.directory())[0]?.connectionEpoch as number
  await f.failChannelOnce()
  await vi.waitFor(async () => {
    const node = (await f.store.directory())[0]
    expect(node?.online).toBe(true); expect(node?.connectionEpoch).toBeGreaterThan(epoch)
  }, { timeout: 3000 })
  await request('disconnect')
  expect((await f.store.directory())[0]).toMatchObject({ online: false, freeSlots: 0 })
  expect(await (await request('status')).json()).toMatchObject({ state: 'closed', withdrawalConfirmed: true })
})

it.each(['revision', 'capabilities', 'concurrency'] as const)(
  'withdraws an in-place executor %s change until the owner explicitly connects the new snapshot', async (fact) => {
    const f = await fixture()
    const onTask = vi.fn<MediaNodeChannelOptions['onTask']>(async () => {})
    const executor = { capabilityRevision: f.options.capabilityRevision,
      capabilities: f.options.capabilities.map(capability => ({ ...capability })),
      maxConcurrency: 1, readHeartbeat: f.options.readHeartbeat, onTask }
    const request = ownerRoutes(f, executor)
    await request('connect')
    await vi.waitFor(async () =>{  expect((await f.store.directory())[0]).toMatchObject({ online: true }) })
    const oldEpoch = (await f.store.directory())[0]?.connectionEpoch as number
    if (fact === 'revision') executor.capabilityRevision = 'fixture-profile.v2'
    if (fact === 'capabilities') {
      const capability = executor.capabilities[0]
      if (capability === undefined) throw new Error('fixture capability unavailable')
      capability.model_sha256 = 'd'.repeat(64)
    }
    if (fact === 'concurrency') executor.maxConcurrency = 2
    await vi.waitFor(async () => {
      const status = await (await request('status')).json() as { state: string; errorCode: string }
      expect(status).toMatchObject({ state: 'offline', errorCode: 'MEDIA_NODE_EXECUTOR_CHANGED', withdrawalConfirmed: true })
      expect((await f.store.directory())[0]).toMatchObject({ online: false, freeSlots: 0,
        capabilityRevision: 'fixture-profile.v1', max_media_concurrent: 1,
        media_profiles: [{ model_sha256: 'a'.repeat(64) }] })
    }, { timeout: 3000 })
    // More than the retry ceiling passes without an implicit new registration.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await f.paths()).filter(path => path === '/v1/nodes/register')).toHaveLength(1)
    expect(onTask).not.toHaveBeenCalled()
    executor.capabilityRevision = 'fixture-profile.v2'
    await request('connect')
    await vi.waitFor(async () => {
      const node = (await f.store.directory())[0]
      expect(node).toMatchObject({ online: true, capabilityRevision: 'fixture-profile.v2',
        max_media_concurrent: executor.maxConcurrency, media_profiles: executor.capabilities })
      expect(node?.connectionEpoch).toBeGreaterThan(oldEpoch)
    }, { timeout: 3000 })
    expect((await f.paths()).filter(path => path === '/v1/nodes/register')).toHaveLength(2)
    expect(await (await request('status')).json()).toMatchObject({ withdrawalConfirmed: null })
    await request('disconnect')
  },
)

it('uses TLS for remote nodes and direct loopback for owner-local discovery', () => {
  expect(mediaNodeOrigin('https://media.example.test')).toBe('https://media.example.test')
  expect(() => mediaNodeOrigin('http://media.example.test')).toThrow('MEDIA_NODE_ORIGIN_INVALID')
  expect(() => mediaNodeOrigin('https://media.example.test/?token=secret')).toThrow('MEDIA_NODE_ORIGIN_INVALID')
  expect(() => localMediaOrigin('https://media.example.test')).toThrow('MEDIA_DISCOVERY_ORIGIN_INVALID')
  expect(() => localMediaOrigin('http://localhost:8188')).toThrow('MEDIA_DISCOVERY_ORIGIN_INVALID')
})

it('saves a private device credential, restores the inbox before heartbeat, and redacts its status', async () => {
  const f = await fixture(); const channel = f.client()
  await f.online(channel)
  await vi.waitFor(() => { expect(channel.status().authorized).toBe(true); expect(channel.status().heartbeatAt ?? 0).toBeGreaterThan(0) })
  expect((await f.paths()).slice(0, 3)).toEqual(['/v1/nodes/register', '/v1/nodes/channel', '/v1/nodes/heartbeat'])
  const saved = JSON.parse(await readFile(join(f.root, 'host', 'session.json'), 'utf8')) as { deviceToken: string }
  expect(saved.deviceToken).toMatch(/^[a-f0-9]{64}$/u)
  expect(JSON.stringify(channel.status())).not.toContain(saved.deviceToken)
  const cold = f.client(); await cold.prepare()
  expect(cold.status()).toMatchObject({ state: 'idle', connectionEpoch: channel.status().connectionEpoch,
    authorized: false, heartbeatAt: null })
  if (process.platform !== 'win32') expect((await stat(join(f.root, 'host', 'session.json'))).mode & 0o777).toBe(0o600)
})

it('keeps a rejected assignment unread and replays a durable admission on reconnect without executing twice', async () => {
  const f = await fixture()
  let allow = false
  const deliveries: MediaNodeDelivery[] = []
  const admitted = new Set<string>()
  let executions = 0
  const onTask: MediaNodeChannelOptions['onTask'] = async (task) => {
    deliveries.push(task)
    if (!allow) throw new Error('fixture admission refused')
    if (!admitted.has(task.attemptId)) { admitted.add(task.attemptId); executions++ }
  }
  const channel = f.client({ onTask })
  await f.online(channel); await f.dispatch(channel)
  await vi.waitFor(() => { expect(channel.status().state).toBe('offline'); expect(deliveries.length).toBe(1) })
  expect(channel.status().sequence).toBe(0)
  allow = true
  await f.online(channel)
  await vi.waitFor(() =>{  expect(channel.status().sequence).toBeGreaterThan(0) })
  const identity = channel.status().deviceId
  await channel.close()
  const restarted = f.client({ onTask })
  await f.online(restarted)
  expect(restarted.status().deviceId).toBe(identity)
  expect(restarted.status().connectionEpoch).toBeGreaterThan(channel.status().connectionEpoch)
  expect(executions).toBe(1)
  expect(deliveries.length).toBe(3)
  expect((await f.paths()).filter(path => path === '/v1/nodes/register')).toHaveLength(1)
  expect((await f.paths()).filter(path => path === '/v1/nodes/reconnect')).toHaveLength(2)
})

it('pauses a node without an executor by reporting zero free slots', async () => {
  const f = await fixture()
  const onTask = vi.fn<MediaNodeChannelOptions['onTask']>(async () => {})
  const channel = f.client({ capabilities: [], onTask,
    readHeartbeat: async () => ({ freeSlots: 0, runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 }) })
  await f.online(channel)
  expect((await f.store.directory())[0]).toMatchObject({ online: true, freeSlots: 0, media_profiles: [] })
  await expect(f.dispatch(channel)).rejects.toThrow('MEDIA_NODE_PROFILE_UNAVAILABLE')
  expect(channel.status().sequence).toBe(0)
  expect(onTask).not.toHaveBeenCalled()
})

it('does not report device authorization or heartbeat when Guangzhou rejects the real registration request', async () => {
  const f = await fixture(); const channel = f.client({ readAccessToken: async () => 'rejected-owner-fixture' })
  await expect(channel.run()).rejects.toThrow('MEDIA_NODE_AUTH_REJECTED')
  expect(channel.status()).toMatchObject({ state: 'offline', errorCode: 'MEDIA_NODE_AUTH_REJECTED',
    authorized: false, heartbeatAt: null, connectionEpoch: 0 })
  expect(await f.store.directory()).toEqual([])
  expect(await f.paths()).toEqual(['/v1/nodes/register'])
})

it('does not reconnect or dispatch after its authenticated owner disappears', async () => {
  const f = await fixture(); let authenticated = true
  const channel = f.client({ assertOwner: async () => { if (!authenticated) throw new Error('owner logged out') } })
  await f.online(channel)
  authenticated = false
  await vi.waitFor(() =>{  expect(channel.status().state).toBe('offline') })
  expect(channel.status()).toMatchObject({ authorized: false, heartbeatAt: null })
  const before = (await f.paths()).filter(path => path !== '/v1/nodes/disconnect').length
  await channel.close()
  expect((await f.paths()).filter(path => path !== '/v1/nodes/disconnect').length).toBe(before)
  expect((await f.store.directory())[0]).toMatchObject({ online: false, freeSlots: 0 })
})

it.each(['owner', 'request'] as const)(
  'preserves the %s failure separately from an unconfirmed Guangzhou withdrawal', async (cause) => {
    const f = await fixture()
    let authenticated = true
    const channel = f.client({ assertOwner: async () => {
      if (!authenticated) throw new NodeContributorError('MEDIA_NODE_OWNER_CHANGED')
    } })
    await f.online(channel)
    expect(channel.status().withdrawalConfirmed).toBeNull()
    const epoch = channel.status().connectionEpoch
    await f.failDisconnectOnce()
    if (cause === 'owner') authenticated = false
    else await f.failChannelOnce()
    const errorCode = cause === 'owner' ? 'MEDIA_NODE_OWNER_CHANGED' : 'MEDIA_NODE_REQUEST_FAILED'
    await vi.waitFor(() => {
      expect(channel.status()).toMatchObject({ state: 'offline', errorCode, withdrawalConfirmed: false })
    })
    // Guangzhou still reports the previous live session: local failure is not a withdrawal receipt.
    expect((await f.store.directory())[0]).toMatchObject({ online: true })
    if (cause === 'request') {
      await f.online(channel)
      expect(channel.status().connectionEpoch).toBeGreaterThan(epoch)
      expect(channel.status().withdrawalConfirmed).toBeNull()
    }
    await channel.close()
    expect(channel.status()).toMatchObject({ state: 'closed', withdrawalConfirmed: true,
      errorCode: cause === 'owner' ? errorCode : null })
    expect((await f.store.directory())[0]).toMatchObject({ online: false, freeSlots: 0 })
  },
)

it('discovers only model identifiers and memory; never starts a workflow or confuses inventory with readiness', async () => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`)
    const value = request.url === '/system_stats' ? { system: { argv: ['/private/model/path'] },
      devices: [{ name: 'fixture-gpu', type: 'cuda', vram_total: 8388608, vram_free: 4194304 }] }
      : request.url === '/models' ? ['diffusion_models', 'vae']
        : request.url === '/models/diffusion_models' ? ['fixture-model.safetensors'] : ['fixture-vae.safetensors']
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() =>{  resolve() })) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture port unavailable')
  const result = await discoverLocalMedia(`http://127.0.0.1:${address.port}`, { timeoutMs: 2000, signal: new AbortController().signal })
  expect(result).toMatchObject({ discovered: true, dispatchReady: false, requiresWorkflowVerification: true,
    devices: [{ freeVramMb: 4, totalVramMb: 8 }] })
  expect(result.models).toContainEqual({ group: 'diffusion_models', name: 'fixture-model.safetensors' })
  expect(JSON.stringify(result)).not.toContain('/private/')
  expect(paths.every(path => path.startsWith('GET '))).toBe(true)
})

it('registers an existing local image API through the actual Guangzhou HTTP channel and confirms metadata without a GPU lease', async () => {
  const f = await fixture(); const requests: string[] = []
  const models: Record<string, string[]> = { diffusion_models: ['qwen_image_2.1_int8_convrot.safetensors'],
    text_encoders: ['qwen3vl_8b_int8_convrot.safetensors'], vae: ['qwen_image_2.1_vae_bf16.safetensors'] }
  const server = createServer((req, res) => {
    requests.push(String(req.method) + ' ' + String(req.url)); res.setHeader('content-type', 'application/json')
    if (req.url === '/system_stats') res.end(JSON.stringify({ devices: [] }))
    else if (req.url === '/models') res.end(JSON.stringify(Object.keys(models)))
    else if (req.url?.startsWith('/models/')) res.end(JSON.stringify(models[req.url.slice(8)] ?? []))
    else if (req.url === '/healthz') res.end(JSON.stringify({ status: 'ok', model: 'qwen-image-2.1-int8-convrot', comfy_reachable: true, busy: false }))
    else if (req.url?.startsWith('/object_info/')) res.end(JSON.stringify({ [req.url.slice(13)]: { input: {}, output: ['fixture'] } }))
    else res.writeHead(404).end('{}')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture port unavailable')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const origin = 'http://127.0.0.1:' + String(address.port)
  const coordinator = new SharingCoordinator({ directory: join(f.root, 'api-sharing'), gatewayOrigin: f.options.origin,
    metadataPublicKey: '', metadataKeyId: '', guangzhouPublicKey: '', guangzhouKeyId: '', uploadPublicKey: '', uploadKeyId: '',
    authorizationPublicKey: '', authorizationKeyId: '', orderPublicKey: '', orderKeyId: '', downloadOrigins: [], owner: async () => '21',
    token: f.options.readAccessToken, workerId: () => null, coreOrigin: () => null, channel: () => routes.control,
    executionState: async () => 'disabled', presenceAllowed: async () => true,
    localDiscovery: { comfyOrigin: origin, imageOrigin: origin, videoOrigin: '', timeoutMs: 1000 },
    admission: async action => action(), occupancyChanged: () => {}, legacyBusy: () => false })
  const routes = ownerRoutes(f, coordinator.executor); cleanup.push(() => coordinator.close())
  await coordinator.refreshConnection(); await confirmed(coordinator, 'image', 'enable', randomUUID()); coordinator.start()
  await vi.waitFor(async () => {
    const nodes = (await f.adminList() as { nodes: Record<string, unknown>[] }).nodes
    expect(nodes[0]?.localServices).toMatchObject([{ mode: 'image', adapter: 'qianshou_image', status: 'ready',
      registration: 'reported', model: { sha256: null }, probe: { state: 'confirmed', completedAt: expect.any(String) as unknown } }])
    expect((await coordinator.snapshot()).modes[0]?.api).toMatchObject({ registration: 'registered', probeStatus: 'passed' })
  }, { timeout: 10000 })
  expect((await f.store.directory())[0]).toMatchObject({ media_profiles: [], freeSlots: 0, media_exchange_ready: false })
  expect(coordinator.executor.capabilities).toEqual([]); expect(requests.every(path => path.startsWith('GET '))).toBe(true)
  expect((await f.paths()).some(path => path === '/v1/nodes/api-observations')).toBe(true)
  expect((await f.paths()).some(path => path === '/v1/nodes/api-probe-result')).toBe(true)
  expect((await f.paths()).some(path => /dispatch|result-ticket|upload|order-current/u.test(path))).toBe(false)
})
