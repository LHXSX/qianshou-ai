/**
 * Real-Loader coverage for the resident contributor plugin entry.
 *
 * The audit that motivated this entry found `ResidentNodeRuntime` had no
 * non-test construction point and `node-contributor` had no importer at all.
 * These cases mount the row through the vendored Loader and observe the facts an
 * operator reads: the runtime exists, it is idle until driven, one tick advances
 * it, and the status names the transport and every deployment seam that is still
 * absent. Nothing here claims a task was accepted — the bound transport is the
 * in-memory conformance double.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { idleCommandFor } from '@deepseek-ai/dsh-compute-core'
import { FixtureWebSocketServer, type FixtureFrame, type FixtureServerContext } from '../../compute-core/tests/transport/fixture-ws-server.ts'
import {
  apply,
  Config,
  NODE_CONTRIBUTOR_SERVICE,
  resolveHarnessHome,
  readContributorAccessToken,
  ownerIdFromStoredAccess,
  resolveIsolatedRoute,
  resolvePolicy,
  resolveWorkspaceRoot,
  unconfiguredLeaseSource,
  unconfiguredVerifier,
  type NodeContributorService,
} from '../src/index.ts'
import { reviewedInlineUserParamsEmpty } from '../src/plugin.ts'
import { reviewedVideoHostPortOf } from '../src/reviewed-video-host-port.ts'
import { createProductReviewedVideoHostPort, createProvisionedReviewedVideoHostPort }
  from '../src/reviewed-video-host-provider.ts'

it('ignores only platform-signed developer metadata and refuses user params outside the reviewed empty schema', () => {
  const metadata = { _developer_api_version: 'task.v1',
    _developer_idempotency_key: 'case-1', _developer_idempotency_fingerprint: 'a'.repeat(64),
    _developer_webhook_configured: false }
  expect(reviewedInlineUserParamsEmpty(metadata)).toBe(true)
  expect(reviewedInlineUserParamsEmpty({ ...metadata, output_format: 'mp4' })).toBe(false)
  expect(reviewedInlineUserParamsEmpty({ ...metadata, _developer_webhook_configured: 'false' })).toBe(false)
  expect(reviewedInlineUserParamsEmpty({ ...metadata, _developer_api_version: 'task.v2' })).toBe(false)
})

/** One registered exact Fetch route captured from the stubbed carrier. */
interface RegisteredRoute { path: string; methods: readonly string[]; fetch: ConnectionFetchRoute['fetch'] }

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber?.dispose()
  context = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function connectionStub(routes: RegisteredRoute[]): Plugin.Object {
  return {
    name: 'connection-stub',
    apply(ctx) {
      ctx.provide('connection', {
        fetch: {
          register: (route: ConnectionFetchRoute) => {
            routes.push({ path: route.path, methods: route.methods, fetch: route.fetch })
            return async () => { routes.length = 0 }
          },
        },
      })
    },
  }
}

/** Mount the row through the real Loader, passing the row's own config through. */
async function mountContributor(routes: RegisteredRoute[], config: Config = {}): Promise<Context> {
  const root = await scratch('qianshou-contributor-plugin-')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: connection-stub',
    "  name: 'connection-stub'",
    '- id: qianshou-node-contributor',
    "  name: '@deepseek-ai/dsh-host-node-contributor'",
    '  config:',
    `    mediaGatewayOrigin: '${config.mediaGatewayOrigin ?? ''}'`,
    `    storePath: '${join(root, 'node-tasks.json')}'`,
    `    workspaceRoot: '${join(root, 'attempts')}'`,
    ...(config.autoStart === undefined ? [] : [`    autoStart: ${config.autoStart}`]),
    ...(config.mode === undefined ? [] : [`    mode: '${config.mode}'`]),
    ...(config.allowWhileUserActive === undefined ? [] : [`    allowWhileUserActive: ${config.allowWhileUserActive}`]),
    // `undefined` means "leave the schema default alone"; an explicit `[]` must reach the
    // config as an empty list, otherwise it silently turns into the new non-empty default.
    ...(config.allowedTaskTypes === undefined
      ? []
      : [`    allowedTaskTypes: [${config.allowedTaskTypes.map(type => `'${type}'`).join(', ')}]`]),
    ...(config.isolatedProvider === undefined || config.isolatedProvider === ''
      ? []
      : [`    isolatedProvider: '${config.isolatedProvider}'`]),
    ...(config.isolatedModel === undefined || config.isolatedModel === ''
      ? []
      : [`    isolatedModel: '${config.isolatedModel}'`]),
    ...(config.isolatedReasoningEffort === undefined || config.isolatedReasoningEffort === ''
      ? []
      : [`    isolatedReasoningEffort: '${config.isolatedReasoningEffort}'`]),
    ...(config.localTextStatisticsPackageName === undefined ? []
      : [`    localTextStatisticsPackageName: '${config.localTextStatisticsPackageName}'`]),
    ...(config.localTextStatisticsToolName === undefined ? []
      : [`    localTextStatisticsToolName: '${config.localTextStatisticsToolName}'`]),
    ...(config.localTextStatisticsPackageDigest === undefined ? []
      : [`    localTextStatisticsPackageDigest: '${config.localTextStatisticsPackageDigest}'`]),
    '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['connection-stub', connectionStub(routes)],
    ['@deepseek-ai/dsh-host-node-contributor', { name: 'qianshou-node-contributor', inject: ['connection'], apply, Config }],
  ])
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('node-contributor Cordis entry', () => {
  it('mounts compute-sharing routes through the real Loader and exposes only two owner-redacted modes', { timeout: 60_000 }, async () => {
    const routes: RegisteredRoute[] = []
    const ctx = await mountContributor(routes, { autoStart: false })
    const route = routes.find(r => r.path === '/api/qianshou/node/sharing/status')
    expect(route).toBeDefined()
    const response = await route?.fetch(new Request('http://127.0.0.1/api/qianshou/node/sharing/status'))
    const data = await response?.json() as { schema: string; authenticated: boolean; modes: { mode: string; phase: string }[] }
    expect(data).toMatchObject({ schema: 'qianshou.compute-sharing.v1', authenticated: false })
    expect(data.modes.map(m => m.mode)).toEqual(['image', 'video'])
    expect(JSON.stringify(data)).not.toMatch(/token|endpoint|deviceId|workerId|directory|origin/u)
    for (const action of ['enable', 'pause', 'resume']) {
      expect(routes.some(r => r.path === '/api/qianshou/node/sharing/' + action)).toBe(true)
    }
    const executor = ctx.get('qianshouMediaNodeExecutor') as { capabilities: readonly unknown[] }
    expect(executor.capabilities).toEqual([])
  })

  it('pauses order intake when an owner-pinned candidate is absent from the active Host profile', { timeout: 60_000 }, async () => {
    const ctx = await mountContributor([], { autoStart: false,
      localTextStatisticsPackageName: 'qianshou-local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      localTextStatisticsToolName: 'qianshou_local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      localTextStatisticsPackageDigest: 'b'.repeat(64),
    })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    expect(await service.canEnableLocalService('node')).toBe(false)
    service.setPanelAccepting(true)
    expect(service.status().intake).toBe('paused')
    expect(service.status().intakeReasons).toContain('LOCAL_ORDER_PLUGIN_UNAVAILABLE')
    expect(service.status().acceptingCapabilityIds).toEqual([])
  })

  it('constructs the resident loop in the host and reports it idle', { timeout: 60_000 }, async () => {
    // `autoStart: false` only here: this case is about a row that was mounted but never driven.
    const ctx = await mountContributor([], { autoStart: false })
    const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded.map(entry => entry.options.name)).toEqual([])

    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService | undefined
    expect(service, 'the row must provide nodeContributor').toBeDefined()
    expect(service?.acknowledgedWorkerId()).toBeNull()
    expect(await service?.canEnableLocalService('node')).toBe(true)
    expect(await service?.canEnableLocalService('git')).toBe(false)
    const status = service?.status()
    expect(status).toMatchObject({
      source: 'node-contributor',
      constructed: true,
      mode: 'BACKGROUND_ONLY',
      driver: 'idle',
      transport: 'edge-worker',
    })
    // A constructed loop that was never driven: the projection must not imply progress.
    expect(status?.resident?.state).toBe('IDLE')
    expect(status?.resident?.runs).toBe(0)
    expect(status?.resident?.lastOutcome).toBeNull()
    // The real Edge transport is bound by default, so the deployment gaps that remain are
    // the ones this host genuinely still lacks — not "we never opened a socket".
    expect(status?.productionGaps).not.toContain('transport')
    expect(status?.productionGaps).not.toContain('dispatchVerifier')
    expect(status?.productionGaps).not.toContain('workspaceRoot')
  })

  it('does not authorize a local service without the deployed word_count landing', { timeout: 60_000 }, async () => {
    const ctx = await mountContributor([], { autoStart: false, allowedTaskTypes: [] })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    expect(await service.canEnableLocalService('node')).toBe(false)
  })

  it('does not call a configured cloud agent merely to authorize a local service', { timeout: 60_000 }, async () => {
    const ctx = await mountContributor([], { autoStart: false,
      isolatedProvider: 'qianshou-cloud', isolatedModel: '千手·迅捷' })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    expect(await service.canEnableLocalService('node')).toBe(false)
    expect(service.status().resident?.runs).toBe(0)
  })

  it('drives exactly one tick and records the outcome, not a task acceptance', { timeout: 60_000 }, async () => {
    // `allowedTaskTypes: []` keeps the in-memory conformance double bound: this case is about
    // what one driven tick records, with nothing advertised to any dispatcher.
    const ctx = await mountContributor([], { autoStart: false, allowedTaskTypes: [] })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    // Drive the seam by hand so the case does not race the auto-start timer.
    await service.start()
    const after = await service.tick()
    expect(after.driver).toBe('running')
    expect(after.resident?.state).toBe('RUNNING')
    expect(after.resident?.runs).toBe(1)
    expect(after.resident?.lastOutcome).toMatchObject({ sentHeartbeat: true, runningTasks: 0, outcomes: [] })
    // The runtime is the real resident loop: stopping it drains to a terminal
    // state rather than leaving a half-open session behind.
    const stopped = await service.stop('case teardown')
    expect(stopped.driver).toBe('idle')
    expect(stopped.resident?.state).toBe('STOPPED')
  })

  it('serves the read-only status route and never drives the loop from it', { timeout: 60_000 }, async () => {
    const routes: RegisteredRoute[] = []
    const ctx = await mountContributor(routes, { autoStart: false })
    expect(routes.map(route => route.path)).toContain('/api/qianshou/node/status')
    expect(routes.map(route => route.path)).toContain('/api/qianshou/node/media/discover')
    const discoverRoute = routes.find(route => route.path === '/api/qianshou/node/media/discover')
    expect((await discoverRoute?.fetch(new Request('http://127.0.0.1/api/qianshou/node/media/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'http://127.0.0.1:8188' }),
    })))?.status).toBe(403)
    const statusRoute = routes.find(route => route.path === '/api/qianshou/node/status')
    expect(statusRoute?.methods).toEqual(['GET'])
    const response = await statusRoute?.fetch(new Request('http://127.0.0.1/api/qianshou/node/status'))
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ source: 'node-contributor', constructed: true, transport: 'edge-worker',
      h3Video: { configured: false, ready: false, code: 'H3_OWNER_CONFIG_NOT_CONFIGURED' } })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    expect(service.status().resident?.runs).toBe(0)
  })

  it('starts itself from the installed defaults, with no second switch to find', { timeout: 60_000 }, async () => {
    // "Installed and signed in" is the whole activation story: the shipped default must drive
    // the loop without anyone editing a profile. The owner is not signed in here, so the honest
    // observable is the failure the loop records, not a running node.
    expect(Config({}).autoStart).toBe(true)
    expect(Config({}).mediaGatewayOrigin).toBe('https://app.qianshousuanli.com')
    expect(Config({ mediaGuangzhouPublicKey: 'result-only-pem', mediaGuangzhouKeyId: 'result-only' }).mediaMetadataPublicKey).toBe('')
    expect(Config({ mediaGuangzhouPublicKey: 'result-only-pem', mediaGuangzhouKeyId: 'result-only' }).mediaMetadataKeyId).toBe('')
    expect(Config({ mediaGatewayOrigin: '' }).mediaGatewayOrigin).toBe('')
    const ctx = await mountContributor([])
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    await expect.poll(() => service.status().lastDriveFailure, { timeout: 5_000 }).toBe('COMPUTE_RESIDENT_NOT_CONNECTED')
    expect(service.status().transport).toBe('edge-worker')
  })

  it('defaults policy to BACKGROUND_ONLY, forces allowWhileUserActive off, and rejects an impossible policy', () => {
    const defaults = Config({})
    // Defaults that make "installed + signed in" enough: the node joins the pool over the real
    // transport and advertises the one task type this process can actually run. Taking work stays
    // the owner's switch (the supply policy, whose first-use default is `off`).
    expect(defaults).toMatchObject({
      mode: 'BACKGROUND_ONLY',
      autoStart: true,
      allowedTaskTypes: ['word_count'],
      maxConcurrency: 1,
    })
    expect(resolvePolicy({ mode: 'OFF', allowWhileUserActive: true }).allowWhileUserActive).toBe(false)
    expect(resolvePolicy({ mode: 'BACKGROUND_ONLY', allowWhileUserActive: true }).allowWhileUserActive).toBe(true)
    // Out-of-range limits cross the schema boundary, never a silent clamp.
    expect(() => Config({ maxConcurrency: 0 })).toThrow()
    expect(() => Config({ maxTemperatureC: 0 })).toThrow()
    expect(() => resolvePolicy({ maxConcurrency: 999 })).toThrow()
  })

  it('keeps the host mounted when autoStart runs before the owner signs in, and says why', { timeout: 60_000 }, async () => {
    // The real order of events: the row is mounted at boot, the owner signs in afterwards.
    // Starting the loop during load therefore fails with TRANSPORT_NOT_CONFIGURED — and a
    // rejection escaping that effect is fatal to the whole host (`dsh: fatal load failure`,
    // measured 2026-09-17). A resident node must instead stay mounted, keep ticking and
    // record the reason where an operator reads it.
    const ctx = await mountContributor([], { autoStart: true, mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'] })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    // The first tick reports the transport failure itself; every later one reports the runtime
    // state it left behind. Both are readable, and neither is a thrown host-level error.
    await expect.poll(() => service.status().lastDriveFailure, { timeout: 5_000 }).toBe('COMPUTE_RESIDENT_NOT_CONNECTED')
    // Nothing was observed to run, so the projection must not claim that it did.
    expect(service.status().driver).toBe('idle')
    expect(service.status().transport).toBe('edge-worker')
  })

  /**
   * 判据：**在不在池子里**看"有没有可广告的类型"，**接不接单**看 `mode` + owner 供给开关。
   * 这两件事以前被 `mode !== 'OFF'` 绑在一起，于是"贡献关掉"的机器在平台侧**根本没有行**，
   * `GET /api/v8/workers` 里什么都看不到（用户的前提：装了登录了就该进池并上报能力）。
   */
  it('binds the HMAC Edge connector whenever task types are listed, including while contribution is OFF', { timeout: 60_000 }, async () => {
    const running = await mountContributor([], { autoStart: false, mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'] })
    const runningStatus = (running.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService).status()
    expect(runningStatus.transport).toBe('edge-worker')
    expect(runningStatus.resident?.transport).toBe('edge-worker')
    expect(runningStatus.driver).toBe('idle')
    expect(runningStatus.productionGaps).not.toContain('transport')
    expect(runningStatus.productionGaps).not.toContain('dispatchVerifier')
    expect(runningStatus.productionGaps).not.toContain('resultTransfer')
    expect(runningStatus.productionGaps).not.toContain('workspaceRoot')

    // 贡献 OFF 不再拦注册：连接照建，只是把"可接单"撤回（心跳 paused + 拒单带稳定码）。
    const off = await mountContributor([], { autoStart: false, mode: 'OFF', allowedTaskTypes: ['word_count'] })
    const offService = off.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    expect(offService.status().mode).toBe('OFF')
    expect(offService.status().transport).toBe('edge-worker')
    expect(offService.status().productionGaps).not.toContain('transport')

    // 没有任何可广告的类型时才退回内存双：没有东西可上报，也就不建对外连接。
    const nothing = await mountContributor([], { autoStart: false, allowedTaskTypes: [] })
    const nothingStatus = (nothing.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService).status()
    expect(nothingStatus.transport).toBe('memory')
    expect(nothingStatus.productionGaps).toContain('transport')
  })

  it('still refuses to start a socket it was never given credentials for', { timeout: 60_000 }, async () => {
    const ctx = await mountContributor([], { autoStart: false, mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'] })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    await expect(service.start()).rejects.toMatchObject({ code: 'TRANSPORT_NOT_CONFIGURED' })
    expect(service.status().driver).toBe('idle')
  })

  it('rejects invalid allowed task types at load', { timeout: 60_000 }, async () => {
    // The loader records a failed fiber and still resolves. The service must not appear.
    expect(() =>{  apply({} as Context, { allowedTaskTypes: ['bad type'] }) }).toThrow(/COMPUTE_NODE_CONTRIBUTOR_TASK_TYPES_INVALID/)
    expect(() =>{  apply({} as Context, { allowedTaskTypes: ['ocr_image'] }) }).toThrow(/COMPUTE_NODE_CONTRIBUTOR_TASK_TYPE_UNSUPPORTED/)
    const invalid = await mountContributor([], { mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['bad type'] })
    expect(invalid.get(NODE_CONTRIBUTOR_SERVICE)).toBeUndefined()
    const unsupported = await mountContributor([], { mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['ocr_image'] })
    expect(unsupported.get(NODE_CONTRIBUTOR_SERVICE)).toBeUndefined()
    const withRoute = await mountContributor([], {
      mode: 'BACKGROUND_ONLY',
      allowedTaskTypes: ['ocr_image'],
      isolatedProvider: 'local-ollama',
      isolatedModel: 'llama3.2:latest',
    })
    expect(withRoute.get(NODE_CONTRIBUTOR_SERVICE)).toBeDefined()
  })
})

describe('node-contributor apply seams', () => {
  it('names the unconfigured dispatch refusals', async () => {
    expect(await unconfiguredVerifier('fingerprint', 'signature')).toBe(false)
    expect(() => unconfiguredLeaseSource()).toThrow('COMPUTE_NODE_CONTRIBUTOR_DISPATCH_UNCONFIGURED')
  })

  it('rejects impossible identity, paths and task-type lists', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-contributor-apply-')
    const storePath = join(root, 'node-tasks.json')
    const workspaceRoot = join(root, 'attempts')
    await expect(mountApply({ nodeId: 'bad node', storePath, workspaceRoot }))
      .rejects.toMatchObject({ code: 'COMPUTE_CONTRIBUTOR_NODE_ID_INVALID' })
    await expect(mountApply({ agentVersion: 'bad version', storePath, workspaceRoot }))
      .rejects.toMatchObject({ code: 'COMPUTE_CONTRIBUTOR_AGENT_VERSION_INVALID' })
    await expect(mountApply({ storePath: 'relative-tasks.json', workspaceRoot }))
      .rejects.toMatchObject({ code: 'COMPUTE_NODE_CONTRIBUTOR_PATH_NOT_ABSOLUTE' })
    await expect(mountApply({ storePath, workspaceRoot: 'relative-attempts' }))
      .rejects.toMatchObject({ code: 'COMPUTE_NODE_CONTRIBUTOR_PATH_NOT_ABSOLUTE' })
    await expect(mountApply({
      storePath,
      workspaceRoot: `${workspaceRoot}\0evil`,
    })).rejects.toThrow(/COMPUTE_WORKSPACE_CONFIG_INVALID/)
    await expect(mountApply({
      mode: 'BACKGROUND_ONLY',
      allowedTaskTypes: ['word_count', 'word_count'],
      storePath,
      workspaceRoot,
    })).rejects.toMatchObject({ code: 'COMPUTE_NODE_CONTRIBUTOR_TASK_TYPES_INVALID' })
    await expect(mountApply({
      mode: 'BACKGROUND_ONLY',
      allowedTaskTypes: Array.from({ length: 65 }, (_, index) => `t${index}`),
      storePath,
      workspaceRoot,
    })).rejects.toMatchObject({ code: 'COMPUTE_NODE_CONTRIBUTOR_TASK_TYPES_INVALID' })
    await expect(mountApply({
      mode: 'BACKGROUND_ONLY',
      allowedTaskTypes: ['ocr_image'],
      isolatedProvider: 'local-ollama',
      storePath,
      workspaceRoot,
    })).rejects.toMatchObject({ code: 'COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID' })
    expect(resolveIsolatedRoute('', '')).toBeNull()
    expect(resolveIsolatedRoute('local-ollama', 'llama3.2:latest')).toEqual({
      provider: 'local-ollama',
      model: 'llama3.2:latest',
    })
    expect(resolveIsolatedRoute('qianshou-cloud', '千手·迅捷')).toEqual({
      provider: 'qianshou-cloud',
      model: '千手·迅捷',
    })
    expect(resolveIsolatedRoute('qianshou-cloud', '千手·迅捷', 'off')).toEqual({
      provider: 'qianshou-cloud',
      model: '千手·迅捷',
      reasoningEffort: 'off',
    })
    expect(() => resolveIsolatedRoute('', '', 'off')).toThrow('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
    expect(() => resolveIsolatedRoute('qianshou-cloud', '千手·迅捷', 'unknown')).toThrow('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
    expect(() => resolveIsolatedRoute('local ollama', 'llama')).toThrow('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
    expect(() => resolveIsolatedRoute('', 'llama3.2:latest')).toThrow('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
    expect(() => resolveIsolatedRoute('local-ollama', '')).toThrow('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
  })

  it('uses a live stored access credential and renews only an expired JWT', async () => {
    const ensure = vi.fn(async () => 'refreshed')
    const now = Date.now()
    await expect(readContributorAccessToken(async () => 'stored-token', ensure)).resolves.toBe('stored-token')
    await expect(readContributorAccessToken(async () => jwt({ sub: '9', exp: Math.floor(now / 1000) + 3600 }), ensure)).resolves.toMatch(/^ey/)
    expect(ensure).not.toHaveBeenCalled()
    await expect(readContributorAccessToken(async () => jwt({ sub: '9', exp: Math.floor(now / 1000) - 10 }), ensure)).resolves.toBe('refreshed')
    expect(ensure).toHaveBeenCalledOnce()
    await expect(readContributorAccessToken(async () => '', ensure)).resolves.toBeUndefined()
    await expect(readContributorAccessToken(async () => { throw new Error('unreadable') }, ensure)).resolves.toBeUndefined()
    expect(ensure).toHaveBeenCalledOnce()
    await expect(readContributorAccessToken(undefined, async () => 'session-token')).resolves.toBe('session-token')
  })

  it('names the owner from the stored access credential and does not read the core account', { timeout: 60_000 }, async () => {
    const now = Date.now()
    const token = jwt({ sub: '9', exp: Math.floor(now / 1000) + 3600 })
    let coreReads = 0
    const ctx = await mountApply({
      mode: 'BACKGROUND_ONLY',
      allowedTaskTypes: ['word_count'],
    }, {
      computeCore: {
        coreOrigin: () => 'http://127.0.0.1:1',
        ownerAccountId: async () => { coreReads += 1; return 7 },
      },
      credentials: { resolve: async () => ({ value: token }) },
    })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    await expect(service.start()).rejects.toMatchObject({ code: 'TRANSPORT_NETWORK_FAILED' })
    expect(coreReads).toBe(0)
    expect(ownerIdFromStoredAccess(jwt({ sub: '9', exp: 1 }), now)).toBeNull()
  })

  it('the window switch cannot bypass missing owner authorization or deployment OFF', { timeout: 60_000 }, async () => {
    const ctx = await mountContributor([], { autoStart: false, mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'] })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    expect(service.status().intake).toBe('paused')
    service.setPanelAccepting(true)
    expect(service.status().intake).toBe('paused')
    expect(service.status().acceptingCapabilityIds).toEqual([])
    service.setPanelAccepting(false)
    expect(service.status().intake).toBe('paused')
    await ctx.fiber?.dispose()
    const off = await mountContributor([], { autoStart: false, mode: 'OFF', allowedTaskTypes: ['word_count'] })
    const offService = off.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    offService.setPanelAccepting(true)
    expect(offService.status().intake).toBe('paused')
    expect(offService.status().intakeReason).toBe('deployment-disabled')
  })

  it('resolves the Harness home from DSH_HOME or the user home', () => {
    expect(resolveHarnessHome({ DSH_HOME: '/tmp/dsh-home' }, '/unused')).toBe('/tmp/dsh-home')
    expect(resolveHarnessHome({ DSH_HOME: '' }, '/Users/test')).toBe(join('/Users/test', '.deepseek-harness'))
    expect(resolveHarnessHome({}, '/Users/test')).toBe(join('/Users/test', '.deepseek-harness'))
    expect(resolveHarnessHome()).toMatch(/./)
  })

  it('resolves empty store path and workspace under DSH_HOME', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-contributor-home-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const ctx = await mountApply({ storePath: '', workspaceRoot: '' })
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      expect(service.status().productionGaps).not.toContain('workspaceRoot')
      expect(service.status().transport).toBe('memory')
      expect(resolveWorkspaceRoot('')).toBe(join(root, 'qianshou', 'attempts'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('reads origin, token and owner from injected siblings, then fails without a live socket', { timeout: 60_000 }, async () => {
    const ctx = await mountApply({
      mode: 'BACKGROUND_ONLY',
      allowedTaskTypes: ['word_count'],
    }, {
      computeCore: {
        coreOrigin: () => 'http://127.0.0.1:1',
        ownerAccountId: async () => 7,
      },
      accountSession: { ensureAccessToken: async () => 'edge-token' },
    })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    await expect(service.start()).rejects.toMatchObject({ code: 'TRANSPORT_NETWORK_FAILED' })
  })

  it('treats a missing token, empty token, failed me read and non-positive owner as auth failures', { timeout: 60_000 }, async () => {
    await expect(startEdge({
      computeCore: { coreOrigin: () => 'http://127.0.0.1:1', ownerAccountId: async () => 7 },
      accountSession: {},
    })).rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
    await expect(startEdge({
      computeCore: { coreOrigin: () => 'http://127.0.0.1:1', ownerAccountId: async () => 7 },
      accountSession: { ensureAccessToken: async () => null },
    })).rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
    await expect(startEdge({
      computeCore: { coreOrigin: () => 'http://127.0.0.1:1', ownerAccountId: async () => 7 },
      accountSession: { ensureAccessToken: async () => '' },
    })).rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
    await expect(startEdge({
      computeCore: {
        coreOrigin: () => 'http://127.0.0.1:1',
        ownerAccountId: async () => { throw new Error('me failed') },
      },
      accountSession: { ensureAccessToken: async () => 'token' },
    })).rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
    await expect(startEdge({
      computeCore: { coreOrigin: () => 'http://127.0.0.1:1', ownerAccountId: async () => 0 },
      accountSession: { ensureAccessToken: async () => 'token' },
    })).rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
  })

  it('reads computeCore and accountSession from ctx.get when inject has not fired', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-contributor-get-')
    let service: NodeContributorService | undefined
    apply({
      inject() { /* Optional siblings are absent at apply; connect reads ctx.get. */ },
      provide(name: string, value: NodeContributorService) {
        if (name === NODE_CONTRIBUTOR_SERVICE) service = value
      },
      effect() { return () => undefined },
      get(name: string) {
        if (name === 'computeCore') {
          return { coreOrigin: () => 'http://127.0.0.1:1', ownerAccountId: async () => 7 }
        }
        if (name === 'accountSession') return { ensureAccessToken: async () => 'token' }
        return undefined
      },
      connection: { fetch: { register: () => async () => undefined } },
    } as never, {
      mode: 'BACKGROUND_ONLY',
      allowedTaskTypes: ['word_count'],
      storePath: join(root, 'tasks.json'),
      workspaceRoot: join(root, 'attempts'),
    })
    expect(service).toBeDefined()
    await expect(service?.start()).rejects.toMatchObject({ code: 'TRANSPORT_NETWORK_FAILED' })
  })

  it('starts the Edge loop against a real fixture socket when siblings are present', { timeout: 60_000 }, async () => {
    const server = await FixtureWebSocketServer.start({
      script: (frame: FixtureFrame, fixture: FixtureServerContext) => {
        if (frame.type === 'hello') fixture.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-17T04:00:00.000Z' })
        if (frame.type === 'auth') fixture.reply('auth_ok', { worker_id: 'worker-plugin-1', owner_id: 7, reconnect: false })
        if (frame.type === 'hb') fixture.reply('hb_ack', {})
      },
    })
    try {
      const ctx = await mountApply({
        mode: 'BACKGROUND_ONLY',
        allowedTaskTypes: ['word_count'],
        handshakeTimeoutMs: 2_000,
      }, {
        computeCore: {
          coreOrigin: () => server.origin,
          ownerAccountId: async () => 7,
        },
        accountSession: { ensureAccessToken: async () => 'socket-fixture-token' },
      })
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      const started = await service.start()
      expect(started.driver).toBe('running')
      expect(started.transport).toBe('edge-worker')
      const ticked = await service.tick()
      expect(ticked.resident?.runs).toBe(1)
      await service.stop('case teardown')
    } finally {
      await server.close()
    }
  })

  /**
   * AT-09 的缺陷：`POST /api/qianshou/compute/supply/policy` 写 `mode: off` 成功后，
   * 节点投影仍是 `BACKGROUND_ONLY`，接单照旧 —— 供给开关与接单完全不联动。
   * 这两条用例钉住修好后的语义：**完全关闭 ⇒ 心跳报 paused、派单一律带稳定码拒绝、不落盘**；
   * 打开 ⇒ 照常受理并完成。
   */
  const ownerAssignment = {
    workload_id: 'workload-owner-switch', shard_id: 'shard-owner-switch', attempt: 0,
    task_type: 'word_count', runtime: 'python3', input_kind: 'inline', inline_input: 'alpha beta alpha',
    input_ref: '', input_refs: [], code_url: '', code_sha256: '', timeout_s: 60,
    verification_policy: 'semantic', execution_model: '', capability: '', capability_version: '',
    lease_token: 'fixture-lease-owner-switch',
  }

  it.each(['partial-service', 'runtime-unavailable', 'installation-unavailable', 'unprovisioned-ledger'] as const)(
    'product Host refuses reviewed video when the injected %s cannot establish local readiness',
    { timeout: 60_000 }, async (caseName) => {
      let assigned = false
      const server = await FixtureWebSocketServer.start({ script: (frame, fixture) => {
        if (frame.type === 'hello') fixture.reply('welcome', { hb_interval_s: 60,
          server_time: '2026-09-28T06:00:00.000Z' })
        if (frame.type === 'auth') fixture.reply('auth_ok', { worker_id: 'worker-review-fixture',
          owner_id: 7, reconnect: false,
          connection_id: '11111111-1111-4111-8111-111111111111' })
        if (frame.type === 'hb') {
          fixture.reply('hb_ack', {})
          if (!assigned) {
            assigned = true
            fixture.reply('shard_assign', { ...ownerAssignment,
              workload_id: 'workload-reviewed', shard_id: 'shard-reviewed',
              task_type: 'owner_video_v1', runtime: 'python3', input_kind: 'multi_file',
              inline_input: null, input_ref: 'https://media.example.test/first.png?versionId=v1',
              input_refs: ['https://media.example.test/first.png?versionId=v1'], params: {},
              execution_model: 'runtime_v2', runtime_api: '2.0', capability: 'video.render',
              capability_version: 'v1', reviewed_video_order: { signed: 'fixture' },
            })
          }
        }
      } })
      const proveLocalReady = vi.fn(async () => {
        if (caseName === 'runtime-unavailable') throw new Error('Comfy or ffprobe unavailable')
      })
      const unavailable = vi.fn(async () => null)
      const { publicKey } = generateKeyPairSync('ed25519')
      const missing = async (): Promise<never> => { throw new Error('not installed') }
      const provision = caseName === 'unprovisioned-ledger'
        ? { taskType: 'owner_video_v1',
          orderPublicKeys: { current: publicKey },
          ledgerPath: join(await scratch('qianshou-unprovisioned-video-'), 'ledger', 'attempt.sqlite'),
          taskStore: { get: missing }, drafts: { readPrivate: missing },
          bridge: { readCurrentInstallation: missing, readCurrentPublication: missing,
            assertOrderPublication: missing, assertOrderOwnership: missing,
            assertTaskValues: missing, assertRuntimeCurrent: missing,
            withGpuReservation: missing },
          ownerAccountId: async () => 7,
          runtime: async () => ({ port: 8188, ffprobePath: '/unavailable/ffprobe' }),
          storageOrigin: new URL('https://media.example.test'),
          controlOrigin: new URL('https://shanghai.example.test'),
          evidenceEndpoint: new URL('https://evidence.example.test'), evidenceBucket: 'reviewed-evidence',
          attestorPublicKeys: { fixture: 'unavailable-key' },
          supply: { readCurrent: unavailable, signDevice: missing,
            readSampleAttestation: missing },
        } : null
      const host = caseName === 'partial-service' ? { offer: { taskType: 'owner_video_v1' } } : {
        offer: { taskType: 'owner_video_v1', verifyOffer: vi.fn(), readSignedOrder: unavailable },
        consumerPorts: { ownerAccountId: unavailable, runtime: unavailable,
          bridge: { readCurrentInstallation: unavailable, readCurrentPublication: unavailable,
            assertOrderPublication: unavailable, assertOrderOwnership: unavailable,
            assertTaskValues: unavailable, assertRuntimeCurrent: unavailable,
            withGpuReservation: unavailable, drafts: { readPrivate: unavailable },
            ledger: { reserve: unavailable, assertReserved: unavailable,
              beforePromptSubmit: unavailable, recordPromptId: unavailable,
              recordLocalResult: unavailable } } },
        storageOrigin: new URL('https://media.example.test'),
        controlOrigin: new URL('https://shanghai.example.test'),
        evidenceEndpoint: new URL('https://evidence.example.test'), evidenceBucket: 'reviewed-evidence',
        attestorPublicKeys: { fixture: 'unavailable-key' },
        supply: { readCurrent: unavailable, signDevice: unavailable,
          readSampleAttestation: unavailable }, proveLocalReady,
      }
      expect(reviewedVideoHostPortOf(provision === null ? host
        : createProvisionedReviewedVideoHostPort(provision)) !== null)
        .toBe(caseName !== 'partial-service')
      const productProvision = provision === null ? null : Object.fromEntries(Object.entries(provision)
        .filter(([key]) => !['taskStore', 'drafts', 'ownerAccountId'].includes(key)))
      if (productProvision !== null) {
        const currentOwner = vi.fn(async () => 7)
        const privateDraft = vi.fn(missing)
        const productHost = createProductReviewedVideoHostPort(productProvision, { get: missing }, {
          ownerAccountId: currentOwner, readPrivateVideoWorkflowDraft: privateDraft,
        })
        expect(productHost).not.toBeNull()
        await expect(productHost!.consumerPorts.ownerAccountId()).resolves.toBe(7)
        expect(currentOwner).toHaveBeenCalledOnce()
        await expect(productHost!.consumerPorts.bridge.drafts.readPrivate('private-draft', 'a'.repeat(64)))
          .rejects.toThrow('not installed')
        expect(privateDraft).toHaveBeenCalledWith('private-draft', 'a'.repeat(64))
        expect(createProductReviewedVideoHostPort(provision, { get: missing }, {
          ownerAccountId: async () => 7, readPrivateVideoWorkflowDraft: missing,
        })).toBeNull()
        expect(createProductReviewedVideoHostPort(productProvision, { get: missing }, {
          ownerAccountId: async () => 7,
        })).toBeNull()
      }
      try {
        const ctx = await mountApply({ mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'],
          handshakeTimeoutMs: 2_000 }, {
          computeCore: { coreOrigin: () => server.origin, ownerAccountId: async () => 7,
            readPrivateVideoWorkflowDraft: missing },
          accountSession: { ensureAccessToken: async () => 'socket-fixture-token' },
          ...(provision === null ? { qianshouReviewedVideoHost: host }
            : { qianshouReviewedVideoHostProvision: productProvision! }),
        })
        const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
        await service.start()
        await service.tick()
        await vi.waitFor(() => { expect(server.frames.some(frame => frame.type === 'shard_result'
          && frame.payload.failure_class === 'EDGE_TASK_SCOPE_DENIED')).toBe(true) })
        const hello = server.frames.find(frame => frame.type === 'hello')?.payload
        expect(hello).toBeDefined()
        const claims = (hello?.capabilities as Record<string, unknown>)?.provided_capabilities as
          readonly { name: string }[] | undefined
        expect(claims?.some(item => item.name === 'video.render')).toBe(false)
        expect(server.frames.some(frame => frame.type === 'reviewed_video_adapter_update')).toBe(false)
        expect(proveLocalReady).toHaveBeenCalledTimes(caseName === 'runtime-unavailable'
          || caseName === 'installation-unavailable' ? 1 : 0)
        if (caseName === 'unprovisioned-ledger') expect(unavailable).not.toHaveBeenCalled()
        await service.stop('case teardown')
      } finally { await server.close() }
    })

  async function mountOwnerSwitch(mode: 'off' | 'idle' | 'allowed' | (() => Promise<{ mode?: unknown }>) | undefined): Promise<{ server: FixtureWebSocketServer; ctx: Context; store: string }> {
    const server = await FixtureWebSocketServer.start({
      script: (frame: FixtureFrame, fixture: FixtureServerContext) => {
        if (frame.type === 'hello') fixture.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-17T04:00:00.000Z' })
        if (frame.type === 'auth') fixture.reply('auth_ok', { worker_id: 'worker-owner-switch', owner_id: 7, reconnect: false })
        if (frame.type === 'hb') {
          fixture.reply('hb_ack', {})
          // 平台无论节点报什么都会硬派一条（定向绑定），闸门必须在节点这一侧。
          fixture.reply('shard_assign', ownerAssignment)
        }
      },
    })
    const store = join(await scratch('qianshou-owner-switch-'), 'node-tasks.json')
    const ctx = await mountApply(
      // `allowWhileUserActive: true`：这台跑测试的机器**正在被人使用**，而活动探测现在是真实读数，
      // 所以"供给打开就能接活"这条要显式允许前台占用（默认 false 时节点会正确地拒绝）。
      { mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'], handshakeTimeoutMs: 2_000, storePath: store,
        allowWhileUserActive: true },
      {
        computeCore: {
          coreOrigin: () => server.origin,
          ownerAccountId: async () => 7,
          ...(mode === undefined ? {} : { ownerSupplyPolicy: async () => ({
            maxConcurrency: 1, minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [],
            ...(typeof mode === 'function' ? await mode() : { mode }),
          }) }),
        },
        accountSession: { ensureAccessToken: async () => 'socket-fixture-token' },
      },
    )
    return { server, ctx, store }
  }

  it('mirrors 完全关闭 as a paused heartbeat and refuses the assignment without intake', { timeout: 60_000 }, async () => {
    const { server, ctx, store } = await mountOwnerSwitch('off')
    try {
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      service.setPanelAccepting(true)
      await service.start()
      // 首帧心跳由连接在 auth_ok 后自己发（连接内部默认 paused）；带 owner 开关的是每一拍的心跳。
      await service.tick()
      await vi.waitFor(() => {
        expect(server.frames.filter(frame => frame.type === 'hb').at(-1)?.payload)
          .toMatchObject({ mode: 'paused', throttle_pct: 0 })
      })
      await vi.waitFor(() => { expect(server.frames.some(frame => frame.type === 'shard_result')).toBe(true) })
      expect(server.frames.find(frame => frame.type === 'shard_result')?.payload).toMatchObject({
        ok: false, failure_class: 'EDGE_SUPPLY_WITHDRAWN', shard_id: 'shard-owner-switch',
      })
      // 没有受理：既不落盘，也没有在飞尝试。
      await expect(readFile(store, 'utf8')).rejects.toThrow()
      expect(service.status().resident?.inFlight).toBe(0)
      expect(service.status().declaredCapabilityIds).toEqual(['text.transform'])
      expect(service.status().acceptingCapabilityIds).toEqual([])
      await service.stop('case teardown')
    } finally { await server.close() }
  })

  it('keeps taking and completing work while the owner switch is open', { timeout: 60_000 }, async () => {
    const { server, ctx, store } = await mountOwnerSwitch('allowed')
    try {
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      await service.start()
      expect(service.status().intake).toBe('running')
      service.setPanelAccepting(false)
      expect(service.status().intake).toBe('paused')
      expect(service.status().acceptingCapabilityIds).toEqual([])
      service.setPanelAccepting(true)
      expect(service.status().intake).toBe('running')
      expect(service.status().acceptingCapabilityIds).toEqual(['text.transform'])
      await service.tick()
      await vi.waitFor(() => {
        expect(server.frames.filter(frame => frame.type === 'hb').at(-1)?.payload)
          .toMatchObject({ mode: 'running', throttle_pct: 100 })
      })
      // 一次心跳只缓冲派单，受理发生在下一拍；给足几拍。
      await vi.waitFor(async () => {
        await service.tick()
        expect(server.frames.some(frame => frame.type === 'shard_result' && frame.payload.ok === true)).toBe(true)
      }, { timeout: 15_000, interval: 250 })
      const stored = JSON.parse(await readFile(store, 'utf8')) as { tasks: { status: string }[] }
      expect(stored.tasks.map(task => task.status)).toEqual(['RETURNED'])
      expect(service.status().resident?.inFlight).toBe(0)
      expect(service.status().declaredCapabilityIds).toEqual(['text.transform'])
      expect(service.status().acceptingCapabilityIds).toEqual(['text.transform'])
      await service.stop('case teardown')
    } finally { await server.close() }
  })

  it('loads a purchased v5 claim after worker identity and actually executes its assignment', { timeout: 60_000 }, async () => {
    let advertised = false
    let assigned = false
    const server = await FixtureWebSocketServer.start({ script: (frame, fixture) => {
      if (frame.type === 'hello') {
        const capabilities = frame.payload.capabilities as Record<string, unknown>
        advertised = Array.isArray(capabilities.verified_task_adapters)
          && capabilities.verified_task_adapters.some((row: Record<string, unknown>) =>
            row.task_type === 'legal_term_scan_v1')
        fixture.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-26T00:00:00.000Z' })
      }
      if (frame.type === 'auth') fixture.reply('auth_ok', {
        worker_id: 'worker-buyer-1', owner_id: 7, reconnect: false,
      })
      if (frame.type === 'hb') {
        fixture.reply('hb_ack', {})
        if (advertised && !assigned && frame.payload.mode === 'running') {
          assigned = true
          fixture.reply('shard_assign', { ...ownerAssignment,
            workload_id: 'workload-purchased', shard_id: 'shard-purchased',
            task_type: 'legal_term_scan_v1', runtime: 'node',
            inline_input: '{"text":"合同"}', capability: 'legal.term_scan',
          })
        }
      }
    } })
    const run = vi.fn(async (_input: Record<string, unknown>) => ({ text: '{"terms":["合同"]}' }))
    const verify = vi.fn(async (workerId: string) => workerId === 'worker-buyer-1' ? [{
      productId: 'product-1', entitlementId: 'entitlement-1', taskType: 'legal_term_scan_v1',
      capabilityId: 'legal.term_scan', outputKind: 'inline_json',
      artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: `sha256:${'b'.repeat(64)}`,
      runtimeDigest: `sha256:${'c'.repeat(64)}`, contractVersion: 'v1',
    }] : [])
    try {
      const ctx = await mountApply({ mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'],
        allowWhileUserActive: true, handshakeTimeoutMs: 2_000 }, {
        computeCore: { coreOrigin: () => server.origin, ownerAccountId: async () => 7,
          ownerSupplyPolicy: async () => ({ mode: 'allowed', maxConcurrency: 1,
            minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }) },
        accountSession: { ensureAccessToken: async () => 'socket-fixture-token' },
        qianshouPluginCatalog: { verifiedPurchasedOrderRuntimes: verify,
          runPurchasedOrderRuntime: run },
      })
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      await service.start()
      await service.tick()
      await vi.waitFor(() =>{  expect(server.frames.filter(frame => frame.type === 'hello').length)
        .toBeGreaterThanOrEqual(2) }, { timeout: 10_000 })
      await vi.waitFor(async () => {
        await service.tick()
        expect(service.status().acceptingCapabilityIds).toContain('legal.term_scan')
        expect(run).toHaveBeenCalled()
        expect(server.frames.some(frame => frame.type === 'shard_result' && frame.payload.ok === true)).toBe(true)
      }, { timeout: 15_000, interval: 250 })
      expect(run.mock.calls[0]?.[0]).toMatchObject({ workerId: 'worker-buyer-1',
        taskType: 'legal_term_scan_v1', artifactDigest: `sha256:${'a'.repeat(64)}`,
        inlineInput: '{"text":"合同"}' })
      expect(verify).toHaveBeenCalledWith('worker-buyer-1')
      await service.stop('case teardown')
    } finally { await server.close() }
  })

  it('advertises an author only through installed device ownership and executes its exact assignment',
    { timeout: 60_000 }, async () => {
      let advertised = false
      let assigned = false
      const server = await FixtureWebSocketServer.start({ script: (frame, fixture) => {
        if (frame.type === 'hello') {
          const capabilities = frame.payload.capabilities as Record<string, unknown>
          advertised = Array.isArray(capabilities.verified_task_adapters)
            && capabilities.verified_task_adapters.some((row: Record<string, unknown>) =>
              row.task_type === 'qianshou_reverse_acceptance_v1'
              && row.artifact_digest === `sha256:${'a'.repeat(64)}`
              && row.package_digest === `sha256:${'b'.repeat(64)}`)
          fixture.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-26T00:00:00.000Z' })
        }
        if (frame.type === 'auth') fixture.reply('auth_ok', {
          worker_id: 'worker-author-1', owner_id: 7, reconnect: false,
        })
        if (frame.type === 'hb') {
          fixture.reply('hb_ack', {})
          if (advertised && !assigned && frame.payload.mode === 'running') {
            assigned = true
            fixture.reply('shard_assign', { ...ownerAssignment,
              workload_id: 'workload-author-v5', shard_id: 'shard-author-v5',
              task_type: 'qianshou_reverse_acceptance_v1', runtime: 'node',
              inline_input: '{"text":"合同"}', capability: 'text.reverse_acceptance',
              params: { _developer_api_version: 'task.v1',
                _developer_idempotency_key: 'fixture-author',
                _developer_idempotency_fingerprint: 'f'.repeat(64),
                _developer_webhook_configured: false },
            })
          }
        }
      } })
      const runInstalled = vi.fn(async (_input: unknown) => ({ text: '{"text":"同合"}' }))
      const verifyInstalled = vi.fn(async (workerId: string) => workerId === 'worker-author-1' ? [{
        productId: 'author-product', entitlementId: 'author-entitlement', runtimeDigest: `sha256:${'c'.repeat(64)}`,
        taskType: 'qianshou_reverse_acceptance_v1', capabilityId: 'text.reverse_acceptance',
        outputKind: 'inline_json', artifactDigest: `sha256:${'a'.repeat(64)}`,
        packageDigest: `sha256:${'b'.repeat(64)}`, contractVersion: 'v1',
      }] : [])
      try {
        const ctx = await mountApply({ mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'],
          isolatedProvider: 'qianshou-cloud', isolatedModel: 'fixture-unavailable-cloud',
          allowWhileUserActive: true, handshakeTimeoutMs: 2_000 }, {
          computeCore: { coreOrigin: () => server.origin, ownerAccountId: async () => 7,
            ownerSupplyPolicy: async () => ({ mode: 'allowed', maxConcurrency: 1,
              minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }) },
          accountSession: { ensureAccessToken: async () => 'socket-fixture-token' },
          qianshouPluginCatalog: { verifiedAuthorOrderRuntimes: async () => { throw new Error('approval alone must not run') },
            verifiedPurchasedOrderRuntimes: verifyInstalled, runPurchasedOrderRuntime: runInstalled },
        })
        const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
        await service.start()
        await service.tick()
        await vi.waitFor(() =>{  expect(server.frames.filter(frame => frame.type === 'hello').length)
          .toBeGreaterThanOrEqual(2) }, { timeout: 10_000 })
        expect(await service.canEnableLocalService('node')).toBe(true)
        const claims = (server.frames.filter(frame => frame.type === 'hello').at(-1)?.payload.capabilities as {
          verified_task_adapters: { task_type: string }[] }).verified_task_adapters
        expect(claims.some(row => row.task_type === 'word_count')).toBe(false)
        await vi.waitFor(async () => {
          await service.tick()
          expect(service.status().acceptingCapabilityIds).toContain('text.reverse_acceptance')
          expect(runInstalled).toHaveBeenCalled()
          expect(server.frames.some(frame => frame.type === 'shard_result' && frame.payload.ok === true)).toBe(true)
        }, { timeout: 15_000, interval: 250 })
        expect(runInstalled.mock.calls[0]?.[0]).toMatchObject({ workerId: 'worker-author-1',
          taskType: 'qianshou_reverse_acceptance_v1', artifactDigest: `sha256:${'a'.repeat(64)}`,
          runtimeDigest: `sha256:${'c'.repeat(64)}`, productId: 'author-product',
          entitlementId: 'author-entitlement', inlineInput: '{"text":"合同"}' })
        expect(verifyInstalled).toHaveBeenCalledWith('worker-author-1')
        await service.stop('case teardown')
      } finally { await server.close() }
    })

  it('withdraws a dynamic claim on a failed Hello and retries fresh local proof after the platform recovers',
    { timeout: 30_000 }, async () => {
      const snapshots: boolean[] = []
      const server = await FixtureWebSocketServer.start({ script: (frame, fixture) => {
        if (frame.type === 'hello') {
          const capabilities = frame.payload.capabilities as Record<string, unknown>
          snapshots.push(Array.isArray(capabilities.verified_task_adapters)
            && capabilities.verified_task_adapters.some((row: Record<string, unknown>) =>
              row.task_type === 'qianshou_reverse_acceptance_v1'))
          fixture.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-26T00:00:00.000Z' })
        }
        if (frame.type === 'auth') fixture.reply('auth_ok', {
          worker_id: 'worker-author-recovery', owner_id: 7, reconnect: false,
        })
        if (frame.type === 'hb') fixture.reply('hb_ack', {})
      } })
      const verified = [{ productId: 'author-product', entitlementId: 'author-entitlement',
        runtimeDigest: `sha256:${'c'.repeat(64)}`, taskType: 'qianshou_reverse_acceptance_v1',
        capabilityId: 'text.reverse_acceptance', outputKind: 'inline_json' as const,
        artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: `sha256:${'b'.repeat(64)}`,
        contractVersion: 'v1' as const }]
      const verifyInstalled = vi.fn(async () => verified)
      const clockNow = Date.now.bind(Date)
      const nowSpy = vi.spyOn(Date, 'now')
      let offset = 0
      nowSpy.mockImplementation(() => clockNow() + offset)
      try {
        const ctx = await mountApply({ mode: 'BACKGROUND_ONLY', allowedTaskTypes: ['word_count'],
          allowWhileUserActive: true, handshakeTimeoutMs: 2_000 }, {
          computeCore: { coreOrigin: () => server.origin, ownerAccountId: async () => 7,
            ownerSupplyPolicy: async () => ({ mode: 'allowed', maxConcurrency: 1,
              minFreeMemoryBytes: 0, minIdleSeconds: 60, enabledServiceIds: ['node'], nodeRates: [] }) },
          accountSession: { ensureAccessToken: async () => 'socket-fixture-token' },
          qianshouPluginCatalog: { verifiedPurchasedOrderRuntimes: verifyInstalled,
            runPurchasedOrderRuntime: async () => { throw new Error('witness-only fixture must not execute') } },
        })
        const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
        await service.start()
        await service.tick()
        await vi.waitFor(() =>{  expect(snapshots.at(-1)).toBe(true) }, { timeout: 10_000 })
        verifyInstalled.mockRejectedValueOnce(new Error('market temporarily unavailable'))
        await service.refreshPurchasedOrderAdapters()
        await vi.waitFor(() =>{  expect(snapshots.at(-1)).toBe(false) }, { timeout: 10_000 })
        const before = snapshots.length
        await service.tick()
        expect(snapshots).toHaveLength(before)
        offset = 60_000
        await service.tick()
        await vi.waitFor(() =>{  expect(snapshots.at(-1)).toBe(true) }, { timeout: 10_000 })
        expect(verifyInstalled).toHaveBeenCalledTimes(3)
        await service.stop('case teardown')
      } finally { nowSpy.mockRestore(); await server.close() }
    })

  it.each([
    [{ mode: 'idle', minIdleSeconds: Number.MAX_SAFE_INTEGER }, 'USER_ACTIVE'],
    [{ mode: 'allowed', minFreeMemoryBytes: Number.MAX_SAFE_INTEGER }, 'MEMORY_LIMIT'],
    // 当前桌面策略的精确形状：总开关处于 idle，但没有一项本机执行服务获准接单。
    [{ mode: 'idle', enabledServiceIds: [] }, 'NO_AUTHORIZED_SERVICE'],
    [{ mode: 'allowed', enabledServiceIds: [] }, 'NO_AUTHORIZED_SERVICE'],
  ] as const)('refuses forced Edge assignments under saved owner restrictions %j', { timeout: 30_000 }, async (saved, reason) => {
    const { server, ctx, store } = await mountOwnerSwitch(async () => saved)
    try {
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      service.setPanelAccepting(true)
      await service.start()
      await service.tick()
      expect(service.status()).toMatchObject({ intake: 'paused', intakeReason: 'owner-policy-blocked' })
      // Unsupported idle probes are explicitly unknown and refuse the same assignment.
      const reasons = service.status().intakeReasons
      expect(reasons.includes(reason) || (reason === 'USER_ACTIVE' && reasons.includes('IDLE_STATE_UNKNOWN'))).toBe(true)
      await vi.waitFor(() => { expect(server.frames.some(frame => frame.type === 'shard_result')).toBe(true) })
      expect(server.frames.filter(frame => frame.type === 'hb').at(-1)?.payload).toMatchObject({ mode: 'paused' })
      expect(server.frames.find(frame => frame.type === 'shard_result')?.payload).toMatchObject({ ok: false, failure_class: 'EDGE_SUPPLY_WITHDRAWN' })
      await expect(readFile(store, 'utf8')).rejects.toThrow()
      await service.stop('case teardown')
    } finally { await server.close() }
  })

  it.each(['missing', 'invalid', 'unreadable'] as const)('keeps registration and heartbeats but refuses new work for %s owner policy', { timeout: 30_000 }, async (kind) => {
    const read = kind === 'missing' ? undefined : kind === 'invalid' ? async () => ({ mode: 'on' })
      : async (): Promise<{ mode?: unknown }> => { throw new Error('policy storage unavailable') }
    const { server, ctx, store } = await mountOwnerSwitch(read)
    try {
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      expect(service.status()).toMatchObject({ intake: 'paused', intakeReason: 'policy-unavailable' })
      await service.start()
      await vi.waitFor(() => { expect(server.frames.some(frame => frame.type === 'hb')).toBe(true) })
      const beforeTick = server.frames.filter(frame => frame.type === 'hb').length
      await service.tick()
      expect(service.status()).toMatchObject({ intake: 'paused', intakeReason: 'policy-unavailable' })
      await vi.waitFor(() => { expect(server.frames.filter(frame => frame.type === 'hb').length).toBeGreaterThan(beforeTick) })
      await vi.waitFor(() => { expect(server.frames.some(frame => frame.type === 'shard_result')).toBe(true) })
      expect(server.frames.some(frame => frame.type === 'auth')).toBe(true)
      expect(server.frames.filter(frame => frame.type === 'hb').at(-1)?.payload).toMatchObject({ mode: 'paused' })
      expect(server.frames.find(frame => frame.type === 'shard_result')?.payload).toMatchObject({ ok: false, failure_class: 'EDGE_SUPPLY_WITHDRAWN' })
      await expect(readFile(store, 'utf8')).rejects.toThrow()
      await service.stop('case teardown')
    } finally { await server.close() }
  })

  it.each(['voice', 'foreground'] as const)('withdraws buffered work and keeps heartbeats after the %s producer fails', { timeout: 30_000 }, async (producer) => {
    const { server, ctx, store } = await mountOwnerSwitch('allowed')
    try {
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      await service.start()
      await service.tick()
      await vi.waitFor(() => { expect(service.status().resident?.pendingOffers).toBeGreaterThan(0) })
      if (producer === 'voice') vi.spyOn(ctx.get('voiceActivity')!, 'active').mockImplementation(() => { throw new Error('voice failed') })
      else vi.spyOn(ctx.get('agents')!, 'list').mockImplementation(() => { throw new Error('registry failed') })
      const heartbeatCount = server.frames.filter(frame => frame.type === 'hb').length
      await service.tick()
      expect(service.status()).toMatchObject({ intake: 'paused', intakeReason: 'owner-policy-blocked', resident: { inFlight: 0, runs: 2 } })
      expect(service.status().intakeReasons).toContain(producer === 'voice' ? 'VOICE_ACTIVITY_UNKNOWN' : 'HOST_ACTIVITY_UNKNOWN')
      await vi.waitFor(() => { expect(server.frames.filter(frame => frame.type === 'hb').length).toBeGreaterThan(heartbeatCount) })
      expect(server.frames.filter(frame => frame.type === 'hb').at(-1)?.payload).toMatchObject({ mode: 'paused' })
      await expect(readFile(store, 'utf8')).rejects.toThrow()
      await service.stop('case teardown')
    } finally { await server.close() }
  })

  it('withdraws buffered admission on a failed policy read and restores the saved authorization after recovery', { timeout: 30_000 }, async () => {
    let readable = true
    const { server, ctx, store } = await mountOwnerSwitch(async () => {
      if (!readable) throw new Error('policy read failed')
      return { mode: 'allowed' }
    })
    try {
      const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
      await service.start()
      await service.tick()
      await vi.waitFor(() => { expect(service.status().resident?.pendingOffers).toBeGreaterThan(0) })
      readable = false
      await service.tick()
      expect(service.status()).toMatchObject({ intake: 'paused', intakeReason: 'policy-unavailable', resident: { inFlight: 0, runs: 2 } })
      await vi.waitFor(() => { expect(server.frames.some(frame => frame.type === 'shard_result' && frame.payload.failure_class === 'EDGE_ADMISSION_REFUSED')).toBe(true) })
      await expect(readFile(store, 'utf8')).rejects.toThrow()
      readable = true
      await service.tick()
      expect(service.status()).toMatchObject({ intake: 'running', intakeReason: 'owner-authorized', resident: { runs: 3 } })
      await vi.waitFor(() => { expect(server.frames.filter(frame => frame.type === 'hb').at(-1)?.payload).toMatchObject({ mode: 'running' }) })
      await service.stop('case teardown')
    } finally { await server.close() }
  })
})

async function mountApply(
  config: Config,
  extras: {
    computeCore?: object
    accountSession?: object
    credentials?: object
    qianshouPluginCatalog?: object
    qianshouReviewedVideoHost?: object
    qianshouReviewedVideoHostProvision?: object
  } = {},
): Promise<Context> {
  const root = await scratch('qianshou-contributor-apply-')
  const storePath = config.storePath ?? join(root, 'node-tasks.json')
  const workspaceRoot = config.workspaceRoot === undefined ? join(root, 'attempts') : config.workspaceRoot
  const ctx = new Context()
  context = ctx
  if (extras.qianshouReviewedVideoHost !== undefined) {
    await ctx.plugin({ name: 'reviewed-video-host-fixture', apply(scope) {
      scope.provide('qianshouReviewedVideoHost', extras.qianshouReviewedVideoHost)
    } })
  }
  if (extras.qianshouReviewedVideoHostProvision !== undefined) {
    await ctx.plugin({ name: 'reviewed-video-provision-fixture', apply(scope) {
      scope.provide('qianshouReviewedVideoHostProvision', extras.qianshouReviewedVideoHostProvision)
    } })
  }
  await ctx.plugin({
    name: 'contributor-apply-harness',
    apply(scope) {
      scope.provide('connection', {
        fetch: { register: () => async () => undefined },
      })
      if (extras.computeCore !== undefined) scope.provide('computeCore', extras.computeCore)
      if (extras.accountSession !== undefined) scope.provide('accountSession', extras.accountSession)
      if (extras.credentials !== undefined) scope.provide('credentials', extras.credentials)
      if (extras.qianshouPluginCatalog !== undefined) {
        scope.provide('qianshouPluginCatalog', extras.qianshouPluginCatalog)
      }
      scope.provide('voiceActivity', { active: () => false, subscribe: () => () => undefined })
      scope.provide('agents', { list: () => [] })
      apply(scope, { ...config, storePath, workspaceRoot })
    },
  })
  return ctx
}

async function startEdge(extras: { computeCore?: object; accountSession?: object }): Promise<unknown> {
  const ctx = await mountApply({
    mode: 'BACKGROUND_ONLY',
    allowedTaskTypes: ['word_count'],
  }, extras)
  const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
  return service.start()
}


/**
 * AT-10 的"常量假值不得回归"：光靠行为测试不够——把两个常量写回去，行为测试在一台"没人用"的
 * 机器上仍然会绿。所以一条审源码、一条审真实读数，任一条回来都会红。
 */
describe('host activity is measured, never hardcoded', () => {
  it('never answers the activity question with a constant false', async () => {
    const source = await readFile(new URL('../src/resident-assembly.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('readUserActivity: () => false')
    expect(source).not.toContain('readVoiceActivity: () => false')
    // 读数来自绑定的端口，且 null（测不到）必须原样传下去。
    expect(source).toContain('activityPort.read()')
    expect(source).toContain('return lastActivity.userActive')
  })

  it('binds a real activity port and reports its state in the node projection', { timeout: 60_000 }, async () => {
    // `allowedTaskTypes: []` 保持内存连接（本用例只看投影，不开 socket）；活动端口与传输无关，照样绑。
    const ctx = await mountContributor([], { autoStart: false, allowWhileUserActive: true, allowedTaskTypes: [] })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    await service.start()
    await service.tick()
    const activity = (service.status() as unknown as { resident: { hostActivity: Record<string, unknown> } }).resident.hostActivity
    // 可测 ⇒ measured=true 且给布尔；不可测 ⇒ 必须是显式"未知"，**不是 false**。
    if (idleCommandFor(process.platform) === null) {
      expect(activity).toMatchObject({ measured: true, userActive: null, unavailable: 'IDLE_PROBE_UNSUPPORTED', policyEnforceable: false })
    } else {
      expect(typeof activity.userActive).toBe('boolean')
      expect(activity.measured).toBe(true)
      expect(activity.policyEnforceable).toBe(true)
      const idleSeconds = activity.idleSeconds as number | null
      if (idleSeconds !== null) expect(Number.isFinite(idleSeconds)).toBe(true)
    }
  })
})

function jwt(payload: { sub: string; exp: number }): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.sig`
}
