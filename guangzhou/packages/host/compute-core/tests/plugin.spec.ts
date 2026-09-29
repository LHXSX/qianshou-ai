/** Real profile boot loads the compute plugin; only the authenticated carrier and remote core are fixtures. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import * as VoiceLocal from '@deepseek-ai/dsh-host-voice-local'
import * as ComputeCore from '../src/index.ts'
import { ComputeCapabilityId, ComputeTaskId } from '../src/protocol.ts'
import { SUPPLY_ADVERTISEMENT_VERSION } from '../src/supply/advertisement.ts'

const PLUGIN = '@deepseek-ai/dsh-compute-core'
const CONNECTION_FIXTURE = 'qianshou-compute-test-connection'
const VOICE_PLUGIN = '@deepseek-ai/dsh-host-voice-local'
const AGENTS_FIXTURE = 'qianshou-compute-test-agents'
const ACCOUNT_FIXTURE = 'qianshou-compute-test-account'
const tempRoots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  }
  vi.unstubAllEnvs()
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-compute-loader-'))
  tempRoots.push(root)
  return root
}

interface Composition {
  ctx: Context
  routes: Map<string, ConnectionFetchRoute>
  request(path: string, init?: RequestInit): Promise<Response>
}

/** Real plugins and fixtures this composition may mount, on top of the authenticated carrier. */
interface CompositionOptions {
  /** Mount the real local voice plugin so voice activity has a producer instead of staying unknown. */
  voice?: boolean
  /** Mount a foreground-task registry with no running agent, so the task count is known instead of unknown. */
  agents?: boolean
  /** Optional logged-in compute-account session used instead of `tokenEnv`. */
  accountSession?: {
    ensureAccessToken: () => Promise<string | null>
    account: () => unknown
  }
}

/**
 * A live agent registry with nothing running. This is a fixture for the foreground-task fact only; voice activity
 * always comes from the real voice plugin when the composition mounts it.
 */
const agentsFixture = {
  name: AGENTS_FIXTURE,
  apply(ctx: Context) {
    ctx.provide('agents', { list: () => [] } as unknown as Context['agents'])
  },
}

async function loadComposition(
  root: string,
  config: Record<string, unknown>,
  executor?: ComputeCore.ComputeExecutor,
  options: CompositionOptions = {},
): Promise<Composition> {
  const configPath = join(root, 'cordis.yml')
  const routes = new Map<string, ConnectionFetchRoute>()
  const connectionModule = {
    name: CONNECTION_FIXTURE,
    apply(ctx: Context) {
      ctx.provide('connection', {
        fetch: {
          register(route: ConnectionFetchRoute) {
            if (routes.has(route.path)) throw new Error(`duplicate fixture route: ${route.path}`)
            routes.set(route.path, route)
            return async () => { routes.delete(route.path) }
          },
        },
      } as unknown as Context['connection'])
    },
  }
  await writeFile(configPath, [
    `- name: '${CONNECTION_FIXTURE}'`,
    ...(options.accountSession ? [`- name: '${ACCOUNT_FIXTURE}'`] : []),
    `- name: '${PLUGIN}'`,
    `  config: ${JSON.stringify(config)}`,
    ...(options.voice ? [`- name: '${VOICE_PLUGIN}'`, `  config: ${JSON.stringify({ uploadTimeoutMs: 2_000 })}`] : []),
    ...(options.agents ? [`- name: '${AGENTS_FIXTURE}'`] : []),
    ...(executor ? ["- name: 'qianshou-compute-test-executor'"] : []),
    '',
  ].join('\n'))

  const ctx = await boot('qianshou-compute-test', configPath, undefined, (preparing) => {
    const modules = new Map<string, unknown>([[PLUGIN, ComputeCore], [CONNECTION_FIXTURE, connectionModule]])
    if (options.accountSession) {
      const session = options.accountSession
      modules.set(ACCOUNT_FIXTURE, {
        name: ACCOUNT_FIXTURE,
        apply(accountCtx: Context) { accountCtx.provide('accountSession', session as never) },
      })
    }
    if (options.voice) modules.set(VOICE_PLUGIN, VoiceLocal)
    if (options.agents) modules.set(AGENTS_FIXTURE, agentsFixture)
    if (executor) modules.set('qianshou-compute-test-executor', {
      name: 'qianshou-compute-test-executor', inject: ['computeCore'],
      apply(ctx: Context) { ctx.effect(() => ctx.computeCore.executors.register(executor), 'fixture: native copy capability') },
    })
    preparing.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof preparing.loader.internal>
  })
  contexts.push(ctx)
  return {
    ctx,
    routes,
    async request(path, init) {
      const request = new Request(`http://qianshou-host${path}`, init)
      const route = routes.get(new URL(request.url).pathname)
      if (route === undefined) return new Response(null, { status: 404 })
      if (!route.methods.some(method => method === request.method)) return new Response(null, { status: 405 })
      return route.fetch(request)
    },
  }
}

interface CoreFixture {
  baseUrl: string
  requests: { method: string; path: string; authorization: string | undefined; body?: unknown }[]
}

async function coreFixture(handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void): Promise<CoreFixture> {
  const requests: CoreFixture['requests'] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      let body: unknown
      if (chunks.length > 0) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { body = null }
      }
      requests.push({
        method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization,
        ...(body !== undefined ? { body } : {}),
      })
      handler(request, response, body)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing core fixture address')
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests }
}

/** One advertisement request the loopback endpoint actually received. */
interface AdvertisementRequest {
  method: string
  path: string
  authorization: string | undefined
  contentType: string | undefined
  body: unknown
}

interface AdvertisementFixture {
  endpoint: string
  requests: AdvertisementRequest[]
  respond(status: number): void
}

/** Capability identifiers one recorded request body offered, in wire order. */
function offeredIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const capabilities = (body as { capabilities?: unknown }).capabilities
  if (!Array.isArray(capabilities)) return []
  return capabilities
    .filter((capability): capability is { id: string } => typeof capability === 'object' && capability !== null
      && typeof (capability as { id?: unknown }).id === 'string')
    .map(capability => capability.id)
}

/** Loopback advertisement endpoint; it records the real requests a bound port makes and never adds capabilities. */
async function advertisementFixture(initialStatus = 200, accepted: string[] = []): Promise<AdvertisementFixture> {
  const requests: AdvertisementFixture['requests'] = []
  let status = initialStatus
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown
      requests.push({ method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization,
        contentType: request.headers['content-type'], body })
      if (status !== 200) { response.writeHead(status); response.end('upstream-private-detail'); return }
      response.setHeader('Content-Type', 'application/json')
      // A real endpoint acknowledges identifiers from the set it was just offered; a withdrawal it acknowledges
      // with an empty list, so it can never acknowledge a capability the request did not carry.
      response.end(JSON.stringify({ ok: true, accepted: offeredIds(body).filter(id => accepted.includes(id)) }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing advertisement fixture address')
  return { endpoint: `http://127.0.0.1:${address.port}/api/v8/compute/supply/advertisement`, requests,
    respond(value) { status = value } }
}

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }
}

const planRequest = {
  capabilityId: 'image.batch',
  goal: '清理这批图片并保持原图尺寸。',
  budgetMinor: 50,
  currency: 'CNY',
  maxNodes: 2,
}

function catalogue(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/api/v8/auth/me') {
    response.end(JSON.stringify({ ok: true, account: { id: 7, username: 'fixture-user', role: 'user', status: 'active' } }))
    return
  }
  if (request.url === '/api/v8/developer/task-types') {
    response.end(JSON.stringify({
      ok: true,
      items: [{
        task_type: 'image.batch', description: '批量图片处理',
        accepted_input_kinds: ['inline'], default_input_kind: 'inline',
      }],
      total: 1,
    }))
    return
  }
  if (request.url === '/api/v8/workloads/workload-fixture-1') {
    response.end(JSON.stringify({ id: 'workload-fixture-1', status: 'DONE', progress: 1, result: { private: 'fixture-result' } }))
    return
  }
  response.writeHead(404).end(JSON.stringify({ error: 'unexpected fixture request' }))
}

function catalogueWithPublish(request: IncomingMessage, response: ServerResponse, body: unknown): void {
  if (request.method === 'POST' && request.url === '/api/v8/developer/tasks') {
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      ok: true, id: 'workload-fixture-1', task_id: 'workload-fixture-1', workload_id: 'workload-fixture-1',
      name: 'image.batch', task_type: 'image.batch', status: 'CREATED', progress: 0,
    }))
    return
  }
  if (request.method === 'POST' && request.url === '/api/v8/workloads') {
    response.writeHead(500).end(JSON.stringify({ error: 'workloads-submit-must-not-be-called' }))
    return
  }
  void body
  catalogue(request, response)
}

describe('compute plugin real profile composition', () => {
  it('loads a native capability contribution and consumes verified files before clearing the workspace', async () => {
    const root = await temporaryRoot()
    const sha256 = createHash('sha256').update('hello').digest('hex')
    const capabilityId = ComputeCapabilityId('fixture.copy')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json') }, {
      capabilityId, version: '1.0', execute: async (_task, context) => {
        const data = await readFile(context.inputs[0]!.path)
        const path = join(context.workspacePath, 'result')
        await writeFile(path, data)
        return { outputs: [{ name: 'result', path, bytes: data.length, sha256 }] }
      },
    })
    const service = loaded.ctx.get('computeCore')!
    const result = await service.executeTask({ version: 'qianshou.task.v1', taskId: ComputeTaskId('copy'), capabilityId, capabilityVersion: '1.0',
      inputRefs: [{ name: 'input', bytes: 5, sha256 }], parameters: {}, deadlineAt: '2026-09-14T23:00:00.000Z', maxOutputBytes: 5, idempotencyKey: 'copy' }, {
      workspace: { rootPath: join(root, 'work'), maxInputBytes: 5 }, signal: new AbortController().signal, reportProgress: () => {},
      source: { open: async () => new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('hello')); controller.close() } }) },
      consumeResult: async result => ({ content: await readFile(result.outputs[0]!.path, 'utf8'), verifiedDigest: result.outputs[0]!.sha256 }),
    })
    expect(result).toEqual({ content: 'hello', verifiedDigest: sha256 })
    expect(await readdir(join(root, 'work'))).toEqual([])
    await loaded.ctx.fiber.dispose()
    expect(service.executors.list()).toEqual([])
  })

  it('boots unconfigured, reports unavailable capabilities, and refuses paid or unverified plans', async () => {
    const root = await temporaryRoot()
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json') })
    const status = await loaded.request('/api/qianshou/compute/status')
    expect(status.status).toBe(200)
    expect(status.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await status.json()).toMatchObject({
      configured: false,
      capabilities: { workloadRead: false, quoting: false, submission: false },
    })
    const capabilities = await loaded.request('/api/qianshou/compute/capabilities')
    expect(capabilities.status).toBe(503)
    expect(await capabilities.json()).toMatchObject({ error: { code: 'COMPUTE_NOT_CONFIGURED' } })
    const create = await loaded.request('/api/qianshou/compute/plans', post({ ...planRequest, approved: true, quote: { amountMinor: 1 } }))
    expect(create.status).toBe(503)
    expect(await (await loaded.request('/api/qianshou/compute/plans')).json()).toEqual([])
    expect((await loaded.request('/api/qianshou/compute/submit', post({ approved: true }))).status).toBe(404)
  })

  it('binds the advertisement channel and withdraws through the real endpoint when admission blocks', async () => {
    const fixture = await advertisementFixture()
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    const token = 'fixture-token-not-a-real-credential'
    vi.stubEnv(tokenEnv, token)
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), tokenEnv,
      supply: { advertisementEndpoint: fixture.endpoint } })
    const response = await loaded.request('/api/qianshou/compute/supply')
    expect(response.status).toBe(200)
    // First-use policy is 'off', so the live controller must withdraw through the configured transport. A profile
    // whose advertisement port is never bound cannot produce this state: it reports 'not-connected' and no request.
    expect(await response.json()).toMatchObject({ advertisingState: 'withdrawn', advertisedCapabilityIds: [],
      eligibility: { state: 'disabled' } })
    expect(fixture.requests).toEqual([{ method: 'POST', path: '/api/v8/compute/supply/advertisement',
      authorization: `Bearer ${token}`, contentType: 'application/json',
      body: { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [] } }])
  })

  it('reports a configured advertisement endpoint that fails instead of claiming a channel', async () => {
    const fixture = await advertisementFixture(503)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), tokenEnv,
      supply: { advertisementEndpoint: fixture.endpoint } })
    const response = await loaded.request('/api/qianshou/compute/supply')
    expect(response.status).toBe(503)
    const payload: unknown = await response.json()
    expect(payload).toEqual({ error: { code: 'ADVERTISEMENT_TRANSPORT_UNAVAILABLE',
      message: 'ADVERTISEMENT_TRANSPORT_UNAVAILABLE' } })
    expect(JSON.stringify(payload)).not.toContain('upstream-private-detail')
    expect(fixture.requests).toHaveLength(1)
    // Disposal attempts one withdrawal through this transport; the channel is reachable again before removal, so
    // the drain succeeds. Measured separately: a channel that is still down yields one failed POST and does not
    // reject fiber disposal (the effect's rejection is swallowed), recorded as a residual risk in the report.
    fixture.respond(200)
  })

  it('keeps publication blocked while a composition mounts no voice-activity producer', async () => {
    const fixture = await advertisementFixture()
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), tokenEnv,
      supply: { advertisementEndpoint: fixture.endpoint,
        tools: [{ id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] }] } })
    const policy = await loaded.request('/api/qianshou/compute/supply/policy', post({ mode: 'allowed', maxConcurrency: 1,
      minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }))
    expect(policy.status).toBe(200)
    const snapshot: unknown = await policy.json()
    // A verified, owner-enabled local tool is present, yet this composition mounts no voice-activity producer, so
    // both activity facts stay unknown and unknown is not idle. The real transport therefore receives the empty
    // replacement instead of a capability publication. This is the tripwire for the safety direction: dropping the
    // producer must degrade to unknown, never to "the owner is away".
    expect(snapshot).toMatchObject({ activity: { foregroundTaskActive: null, voiceActive: null },
      eligibility: { state: 'blocked', reasons: ['HOST_ACTIVITY_UNKNOWN', 'TASK_COUNT_UNKNOWN'] },
      advertisingState: 'withdrawn', advertisedCapabilityIds: [] })
    expect(fixture.requests.map(request => request.body)).toEqual([
      { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [] },
      { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [] },
    ])
  })

  it('publishes a verified enabled service once the real voice producer reports an idle host', async () => {
    const fixture = await advertisementFixture(200, ['node'])
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), tokenEnv,
      supply: { advertisementEndpoint: fixture.endpoint,
        tools: [{ id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] }] } },
    undefined, { voice: true, agents: true })
    const policy = await loaded.request('/api/qianshou/compute/supply/policy', post({ mode: 'allowed', maxConcurrency: 1,
      minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }))
    expect(policy.status).toBe(200)
    const snapshot: unknown = await policy.json()
    // The voice plugin really reports its idle state (`active() === false`), the task registry really reports no
    // running agent, and the endpoint really acknowledged the capability: readiness, transport and acknowledgement
    // all come from live components rather than from a projection that was assumed to be idle.
    expect(snapshot).toMatchObject({ activity: { foregroundTaskActive: false, voiceActive: false },
      eligibility: { state: 'ready', reasons: [] }, advertisingState: 'advertising', advertisedCapabilityIds: ['node'] })
    const published = fixture.requests.at(-1)
    expect(published).toMatchObject({ method: 'POST', path: '/api/v8/compute/supply/advertisement' })
    expect(published?.body).toMatchObject({ version: SUPPLY_ADVERTISEMENT_VERSION,
      capabilities: [{ id: 'node', kind: 'tool', name: 'Node.js' }] })
  })

  it('withdraws with the real voice reason while a voice request is in flight and returns to ready after it ends', async () => {
    const fixture = await advertisementFixture(200, ['node'])
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), tokenEnv,
      supply: { advertisementEndpoint: fixture.endpoint,
        tools: [{ id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] }] } },
    undefined, { voice: true, agents: true })
    const policy = await loaded.request('/api/qianshou/compute/supply/policy', post({ mode: 'allowed', maxConcurrency: 1,
      minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }))
    expect(await policy.json()).toMatchObject({ eligibility: { state: 'ready' }, advertisingState: 'advertising' })
    // A real local voice request, served by the real voice route: the synthesis upload is held open, so the host is
    // genuinely busy with voice work while the supply route observes it.
    const controller = new AbortController()
    const pending = loaded.request('/api/forge/voice/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: new ReadableStream<Uint8Array>({}), duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    await vi.waitFor(() => { expect(loaded.ctx.get('voiceActivity')?.active()).toBe(true) })
    const busy: unknown = await (await loaded.request('/api/qianshou/compute/supply')).json()
    // The reason is the measured activity itself, not HOST_ACTIVITY_UNKNOWN: the producer exists and says "in use".
    expect(busy).toMatchObject({ activity: { foregroundTaskActive: false, voiceActive: true },
      eligibility: { state: 'blocked', reasons: ['FOREGROUND_PRIORITY'] },
      advertisingState: 'withdrawn', advertisedCapabilityIds: [] })
    controller.abort()
    expect((await pending).status).toBe(499)
    const idle: unknown = await (await loaded.request('/api/qianshou/compute/supply')).json()
    expect(idle).toMatchObject({ activity: { voiceActive: false }, eligibility: { state: 'ready', reasons: [] },
      advertisingState: 'advertising', advertisedCapabilityIds: ['node'] })
    // The endpoint saw, in order: the policy's mandatory withdrawal, the capability publication of the ready
    // snapshot, the withdrawal that the in-flight voice request forced, and the publication once it ended. The
    // published version is the one the probe parsed out of the same executable it ran, so the offer is exact.
    const offer = { id: 'node', kind: 'tool', name: 'Node.js', version: process.versions.node }
    expect(fixture.requests.map(request => request.body)).toEqual([
      { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [] },
      { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [offer] },
      { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [] },
      { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [offer] },
    ])
  })

  it('keeps a profile without a declared endpoint honest about having no channel', async () => {
    const root = await temporaryRoot()
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json') })
    const response = await loaded.request('/api/qianshou/compute/supply')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ advertisingState: 'not-connected', advertisedCapabilityIds: [],
      eligibility: { state: 'disabled' } })
  })

  it('reads real HTTP catalogue data and persists only a local draft across profile restarts', async () => {
    const core = await coreFixture(catalogue)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    const token = 'fixture-token-not-a-real-credential'
    vi.stubEnv(tokenEnv, token)
    const config = { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv }
    const loaded = await loadComposition(root, config)
    const status: unknown = await (await loaded.request('/api/qianshou/compute/status')).json()
    expect(status).toMatchObject({ configured: true, capabilities: { workloadRead: true, quoting: false, submission: true } })
    const capabilities = await loaded.request('/api/qianshou/compute/capabilities')
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toEqual([
      { id: 'image.batch', name: 'image.batch', description: '批量图片处理', delivery: 'remote', available: true },
    ])
    const response = await loaded.request('/api/qianshou/compute/plans', post({
      ...planRequest,
      quote: { id: 'forged-quote', amountMinor: 1 },
      status: 'completed',
      approved: true,
    }))
    expect(response.status).toBe(201)
    const draft = await response.json() as Record<string, unknown>
    expect(draft).toMatchObject({ status: 'draft', quote: null, authorization: 'pending', request: planRequest })
    expect(draft.id).toEqual(expect.stringMatching(/^plan_/u))
    expect(draft.approved).toBeUndefined()
    expect(JSON.stringify(draft)).not.toContain(token)
    const confirmed = await loaded.request('/api/qianshou/compute/plans/confirm', post({
      id: draft.id, decision: 'approved', quote: { id: 'forged-quote' }, approved: true, submit: true,
    }))
    expect(confirmed.status).toBe(200)
    const confirmedDraft = await confirmed.json() as Record<string, unknown>
    expect(confirmedDraft).toMatchObject({ id: draft.id, status: 'draft', quote: null, authorization: 'approved', request: planRequest })
    expect(confirmedDraft.approved).toBeUndefined()
    expect((await loaded.request('/api/qianshou/compute/submit', post({ planId: draft.id, approved: true }))).status).toBe(404)
    expect((await loaded.request('/api/qianshou/compute/plans/confirm', post({
      id: 'plan_00000000-0000-0000-0000-000000000000', decision: 'approved',
    }))).status).toBe(404)
    await loaded.ctx.fiber.dispose()
    expect(loaded.routes.size).toBe(0)
    const restarted = await loadComposition(root, config)
    expect(await (await restarted.request('/api/qianshou/compute/plans')).json()).toEqual([confirmedDraft])
    expect(core.requests.length).toBeGreaterThan(0)
    expect(core.requests.every(request => request.method === 'GET')).toBe(true)
    expect(core.requests.every(request => request.authorization === `Bearer ${token}`)).toBe(true)
    expect(core.requests.every(request => request.path === '/api/v8/developer/task-types')).toBe(true)
  })

  it('treats stored drafts without authorization as pending and confirms them without a core', async () => {
    const root = await temporaryRoot()
    const statePath = join(root, 'plans.json')
    const legacyId = 'plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const secondId = 'plan_bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    await writeFile(statePath, JSON.stringify({
      version: 1,
      plans: [{
        id: legacyId, request: planRequest, status: 'draft', createdAt: '2026-09-16T12:00:00.000Z', quote: null,
        reason: '方案草稿已保存，尚未报价、下单或扣费；节点数量是请求上限，不代表资源已预留。',
      }, {
        id: secondId, request: planRequest, status: 'draft', createdAt: '2026-09-16T12:01:00.000Z', quote: null,
        reason: '方案草稿已保存，尚未报价、下单或扣费；节点数量是请求上限，不代表资源已预留。',
      }],
    }))
    const loaded = await loadComposition(root, { statePath })
    const listed = await (await loaded.request('/api/qianshou/compute/plans')).json() as Record<string, unknown>[]
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ id: legacyId, authorization: 'pending' })
    expect(listed[1]).toMatchObject({ id: secondId, authorization: 'pending' })
    const declined = await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: legacyId, decision: 'declined' }))
    expect(declined.status).toBe(200)
    expect(await declined.json()).toMatchObject({ id: legacyId, authorization: 'declined', status: 'draft', quote: null })
    expect((await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: legacyId, decision: 'declined' }))).status).toBe(200)
    expect((await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: legacyId, decision: 'submit' }))).status).toBe(400)
    await expect(loaded.ctx.computeCore.confirmPlan({ id: legacyId, decision: 'approved' }, AbortSignal.abort())).rejects.toThrow()
    const service = loaded.ctx.computeCore
    await loaded.ctx.fiber.dispose()
    await expect(service.confirmPlan({ id: legacyId, decision: 'approved' })).rejects.toThrow('COMPUTE_CLOSED')
    const restarted = await loadComposition(root, { statePath })
    expect(await (await restarted.request('/api/qianshou/compute/plans')).json()).toMatchObject([
      { id: legacyId, authorization: 'declined' },
      { id: secondId, authorization: 'pending' },
    ])
  })

  it('rejects a stored authorization that is not a local owner decision', async () => {
    const root = await temporaryRoot()
    const statePath = join(root, 'plans.json')
    await writeFile(statePath, JSON.stringify({
      version: 1,
      plans: [{
        id: 'plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', request: planRequest, status: 'draft',
        createdAt: '2026-09-16T12:00:00.000Z', quote: null, authorization: 'yes',
        reason: '方案草稿已保存，尚未报价、下单或扣费；节点数量是请求上限，不代表资源已预留。',
      }],
    }))
    const loaded = await loadComposition(root, { statePath })
    const response = await loaded.request('/api/qianshou/compute/plans')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'COMPUTE_STORE_INVALID' } })
  })

  it('reads the catalogue with a logged-in account session and no environment token', async () => {
    const core = await coreFixture(catalogue)
    const root = await temporaryRoot()
    const sessionToken = 'session-access-token-not-a-real-credential'
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl }, undefined, {
      accountSession: {
        ensureAccessToken: async () => sessionToken,
        account: async () => ({ id: 7, username: 'fixture-user' }),
      },
    })
    const status: unknown = await (await loaded.request('/api/qianshou/compute/status')).json()
    expect(status).toMatchObject({ configured: true, capabilities: { workloadRead: true, quoting: false, submission: true } })
    const capabilities = await loaded.request('/api/qianshou/compute/capabilities')
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toEqual([
      { id: 'image.batch', name: 'image.batch', description: '批量图片处理', delivery: 'remote', available: true },
    ])
    expect(core.requests).toEqual([
      { method: 'GET', path: '/api/v8/developer/task-types', authorization: `Bearer ${sessionToken}` },
    ])
  })

  it('prefers the logged-in session token when an environment override is also set', async () => {
    const core = await coreFixture(catalogue)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'env-override-token-not-used')
    const sessionToken = 'session-wins-token-not-a-real-credential'
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv }, undefined, {
      accountSession: {
        ensureAccessToken: async () => sessionToken,
        account: async () => ({ id: 7, username: 'fixture-user' }),
      },
    })
    const capabilities = await loaded.request('/api/qianshou/compute/capabilities')
    expect(capabilities.status).toBe(200)
    expect(core.requests).toEqual([
      { method: 'GET', path: '/api/v8/developer/task-types', authorization: `Bearer ${sessionToken}` },
    ])
  })

  it('keeps the origin configured when the account session is present but signed out', async () => {
    const core = await coreFixture(catalogue)
    const root = await temporaryRoot()
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl }, undefined, {
      accountSession: {
        ensureAccessToken: async () => null,
        account: async () => null,
      },
    })
    const status: unknown = await (await loaded.request('/api/qianshou/compute/status')).json()
    expect(status).toMatchObject({ configured: true, capabilities: { workloadRead: true, quoting: false, submission: true } })
    const capabilities = await loaded.request('/api/qianshou/compute/capabilities')
    expect(capabilities.status).toBe(503)
    expect(await capabilities.json()).toMatchObject({ error: { code: 'CORE_CREDENTIALS_MISSING' } })
    expect(core.requests).toEqual([])
  })

  it('rejects an unadvertised capability without retaining a draft', async () => {
    const core = await coreFixture(catalogue)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    const result = await loaded.request('/api/qianshou/compute/plans', post({ ...planRequest, capabilityId: 'invented-capability' }))
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ error: { code: 'COMPUTE_CAPABILITY_UNAVAILABLE' } })
    expect(await (await loaded.request('/api/qianshou/compute/plans')).json()).toEqual([])
    expect(core.requests).toHaveLength(1)
    expect(core.requests[0]?.method).toBe('GET')
  })

  it('publishes an approved draft through developer/tasks and never posts /api/v8/workloads', async () => {
    const core = await coreFixture(catalogueWithPublish)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    const token = 'fixture-token-not-a-real-credential'
    vi.stubEnv(tokenEnv, token)
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    const created = await loaded.request('/api/qianshou/compute/plans', post(planRequest))
    const draft = await created.json() as { id: string }
    expect((await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id }))).status).toBe(409)
    await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: draft.id, decision: 'approved' }))
    const published = await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id, quote: { id: 'forged' } }))
    expect(published.status).toBe(200)
    expect(await published.json()).toMatchObject({
      id: draft.id, authorization: 'approved', workloadId: 'workload-fixture-1', quote: null,
    })
    const replay = await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id }))
    expect(replay.status).toBe(200)
    expect(core.requests.filter(item => item.method === 'POST')).toEqual([
      expect.objectContaining({
        method: 'POST', path: '/api/v8/developer/tasks', authorization: `Bearer ${token}`,
        body: expect.objectContaining({
          task_type: 'image.batch', input_kind: 'inline', inline_input: planRequest.goal,
          budget: '0.50', max_shards: 2, auto_shard: true, input_ref: '', input_refs: [],
          callback_url: '', callback_secret: '',
        }),
      }),
    ])
    expect(core.requests.some(item => item.path.startsWith('/api/v8/workloads') && item.method === 'POST')).toBe(false)
    const idempotencyKey = (core.requests.find(item => item.method === 'POST')?.body as { idempotency_key: string }).idempotency_key
    expect(idempotencyKey).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('does not auto-retry an unknown developer-task POST', async () => {
    let posts = 0
    const core = await coreFixture((request, response, body) => {
      if (request.method === 'POST' && request.url === '/api/v8/developer/tasks') {
        posts += 1
        return
      }
      catalogueWithPublish(request, response, body)
    })
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, {
      statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv, timeoutMs: 1000,
    })
    const draft = await (await loaded.request('/api/qianshou/compute/plans', post(planRequest))).json() as { id: string }
    await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: draft.id, decision: 'approved' }))
    const first = await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id }))
    expect(first.status).toBe(504)
    expect(await first.json()).toMatchObject({ error: { code: 'CORE_REQUEST_TIMEOUT' } })
    const second = await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id }))
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ error: { code: 'COMPUTE_SUBMISSION_UNKNOWN' } })
    expect(posts).toBe(1)
  })

  it('removes only its routes when the Loader disposes the compute entry', async () => {
    const root = await temporaryRoot()
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json') })
    expect(loaded.routes.size).toBeGreaterThan(0)
    const entry = [...loaded.ctx.loader.entries()].find(item => item.options.name === PLUGIN)
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect(loaded.routes.size).toBe(0)
    expect(loaded.ctx.get('connection')).toBeDefined()
    expect((await loaded.request('/api/qianshou/compute/status')).status).toBe(404)
  })
})
