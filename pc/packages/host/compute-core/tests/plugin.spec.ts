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
import * as QianshouVoice from '@deepseek-ai/dsh-host-qianshou-voice'
import * as Sessions from '@deepseek-ai/dsh-session'
import { ttsFixture } from '../../qianshou-voice/tests/support.ts'
import * as ComputeCore from '../src/index.ts'
import { ComputeCapabilityId, ComputeTaskId } from '../src/protocol.ts'
import { SUPPLY_ADVERTISEMENT_VERSION } from '../src/supply/advertisement.ts'

const PLUGIN = '@deepseek-ai/dsh-compute-core'
const CONNECTION_FIXTURE = 'qianshou-compute-test-connection'
const VOICE_PLUGIN = '@deepseek-ai/dsh-host-qianshou-voice'
const SESSIONS_PLUGIN = '@deepseek-ai/dsh-session'
const AGENTS_FIXTURE = 'qianshou-compute-test-agents'
const ACCOUNT_FIXTURE = 'qianshou-compute-test-account'
const SUPPLY_OWNER_FIXTURE = 'qianshou-compute-test-supply-owner'
const tempRoots: string[] = []
const contexts: Context[] = []
const voiceSessionDetachers: Array<() => void> = []
const servers: Server[] = []

afterEach(async () => {
  for (const detach of voiceSessionDetachers.splice(0).reverse()) detach()
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
  voicePath(path: string): string
}

/** Real plugins and fixtures this composition may mount, on top of the authenticated carrier. */
interface CompositionOptions {
  /** Mount the real local voice plugin so voice activity has a producer instead of staying unknown. */
  voice?: boolean
  /** Accessible local ASR files for a request held in the real upload route. */
  voiceAssets?: { binaryPath: string; modelPath: string }
  /** Test-only local TTS assets; the request can be held in its real upload route. */
  ttsAssets?: { ttsPythonPath: string; ttsWorkerPath: string; ttsModelPath: string }
  /** Mount a foreground-task registry with no running agent, so the task count is known instead of unknown. */
  agents?: boolean
  /** Optional logged-in compute-account session used instead of `tokenEnv`. */
  accountSession?: {
    ensureAccessToken: () => Promise<string | null>
    account: () => unknown
  }
  /** Explicit owner and installed node for account-bound supply tests. */
  supplyOwner?: boolean
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
    ...(options.supplyOwner ? [`- name: '${SUPPLY_OWNER_FIXTURE}'`] : []),
    ...(options.voice ? [`- name: '${SESSIONS_PLUGIN}'`] : []),
    `- name: '${PLUGIN}'`,
    `  config: ${JSON.stringify(config)}`,
    ...(options.voice ? [`- name: '${VOICE_PLUGIN}'`, `  config: ${JSON.stringify({ uploadTimeoutMs: 30_000, ...options.voiceAssets, ...options.ttsAssets })}`] : []),
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
    if (options.supplyOwner) modules.set(SUPPLY_OWNER_FIXTURE, {
      name: SUPPLY_OWNER_FIXTURE,
      apply(ownerCtx: Context) {
        ownerCtx.provide('accountSession', { ensureAccessToken: async () => 'fixture-token' } as never)
        ownerCtx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: '7' } }) } as never)
        ownerCtx.provide('nodeContributor', { nodeIdentity: () => 'node-mac-fixture' } as never)
      },
    })
    if (options.voice) {
      modules.set(SESSIONS_PLUGIN, Sessions)
      modules.set(VOICE_PLUGIN, QianshouVoice)
    }
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
  const voiceSession = options.voice ? ctx.sessions.prepare(Sessions.SessionId('compute-voice-test'), { meta: { cwd: root } }) : null
  if (voiceSession !== null) {
    voiceSessionDetachers.push(ctx.sessions.enter(voiceSession))
    ctx.sessions.announce(voiceSession)
  }
  return {
    ctx,
    routes,
    voicePath(path) {
      if (voiceSession === null) throw new Error('voice session is not mounted')
      const url = new URL(`http://qianshou-host${path}`)
      url.searchParams.set('sessionId', voiceSession.id)
      url.searchParams.set('workspaceRoot', root)
      return `${url.pathname}${url.search}`
    },
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
  capabilityId: 'media.transcode',
  goal: '清理这批图片并保持原图尺寸。',
  budgetMinor: 50,
  currency: 'CNY',
  maxNodes: 2,
}

function catalogue(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/api/v8/capabilities') {
    response.end(JSON.stringify({ registry_version: 'fixture-v1', capabilities: [
      { capability: 'media.transcode', implementations: [], legacy_task_types: ['video_compress'] },
    ] }))
    return
  }
  if (request.url === '/api/v8/auth/me') {
    response.end(JSON.stringify({ ok: true, account: { id: 7, username: 'fixture-user', role: 'user', status: 'active' } }))
    return
  }
  if (request.url === '/api/v8/developer/task-types') {
    response.end(JSON.stringify({
      ok: true,
      items: [{
        task_type: 'video_compress', description: '批量图片处理',
        accepted_input_kinds: ['inline'], default_input_kind: 'inline', required_params: [],
      }],
      total: 1,
    }))
    return
  }
  if (request.url === '/api/v8/workloads/workload-fixture-1') {
    response.end(JSON.stringify({ id: 'workload-fixture-1', status: 'DONE', progress: 1, result: { private: 'fixture-result' } }))
    return
  }
  if (request.url === '/api/v8/developer/tasks/workload-fixture-1/result') {
    response.end(JSON.stringify({
      ok: true, id: 'workload-fixture-1', status: 'DONE', result: { inline_output: 'fixture-inline\n' },
    }))
    return
  }
  if (request.url === '/api/v8/developer/tasks/workload-fixture-1/download'
    || request.url === '/api/v8/workloads/workload-fixture-1/result') {
    response.writeHead(500).end(JSON.stringify({ error: 'result-download-must-not-be-called' }))
    return
  }
  response.writeHead(404).end(JSON.stringify({ error: 'unexpected fixture request' }))
}

/**
 * 取消链路的平台替身：三种状态的 workload + 一份账本。
 *
 * 形态照 AT-03 的实测原文：DELETE 在任务还活着时回 `status: "CANCELLED"`，
 * 终态任务回 400；账本条目带 `type`/`amount`/`workload_id`/`note`/`created_at`，
 * 而余额投影会滞后——所以退款事实只能从账本读。
 */
function cancellation(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('Content-Type', 'application/json')
  const path = request.url ?? ''
  if (request.method === 'GET' && path === '/api/v8/workloads/workload-live') {
    response.end(JSON.stringify({ id: 'workload-live', status: 'RUNNING', progress: 0, result: null }))
    return
  }
  if (request.method === 'DELETE' && path === '/api/v8/workloads/workload-live') {
    response.end(JSON.stringify({ id: 'workload-live', status: 'CANCELLED', error: '已取消 (user_cancel)' }))
    return
  }
  if (request.method === 'GET' && path === '/api/v8/workloads/workload-cancelled') {
    response.end(JSON.stringify({ id: 'workload-cancelled', status: 'CANCELLED', progress: 0, result: null }))
    return
  }
  if (request.method === 'GET' && path === '/api/v8/workloads/workload-done') {
    response.end(JSON.stringify({ id: 'workload-done', status: 'DONE', progress: 1, result: { any: 'payload' } }))
    return
  }
  if (request.method === 'DELETE' && path.startsWith('/api/v8/workloads/')) {
    response.writeHead(400).end(JSON.stringify({ ok: false, code: 'VALIDATION_ERROR', message: '任务已 DONE · 无法取消' }))
    return
  }
  if (request.method === 'GET' && path.startsWith('/api/v8/economy/ledger')) {
    response.end(JSON.stringify({ ok: true, items: [
      { id: 'ledger-refund', type: 'REFUND', amount: '0.0100', currency: 'CNY', workload_id: 'workload-live', shard_id: null,
        note: '任务退款 (workload-live · user_cancel)', created_at: '2026-09-17T06:00:00+00:00' },
      { id: 'ledger-hold', type: 'ESCROW_HOLD', amount: '-0.0100', currency: 'CNY', workload_id: 'workload-live', shard_id: null,
        note: '提交任务: 词频统计', created_at: '2026-09-17T05:59:00+00:00' },
      { id: 'ledger-other', type: 'ESCROW_HOLD', amount: '-0.0100', currency: 'CNY', workload_id: 'workload-other', shard_id: null,
        note: '别的任务', created_at: '2026-09-17T05:58:00+00:00' },
    ] }))
    return
  }
  response.writeHead(404).end(JSON.stringify({ error: 'unexpected fixture request' }))
}

function catalogueWithPublish(request: IncomingMessage, response: ServerResponse, body: unknown): void {
  if (request.method === 'POST' && request.url === '/api/v8/developer/tasks/estimate') {
    const task = body as {
      task_type: string
      input_kind: string
      inline_input: string
      timeout_s: number
      max_shards: number
      auto_shard: boolean
      idempotency_key: string
      budget: string
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      ok: true, task_type: task.task_type, input_kind: task.input_kind, currency: 'CNY',
      requested_budget: task.budget, estimated_total: '0.75',
      recommended_budget: '0.75', quote_token: 'fixture-ticket-private',
      quote_expires_at: Math.floor(Date.now() / 1000) + 300,
      balance_enough: true, price_basis: 'fixture-price', settings_version: 'fixture-v1',
      billing_mode: 'server_price',
    }))
    return
  }
  if (request.method === 'POST' && request.url === '/api/v8/developer/tasks') {
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      ok: true, id: 'workload-fixture-1', task_id: 'workload-fixture-1', workload_id: 'workload-fixture-1',
      name: 'media.transcode', task_type: 'video_compress', status: 'CREATED', progress: 0,
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
  it.each([false, true])('loads the private image trial routes with explicit enablement %s', async (enabled) => {
    const root = await temporaryRoot()
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'),
      ...(enabled ? { imageTrial: { gatewayOrigin: 'http://127.0.0.1:18991', tokenEnv: 'QIANSHOU_IMAGE_TEST_KEY' } } : {}) })
    const prefix = '/api/qianshou/compute/image-trial/'
    const response = await loaded.request(prefix + 'status')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled, sizes: ['square', 'landscape', 'portrait'],
      steps: 8, billing: 'research-no-charge' })
    expect(await readdir(root)).not.toContain('plans.json.image-trial')
    if (!enabled) {
      const refused = await loaded.request(prefix + 'jobs', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}' })
      expect(refused.status).toBe(503)
      expect(await refused.json()).toMatchObject({ error: { code: 'IMAGE_TRIAL_DISABLED' } })
    }
    await loaded.ctx.fiber.dispose()
    expect([...loaded.routes.keys()].some(path => path.startsWith(prefix))).toBe(false)
  })

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
        tools: [{ id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] }] } },
    undefined, { supplyOwner: true })
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
    undefined, { voice: true, agents: true, supplyOwner: true })
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

  it('withdraws during a session-admitted ASR upload without a supply read and republishes after cancellation', async () => {
    const fixture = await advertisementFixture(200, ['node'])
    const root = await temporaryRoot()
    const modelPath = join(root, 'voice-model.bin')
    await writeFile(modelPath, 'test-only accessible model marker')
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), tokenEnv,
      supply: { advertisementEndpoint: fixture.endpoint,
        tools: [{ id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] }] } },
    undefined, { voice: true, voiceAssets: { binaryPath: process.execPath, modelPath }, agents: true, supplyOwner: true })
    const policy = await loaded.request('/api/qianshou/compute/supply/policy', post({ mode: 'allowed', maxConcurrency: 1,
      minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }))
    expect(await policy.json()).toMatchObject({ eligibility: { state: 'ready' }, advertisingState: 'advertising' })
    const supplyReads = vi.spyOn(loaded.ctx.computeCore, 'querySupplySnapshot')
    const beforeVoice = fixture.requests.length
    // The real Session admission and production ASR route hold the upload open. This fixture invokes the registered
    // Connection route directly; it does not exercise the outer HTTP authentication middleware.
    const controller = new AbortController()
    const pending = loaded.request(loaded.voicePath('/api/qianshou/voice/transcribe'), {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, signal: controller.signal,
      body: new ReadableStream<Uint8Array>({}), duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    await vi.waitFor(() => { expect(loaded.ctx.get('voiceActivity')?.active()).toBe(true) })
    await vi.waitFor(() => {
      expect(fixture.requests.slice(beforeVoice).map(request => offeredIds(request.body))).toContainEqual([])
    })
    expect(supplyReads).not.toHaveBeenCalled()
    controller.abort()
    expect((await pending).status).toBe(499)
    await vi.waitFor(() => { expect(offeredIds(fixture.requests.at(-1)?.body)).toEqual(['node']) }, { timeout: 5000 })
    expect(supplyReads).not.toHaveBeenCalled()
    // The endpoint saw an empty replacement while the ASR body was pending, then a fresh offer after release.
    const offer = { id: 'node', kind: 'tool', name: 'Node.js', version: process.versions.node }
    expect(fixture.requests.slice(beforeVoice).map(request => request.body)).toEqual([
      { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [] },
      { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [offer] },
    ])
  }, 30_000)

  it('withdraws during a session-admitted TTS upload without a supply read and restores after cancellation', async () => {
    const fixture = await advertisementFixture(200, ['node'])
    const root = await temporaryRoot()
    const tts = await ttsFixture()
    tempRoots.push(tts.root)
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), tokenEnv,
      supply: { advertisementEndpoint: fixture.endpoint,
        tools: [{ id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] }] } },
    undefined, { voice: true, agents: true, supplyOwner: true, ttsAssets: {
      ttsPythonPath: tts.assets.python, ttsWorkerPath: tts.assets.worker, ttsModelPath: tts.assets.model,
    } })
    const policy = await loaded.request('/api/qianshou/compute/supply/policy', post({ mode: 'allowed', maxConcurrency: 1,
      minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }))
    expect(await policy.json()).toMatchObject({ eligibility: { state: 'ready' }, advertisedCapabilityIds: ['node'] })
    const supplyReads = vi.spyOn(loaded.ctx.computeCore, 'querySupplySnapshot')
    const beforeVoice = fixture.requests.length
    const controller = new AbortController()
    const pending = loaded.request(loaded.voicePath('/api/qianshou/voice/tts/synthesize'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: new ReadableStream<Uint8Array>({}), duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    await vi.waitFor(() => { expect(loaded.ctx.get('voiceActivity')?.active()).toBe(true) })
    await vi.waitFor(() => {
      expect(fixture.requests.slice(beforeVoice).map(request => offeredIds(request.body))).toContainEqual([])
    })
    expect(supplyReads).not.toHaveBeenCalled()
    controller.abort()
    expect((await pending).status).toBe(499)
    await vi.waitFor(() => { expect(offeredIds(fixture.requests.at(-1)?.body)).toEqual(['node']) }, { timeout: 5000 })
    expect(fixture.requests.slice(beforeVoice).map(request => offeredIds(request.body))).toEqual([[], ['node']])
    expect(supplyReads).not.toHaveBeenCalled()
    expect(await tts.events()).toEqual([])
  }, 30_000)

  it('withdraws an offer when the voice producer unloads and activity becomes unknown', async () => {
    const fixture = await advertisementFixture(200, ['node'])
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), tokenEnv,
      supply: { advertisementEndpoint: fixture.endpoint,
        tools: [{ id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] }] } },
    undefined, { voice: true, agents: true, supplyOwner: true })
    const policy = await loaded.request('/api/qianshou/compute/supply/policy', post({ mode: 'allowed', maxConcurrency: 1,
      minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }))
    expect(await policy.json()).toMatchObject({ advertisedCapabilityIds: ['node'] })
    const beforeUnload = fixture.requests.length
    const voiceEntry = [...loaded.ctx.loader.entries()].find(item => item.options.name === VOICE_PLUGIN)
    expect(voiceEntry?.fiber).toBeDefined()
    await voiceEntry!.fiber!.dispose()
    expect(loaded.ctx.get('voiceActivity')).toBeUndefined()
    await vi.waitFor(() => {
      expect(fixture.requests.slice(beforeUnload).map(request => offeredIds(request.body))).toContainEqual([])
    }, { timeout: 5000 })
    expect(await (await loaded.request('/api/qianshou/compute/supply')).json()).toMatchObject({
      activity: { voiceActive: null }, eligibility: { state: 'blocked', reasons: ['HOST_ACTIVITY_UNKNOWN'] },
      advertisedCapabilityIds: [],
    })
  }, 30_000)

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
    expect(status).toMatchObject({ configured: true, capabilities: { workloadRead: true, quoting: true, submission: true } })
    const capabilities = await loaded.request('/api/qianshou/compute/capabilities')
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toEqual([
      { id: 'media.transcode', name: 'media.transcode', description: '批量图片处理', delivery: 'remote', available: true },
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
    expect(loaded.ctx.computeCore.coreOrigin()).toBe(new URL(core.baseUrl).origin)
    const confirmed = await loaded.request('/api/qianshou/compute/plans/confirm', post({
      id: draft.id, decision: 'approved', quote: { id: 'forged-quote' }, approved: true, submit: true,
    }))
    expect(confirmed.status).toBe(409)
    expect(await confirmed.json()).toMatchObject({ error: { code: 'COMPUTE_QUOTE_REQUIRED' } })
    expect((await loaded.request('/api/qianshou/compute/submit', post({ planId: draft.id, approved: true }))).status).toBe(404)
    expect((await loaded.request('/api/qianshou/compute/plans/confirm', post({
      id: 'plan_00000000-0000-0000-0000-000000000000', decision: 'approved',
    }))).status).toBe(404)
    await loaded.ctx.fiber.dispose()
    expect(loaded.routes.size).toBe(0)
    const restarted = await loadComposition(root, config)
    expect(await (await restarted.request('/api/qianshou/compute/plans')).json()).toEqual([draft])
    expect(core.requests.length).toBeGreaterThan(0)
    expect(core.requests.every(request => request.method === 'GET')).toBe(true)
    expect(core.requests.every(request => request.authorization === `Bearer ${token}`)).toBe(true)
    expect(core.requests.every(request => ['/api/v8/developer/task-types', '/api/v8/capabilities'].includes(request.path))).toBe(true)
  })

  it('reads the Edge owner identity from auth/me without inventing an account id', async () => {
    const core = await coreFixture(catalogue)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    expect(loaded.ctx.computeCore.coreOrigin()).toBe(new URL(core.baseUrl).origin)
    expect(await loaded.ctx.computeCore.ownerAccountId()).toBe(7)
    expect(core.requests.map(request => request.path)).toEqual(['/api/v8/auth/me'])
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
    const reapprove = await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: legacyId, decision: 'approved' }))
    expect(reapprove.status).toBe(409)
    expect(await reapprove.json()).toMatchObject({ error: { code: 'COMPUTE_PLAN_DECLINED' } })
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

  it('preserves a persisted platform task type when listing drafts', async () => {
    const root = await temporaryRoot()
    const statePath = join(root, 'plans.json')
    const legacyId = 'plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeFile(statePath, JSON.stringify({
      version: 1,
      plans: [{
        id: legacyId, request: { ...planRequest, capabilityId: 'video_compress' }, status: 'draft',
        createdAt: '2026-09-16T12:00:00.000Z', quote: null,
        reason: '方案草稿已保存，尚未报价、下单或扣费；节点数量是请求上限，不代表资源已预留。',
      }],
    }))
    const loaded = await loadComposition(root, { statePath })
    expect(await (await loaded.request('/api/qianshou/compute/plans')).json()).toMatchObject([
      { id: legacyId, request: { ...planRequest, capabilityId: 'video_compress' } },
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
    expect(status).toMatchObject({ configured: true, capabilities: { workloadRead: true, quoting: true, submission: true } })
    const capabilities = await loaded.request('/api/qianshou/compute/capabilities')
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toEqual([
      { id: 'media.transcode', name: 'media.transcode', description: '批量图片处理', delivery: 'remote', available: true },
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
    expect(status).toMatchObject({ configured: true, capabilities: { workloadRead: true, quoting: true, submission: true } })
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
    expect(core.requests[0]?.path).toBe('/api/v8/developer/task-types')
    expect(core.requests[0]?.method).toBe('GET')
  })

  it('admits the exact catalogue task type without a desktop mapping release', async () => {
    const core = await coreFixture(catalogue)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    const created = await loaded.request('/api/qianshou/compute/plans', post({ ...planRequest, capabilityId: 'video_compress' }))
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      status: 'draft',
      request: { ...planRequest, capabilityId: 'video_compress' },
    })
  })

  it('passes a verified media result from Shanghai through the authenticated Host result route', async () => {
    const asset = 'c'.repeat(64)
    const mediaRef = `qianshou-media://task/workload-fixture-1/${asset}.mp4`
    const core = await coreFixture((request, response, body) => {
      if (request.url === '/api/v8/developer/tasks/workload-fixture-1/result') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: true, id: 'workload-fixture-1', status: 'DONE',
          output_ref: mediaRef, result: { media_ref: mediaRef } }))
        return
      }
      if (request.url === '/api/v8/workloads/workload-fixture-1') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 'workload-fixture-1', owner_id: 7, status: 'DONE',
          spec: { task_type: 'video_compress', input_kind: 'inline', input_refs: [],
            verification_policy: 'artifact', requirements: {} }, result: { output_ref: mediaRef } }))
        return
      }
      catalogue(request, response)
      void body
    })
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    const result = await loaded.request('/api/qianshou/compute/workload/result?id=workload-fixture-1')
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ id: 'workload-fixture-1', status: 'DONE',
      inlineOutput: null, artifactRef: mediaRef })
    expect(core.requests.map(item => item.path)).toEqual([
      '/api/v8/developer/tasks/workload-fixture-1/result', '/api/v8/workloads/workload-fixture-1', '/api/v8/auth/me',
    ])
  })

  it('keeps buyer acceptance on the authenticated Host route and rejects an invented decision', async () => {
    const held = { workload_id: 'workload-fixture-1', status: 'pending_buyer',
      workload_status: 'QUARANTINED', currency: 'CNY', held_amount: '0.50',
      inline_output: { answer: '待确认' }, content_sha256: 'a'.repeat(64),
      output_kind: 'inline_json', shard_id: 'shard-fixture-1' }
    const core = await coreFixture((request, response) => {
      if (request.url === '/api/v8/workloads/workload-fixture-1/acceptance') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(request.method === 'POST' ? { ...held, status: 'accepted' } : held))
        return
      }
      catalogue(request, response)
    })
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    const read = await loaded.request('/api/qianshou/compute/workload/acceptance?id=workload-fixture-1')
    expect(await read.json()).toMatchObject({ status: 'pending_buyer', currency: 'CNY', heldAmount: '0.50' })
    const bad = await loaded.request('/api/qianshou/compute/workload/acceptance', post({
      id: 'workload-fixture-1', decision: 'force_settle', idempotencyKey: 'bad',
    }))
    expect(bad.status).toBe(400)
    const confirmed = await loaded.request('/api/qianshou/compute/workload/acceptance', post({
      id: 'workload-fixture-1', decision: 'accept',
      idempotencyKey: 'f8e42af1-e7a0-4c60-a53d-aa8d04def69b',
    }))
    expect(await confirmed.json()).toMatchObject({ status: 'accepted', workloadStatus: 'QUARANTINED' })
    expect(core.requests).toHaveLength(2)
    expect(core.requests.every(item => item.authorization === 'Bearer fixture-token')).toBe(true)
  })

  it('requires a private Host quote confirmation before publishing at the server price', async () => {
    const core = await coreFixture(catalogueWithPublish)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    const token = 'fixture-token-not-a-real-credential'
    vi.stubEnv(tokenEnv, token)
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    const created = await loaded.request('/api/qianshou/compute/plans', post(planRequest))
    const draft = await created.json() as { id: string }
    expect((await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id }))).status).toBe(409)
    const unquoted = await loaded.request('/api/qianshou/compute/plans/confirm-quoted', post({
      id: draft.id, quoteId: 'a'.repeat(32), amount: '0.75',
    }))
    expect(unquoted.status).toBe(409)
    expect(core.requests.some(item => item.path === '/api/v8/developer/tasks' && item.method === 'POST')).toBe(false)
    await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: draft.id, decision: 'approved' }))
    const direct = await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id, quote: { id: 'forged' } }))
    expect(direct.status).toBe(409)
    expect(await direct.json()).toMatchObject({ error: { code: 'COMPUTE_QUOTE_CONFIRMATION_REQUIRED' } })
    const quoteResponse = await loaded.request('/api/qianshou/compute/plans/quote', post({ id: draft.id }))
    expect(quoteResponse.status).toBe(200)
    const quoteText = await quoteResponse.text()
    expect(quoteText).not.toContain('fixture-ticket-private')
    expect(quoteText).not.toContain('quote_token')
    const quote = JSON.parse(quoteText) as { quoteId: string; recommendedBudget: string; requestedBudget: string; priceBasis: string }
    expect(quote).toMatchObject({ recommendedBudget: '0.75', requestedBudget: '0.50', priceBasis: 'fixture-price' })
    const badAmount = await loaded.request('/api/qianshou/compute/plans/confirm-quoted', post({
      id: draft.id, quoteId: quote.quoteId, amount: '0.50',
    }))
    expect(badAmount.status).toBe(409)
    expect(await badAmount.json()).toMatchObject({ error: { code: 'COMPUTE_QUOTE_CONFIRMATION_INVALID' } })
    const publishedResponse = await loaded.request('/api/qianshou/compute/plans/confirm-quoted', post({
      id: draft.id, quoteId: quote.quoteId, amount: '0.75',
    }))
    expect(publishedResponse.status).toBe(200)
    const published = await publishedResponse.json() as Record<string, unknown>
    expect(published).toMatchObject({
      id: draft.id, authorization: 'approved', workloadId: 'workload-fixture-1', quote: null,
    })
    const replayConfirm = await loaded.request('/api/qianshou/compute/plans/confirm-quoted', post({
      id: draft.id, quoteId: quote.quoteId, amount: '0.75',
    }))
    expect(replayConfirm.status).toBe(409)
    const replay = await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id }))
    expect(replay.status).toBe(200)
    expect(core.requests.filter(item => item.path === '/api/v8/developer/tasks')).toEqual([
      expect.objectContaining({
        method: 'POST', path: '/api/v8/developer/tasks', authorization: `Bearer ${token}`,
        body: expect.objectContaining({
          task_type: 'video_compress', input_kind: 'inline', inline_input: planRequest.goal,
          budget: '0.75', quote_token: 'fixture-ticket-private', max_shards: 2, auto_shard: true, input_ref: '', input_refs: [],
          callback_url: '', callback_secret: '',
        }),
      }),
    ])
    expect(core.requests.some(item => item.path.startsWith('/api/v8/workloads') && item.method === 'POST')).toBe(false)
    const estimateRequest = core.requests.find(item => item.path === '/api/v8/developer/tasks/estimate')!
    const submittedRequest = core.requests.find(item => item.path === '/api/v8/developer/tasks')!
    expect((estimateRequest.body as { idempotency_key: string }).idempotency_key)
      .toBe((submittedRequest.body as { idempotency_key: string }).idempotency_key)
    const idempotencyKey = (submittedRequest.body as { idempotency_key: string }).idempotency_key
    expect(idempotencyKey).toMatch(/^[a-f0-9]{64}$/u)
    const estimates = core.requests.filter(item => item.path === '/api/v8/developer/tasks/estimate')
    expect(estimates).toHaveLength(1)
    expect(estimates[0]?.body).toEqual({
      ...(core.requests.find(item => item.path === '/api/v8/developer/tasks')?.body as Record<string, unknown>),
      budget: '0.50', quote_token: null,
    })
    const summary = await loaded.request('/api/qianshou/compute/workload?id=workload-fixture-1')
    expect(summary.status).toBe(200)
    expect(await summary.json()).toEqual({
      id: 'workload-fixture-1', status: 'DONE', progress: 1, resultAvailable: true,
    })
    const result = await loaded.request('/api/qianshou/compute/workload/result?id=workload-fixture-1')
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      id: 'workload-fixture-1', status: 'DONE', inlineOutput: 'fixture-inline\n', artifactRef: null,
    })
    expect(core.requests.some(item => item.path.includes('/download'))).toBe(false)
    expect(core.requests.some(item => item.path === '/api/v8/workloads/workload-fixture-1/result')).toBe(false)
  })

  it('quotes and submits the same reviewed scalar params without a task-specific desktop workflow', async () => {
    const paramsSchema = { type: 'object', required: ['keyword'], additionalProperties: false,
      properties: { keyword: { type: 'string', minLength: 1, maxLength: 80 },
        top_n: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } } }
    const core = await coreFixture((request, response, body) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/api/v8/developer/task-types') {
        response.end(JSON.stringify({ ok: true, items: [{
          task_type: 'word_count', accepted_input_kinds: ['inline', 'single_file'],
          default_input_kind: 'single_file', required_params: ['keyword'],
          form_schema_version: 'qianshou.task-input-form.v1', form_ready: true,
          params_schema: paramsSchema, input_schema: { oneOf: [{ type: 'object',
            properties: { input_kind: { const: 'inline' }, params: paramsSchema },
            required: ['input_kind', 'inline_input'], additionalProperties: false }] },
        }] }))
        return
      }
      if (request.url === '/api/v8/auth/me') {
        response.end(JSON.stringify({ ok: true, account: { id: 7, username: 'fixture-user', role: 'user', status: 'active' } }))
        return
      }
      if (request.url === '/api/v8/developer/tasks/estimate') {
        const input = body as { task_type: string; input_kind: string }
        response.end(JSON.stringify({ ok: true, task_type: input.task_type, input_kind: input.input_kind,
          currency: 'CNY', billing_mode: 'server_price', estimated_total: '0.75', recommended_budget: '0.75',
          requested_budget: (body as { budget: string }).budget, settings_version: 1,
          balance_enough: true, price_basis: 'fixture-price-v1', quote_token: 'fixture.quote',
          quote_expires_at: Math.floor(Date.now() / 1000) + 300 }))
        return
      }
      if (request.url === '/api/v8/developer/tasks') {
        response.writeHead(202).end(JSON.stringify({ ok: true, id: 'workload-params-1', task_id: 'workload-params-1',
          workload_id: 'workload-params-1', task_type: 'word_count', status: 'CREATED', progress: 0 }))
        return
      }
      response.writeHead(404).end('{}')
    })
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    const types = await (await loaded.request('/api/qianshou/compute/task-types')).json() as Array<Record<string, unknown>>
    expect(types[0]).toMatchObject({ taskType: 'word_count', formReady: true, canQuoteInline: true,
      requiredParams: ['keyword'], paramsSchema: { properties: { top_n: { maximum: 1000 } } } })
    expect((await loaded.request('/api/qianshou/compute/plans', post({ ...planRequest, capabilityId: 'word_count' }))).status).toBe(409)
    const created = await loaded.request('/api/qianshou/compute/plans', post({ ...planRequest,
      capabilityId: 'word_count', params: { keyword: '法律', top_n: 25 } }))
    expect(created.status).toBe(201)
    const draft = await created.json() as { id: string }
    await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: draft.id, decision: 'approved' }))
    const quote = await loaded.request('/api/qianshou/compute/plans/quote', post({ id: draft.id }))
    expect(quote.status).toBe(200)
    const quoteId = (await quote.json() as { quoteId: string }).quoteId
    expect((await loaded.request('/api/qianshou/compute/plans/confirm-quoted', post({
      id: draft.id, quoteId, amount: '0.75',
    }))).status).toBe(200)
    expect((await loaded.request('/api/qianshou/compute/plans/publish', post({ id: draft.id }))).status).toBe(200)
    const estimates = core.requests.filter(item => item.path === '/api/v8/developer/tasks/estimate')
    const submits = core.requests.filter(item => item.path === '/api/v8/developer/tasks')
    expect(estimates).toHaveLength(1)
    expect(submits).toHaveLength(1)
    for (const item of [...estimates, ...submits]) {
      expect(item.body).toMatchObject({ task_type: 'word_count', input_kind: 'inline',
        inline_input: planRequest.goal, params: { keyword: '法律', top_n: 25 } })
    }
  })

  it('shows a generic inline task type but refuses file-only types and changed quotes', async () => {
    let estimates = 0
    const core = await coreFixture((request, response, body) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/api/v8/developer/task-types') {
        response.end(JSON.stringify({ ok: true, items: [
          { task_type: 'legal_scan_v1', category: 'legal', description: '术语定位', accepted_input_kinds: ['inline'], default_input_kind: 'inline', required_params: [] },
          { task_type: 'video_file_v1', category: 'video', description: '视频文件', accepted_input_kinds: ['single_file'], default_input_kind: 'single_file', required_params: [] },
          { task_type: 'search_job_v1', category: 'research', description: '需要关键词', accepted_input_kinds: ['inline'], default_input_kind: 'inline', required_params: ['keyword'] },
        ] }))
        return
      }
      if (request.url === '/api/v8/auth/me') {
        response.end(JSON.stringify({ ok: true, account: { id: 7, username: 'fixture-user', role: 'user', status: 'active' } }))
        return
      }
      if (request.url === '/api/v8/developer/tasks/estimate') {
        estimates += 1
        const input = body as { task_type: string; input_kind: string }
        response.end(JSON.stringify({ ok: true, task_type: input.task_type, input_kind: input.input_kind,
          currency: 'CNY', billing_mode: 'server_price', estimated_total: estimates === 1 ? '0.75' : '0.80',
          recommended_budget: estimates === 1 ? '0.75' : '0.80',
          requested_budget: (body as { budget: string }).budget, settings_version: 1, balance_enough: true,
          price_basis: 'fixture-price-v1', quote_token: 'fixture.quote', quote_expires_at: Math.floor(Date.now() / 1000) + 300 }))
        return
      }
      response.writeHead(404).end('{}')
    })
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    expect(await (await loaded.request('/api/qianshou/compute/task-types')).json()).toMatchObject([
      { taskType: 'legal_scan_v1', category: 'legal', canQuoteInline: true },
      { taskType: 'video_file_v1', category: 'video', canQuoteInline: false },
      { taskType: 'search_job_v1', category: 'research', requiredParams: ['keyword'], canQuoteInline: false },
    ])
    const refused = await loaded.request('/api/qianshou/compute/plans', post({ ...planRequest, capabilityId: 'video_file_v1' }))
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: 'COMPUTE_INPUT_KIND_UNSUPPORTED' } })
    const missingField = await loaded.request('/api/qianshou/compute/plans', post({ ...planRequest, capabilityId: 'search_job_v1' }))
    expect(missingField.status).toBe(409)
    const created = await loaded.request('/api/qianshou/compute/plans', post({ ...planRequest, capabilityId: 'legal_scan_v1' }))
    expect(created.status).toBe(201)
    const draft = await created.json() as { id: string }
    await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: draft.id, decision: 'approved' }))
    const first = await loaded.request('/api/qianshou/compute/plans/quote', post({ id: draft.id }))
    expect(first.status).toBe(200)
    const firstQuote = await first.json() as { quoteId: string; recommendedBudget: string }
    expect(firstQuote.recommendedBudget).toBe('0.75')
    const second = await loaded.request('/api/qianshou/compute/plans/quote', post({ id: draft.id }))
    expect(second.status).toBe(200)
    const secondQuote = await second.json() as { quoteId: string; recommendedBudget: string }
    expect(secondQuote.recommendedBudget).toBe('0.80')
    const stale = await loaded.request('/api/qianshou/compute/plans/confirm-quoted', post({
      id: draft.id, quoteId: firstQuote.quoteId, amount: firstQuote.recommendedBudget,
    }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'COMPUTE_QUOTE_CONFIRMATION_INVALID' } })
    expect(core.requests.some(item => item.path === '/api/v8/developer/tasks')).toBe(false)
  })

  it('returns a low-balance price but blocks confirmation before any paid submit', async () => {
    const core = await coreFixture((request, response, body) => {
      if (request.url === '/api/v8/developer/tasks/estimate') {
        const input = body as { task_type: string; input_kind: string }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: true, task_type: input.task_type, input_kind: input.input_kind,
          currency: 'CNY', billing_mode: 'server_price', estimated_total: '0.75', recommended_budget: '0.75',
          requested_budget: (body as { budget: string }).budget, settings_version: 1,
          balance_enough: false, price_basis: 'fixture-price-v1', quote_token: 'fixture.quote',
          quote_expires_at: Math.floor(Date.now() / 1000) + 300 }))
        return
      }
      catalogue(request, response)
    })
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    const draft = await (await loaded.request('/api/qianshou/compute/plans', post(planRequest))).json() as { id: string }
    await loaded.request('/api/qianshou/compute/plans/confirm', post({ id: draft.id, decision: 'approved' }))
    const quote = await (await loaded.request('/api/qianshou/compute/plans/quote', post({ id: draft.id }))).json() as { quoteId: string; recommendedBudget: string; balanceEnough: boolean }
    expect(quote).toMatchObject({ recommendedBudget: '0.75', balanceEnough: false })
    const confirmed = await loaded.request('/api/qianshou/compute/plans/confirm-quoted', post({
      id: draft.id, quoteId: quote.quoteId, amount: quote.recommendedBudget,
    }))
    expect(confirmed.status).toBe(409)
    expect(await confirmed.json()).toMatchObject({ error: { code: 'COMPUTE_QUOTE_BALANCE_INSUFFICIENT' } })
    expect(core.requests.some(item => item.path === '/api/v8/developer/tasks')).toBe(false)
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
    const quote = await (await loaded.request('/api/qianshou/compute/plans/quote', post({ id: draft.id }))).json() as { quoteId: string }
    const service = loaded.ctx.get('computeCore')!
    await expect(service.confirmQuotedPlan({ id: draft.id, quoteId: quote.quoteId, amount: '0.75' })).rejects.toMatchObject({ code: 'CORE_REQUEST_TIMEOUT' })
    await expect(service.confirmQuotedPlan({ id: draft.id, quoteId: quote.quoteId, amount: '0.75' })).rejects.toMatchObject({ code: 'COMPUTE_SUBMISSION_UNKNOWN' })
    const second = await loaded.request('/api/qianshou/compute/plans/quote', post({ id: draft.id }))
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

/**
 * W-23：产品里没有取消入口。平台侧语义已被 AT-03 实测钉死，这里是产品侧的判据：
 * 未终结能取消并拿到退款事实、已终态明确拒绝且不改状态、重复取消幂等且不重复退款。
 */
describe('compute workload cancellation', () => {
  async function cancellationComposition(): Promise<{ loaded: Composition; core: CoreFixture }> {
    const core = await coreFixture(cancellation)
    const root = await temporaryRoot()
    const tokenEnv = 'QIANSHOU_COMPUTE_FIXTURE_TOKEN'
    vi.stubEnv(tokenEnv, 'fixture-token-not-a-real-credential')
    const loaded = await loadComposition(root, { statePath: join(root, 'plans.json'), baseUrl: core.baseUrl, tokenEnv })
    return { loaded, core }
  }
  const deletes = (core: CoreFixture) => core.requests.filter(request => request.method === 'DELETE').length

  it('cancels a live workload and reports the ledger refund instead of the lagging balance', async () => {
    const { loaded, core } = await cancellationComposition()
    const response = await loaded.request('/api/qianshou/compute/workload/cancel', post({ id: 'workload-live' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: 'workload-live',
      state: 'CANCELLED',
      alreadyTerminal: false,
      ledger: {
        refundMinor: 1,
        // 只有这条任务的行；账本里别的任务的行不得混进来。
        rows: [
          { type: 'REFUND', amount: '0.0100', note: '任务退款 (workload-live · user_cancel)', createdAt: '2026-09-17T06:00:00+00:00' },
          { type: 'ESCROW_HOLD', amount: '-0.0100', note: '提交任务: 词频统计', createdAt: '2026-09-17T05:59:00+00:00' },
        ],
      },
    })
    expect(deletes(core)).toBe(1)
    // 取消是 DELETE，且不带请求体（平台的取消路由不接受 body）。
    expect(core.requests.find(request => request.method === 'DELETE')).toMatchObject({ path: '/api/v8/workloads/workload-live' })
  })

  it('answers a repeat cancellation idempotently without a second upstream cancel', async () => {
    const { loaded, core } = await cancellationComposition()
    const response = await loaded.request('/api/qianshou/compute/workload/cancel', post({ id: 'workload-cancelled' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'workload-cancelled', state: 'CANCELLED', alreadyTerminal: true })
    // 已经没有可取消的东西了：一次 DELETE 都不该发出去，也就不可能重复退款。
    expect(deletes(core)).toBe(0)
  })

  it('refuses to cancel a finished workload and leaves its state untouched', async () => {
    const { loaded, core } = await cancellationComposition()
    const rejected = await loaded.request('/api/qianshou/compute/workload/cancel', post({ id: 'workload-done' }))
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ error: { code: 'COMPUTE_WORKLOAD_ALREADY_TERMINAL' } })
    expect(deletes(core)).toBe(0)
    // 状态没被改动：再读一次仍是 DONE。
    const after: unknown = await (await loaded.request('/api/qianshou/compute/workload?id=workload-done')).json()
    expect(after).toMatchObject({ status: 'DONE' })
  })

  it('rejects a malformed identity before any upstream call', async () => {
    const { loaded, core } = await cancellationComposition()
    for (const body of [{}, { id: '' }, { id: '../etc/passwd' }, { id: 'x'.repeat(200) }, null, 'workload-live']) {
      const response = await loaded.request('/api/qianshou/compute/workload/cancel', post(body))
      expect(response.status).toBe(400)
    }
    expect(core.requests.length).toBe(0)
  })
})
