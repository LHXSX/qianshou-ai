/**
 * Host half of the Qianshou presentation plugin: the local compute-node relay.
 *
 * The window's specialist accepts assignments. This plugin does not start the
 * builtin word-count process. `/status` and `/power` stay in this process.
 * The access credential is read from storage and is not refreshed.
 */
import type { Context } from '@deepseek-ai/cordis'
import { agentAcceptSnapshot } from './relay/agent-status.ts'
import { loadHostRuntime, modulePathFromUrl, type HostNodeProcess } from './relay/host-runtime.ts'
import { ownerIdFromAccessToken } from './relay/node-session.ts'
import { createNodeRelay, NODE_RELAY_PREFIX, resolveNodeRelayConfig, type NodePowerRelayView, type RelayRoute } from './relay/node-relay.ts'
import { communityRoutes, type CommunityAccountSession } from './relay/community-relay.ts'
import { resultMediaRoutes } from './relay/result-media-relay.ts'
import { resultFileRoutes } from './relay/result-file-relay.ts'

interface HostScope {
  effect(fn: () => (() => void) | void, label: string): void
  webServer: { register(route: RelayRoute): () => void }
  credentials: { resolve(ref: string): Promise<{ value: string } | undefined> }
  qianshouAccount: { state(): Promise<{ phase: string; account: { id: string } | null }> }
}

interface CommunityHostScope {
  effect(fn: () => (() => Promise<void>) | void, label: string): void
  connection: { fetch: { register(route: ReturnType<typeof communityRoutes>[number]
    | ReturnType<typeof resultMediaRoutes>[number]): () => Promise<void> } }
  accountSession: CommunityAccountSession
}

interface FileHostScope extends CommunityHostScope {
  qianshouAccount: HostScope['qianshouAccount']
}

interface AgentNode {
  status(): {
    intake: 'running' | 'paused'
    intakeReason: string
    intakeReasons: readonly string[]
    driver: 'idle' | 'running'
    resident: {
      running: readonly {
        taskId: string
        attempt: number
        taskType: string
        progress: number
        progressEvents: number
        startedAt: string
      }[]
    } | null
  }
  acknowledgedWorkerId(): string | null
  setPanelAccepting(on: boolean): void
}

const ACCESS_REF = 'QIANSHOU_ACCOUNT_ACCESS_TOKEN'
const DEFAULT_CORE = 'https://qianshousuanli.com'
const NO_SESSION = 'NODE_SWITCH_NO_SESSION'
const NO_AGENT = 'NODE_AGENT_UNAVAILABLE'

/**
 * Register the same-origin relay when the Qianshou product profile is active.
 * A stored unexpired access credential identifies the owner. Taking work still
 * requires the owner's saved supply policy and local admission checks.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou') return
  const startedAtMs = Date.now()
  let pid = 0
  let accessScope: HostScope | null = null
  const currentAccess = async (): Promise<{ ownerId: number | null; code?: string }> => {
    return accessScope === null ? { ownerId: null, code: NO_SESSION } : readAccess(accessScope)
  }
  const node = (): AgentNode | null => {
    const found = (ctx as { get?: (name: string) => AgentNode | undefined }).get?.('nodeContributor')
    return found ?? null
  }
  const relay = createNodeRelay({
    ...resolveNodeRelayConfig(),
    agentStatus: async () => {
      const access = await currentAccess()
      const service = node()
      if (service === null) return { ok: false, code: NO_AGENT }
      const status = service.status()
      return agentAcceptSnapshot({
        pid,
        startedAtMs,
        nowMs: Date.now(),
        intake: status.intake,
        intakeReason: status.intakeReason,
        intakeReasons: status.intakeReasons,
        driver: status.driver,
        workerId: service.acknowledgedWorkerId(),
        ownerId: access.ownerId,
        core: DEFAULT_CORE,
        running: status.resident?.running ?? [],
      })
    },
    power: {
      view: async () => powerView(node(), (await currentAccess()).code),
      set: async on => setPower(node(), on, (await currentAccess()).code),
    },
  })
  const host = ctx as unknown as { inject(names: readonly string[], plugin: (scope: HostScope) => void): void }
  ;(ctx as unknown as { inject(names: readonly string[], plugin: (scope: CommunityHostScope) => void): void })
    .inject(['connection', 'accountSession'], scope => {
      for (const route of communityRoutes(scope.accountSession)) {
        scope.effect(() => scope.connection.fetch.register(route), `qianshou: ${route.path}`)
      }
      for (const route of resultMediaRoutes(scope.accountSession)) {
        scope.effect(() => scope.connection.fetch.register(route), `qianshou: ${route.path}`)
      }
    })
  ;(ctx as unknown as { inject(names: readonly string[], plugin: (scope: FileHostScope) => void): void })
    .inject(['connection', 'accountSession', 'qianshouAccount'], scope => {
      const accountIdOf = async (): Promise<number | null> => {
        const state = await scope.qianshouAccount.state()
        const value = ['authenticated', 'refreshing'].includes(state.phase) ? state.account?.id : null
        if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) return null
        const id = Number(value)
        return Number.isSafeInteger(id) ? id : null
      }
      for (const route of resultFileRoutes(scope.accountSession, { accountIdOf })) {
        scope.effect(() => scope.connection.fetch.register(route), `qianshou: ${route.path}`)
      }
    })
  host.inject(['webServer', 'credentials', 'qianshouAccount'], scope => {
    scope.effect(() => {
      accessScope = scope
      const dispose = scope.webServer.register({
        kind: 'prefix',
        path: NODE_RELAY_PREFIX,
        handler: (request, response) => { void relay.handle(request, response) },
      })
      void boot().then(runtime => {
        pid = runtime?.pid ?? pid
      }).catch(() => undefined)
      return () => {
        // Only this relay is going away. The resident worker follows the saved
        // owner policy, so a renderer/Host plugin reload must not veto intake.
        if (accessScope === scope) accessScope = null
        dispose()
      }
    }, 'qianshou: compute-node relay')
  })

  async function boot(): Promise<HostNodeProcess | null> {
    let runtime: HostNodeProcess | null = null
    try {
      runtime = await loadHostRuntime(modulePathFromUrl(import.meta.url))
      const relayConfig = resolveNodeRelayConfig({
        QIANSHOU_NODE_STATUS_PORT: runtime.env('QIANSHOU_NODE_STATUS_PORT'),
      })
      const port = Number(new URL(relayConfig.upstream).port)
      await runtime.reclaim(port)
    } catch {
      // 旧的数词进程清不掉时，专员仍然可以接单。两个进程同时在线会互相踢，下一拍再清。
      runtime = null
    }
    return runtime
  }
}

function powerView(service: AgentNode | null, blocked: string | undefined): NodePowerRelayView {
  if (service === null) return { running: false, managed: false, mode: null, code: blocked ?? NO_AGENT }
  if (blocked === NO_SESSION) return { running: false, managed: true, mode: 'paused', code: NO_SESSION }
  const intake = service.status().intake
  return { running: intake === 'running', managed: true, mode: intake }
}

function setPower(service: AgentNode | null, on: boolean, blocked: string | undefined): NodePowerRelayView {
  if (service === null) return { running: false, managed: false, mode: null, code: NO_AGENT }
  if (on && blocked === NO_SESSION) return { running: false, managed: true, mode: 'paused', code: NO_SESSION }
  service.setPanelAccepting(on)
  return powerView(service, on ? undefined : blocked)
}

async function readAccess(scope: HostScope): Promise<{ ownerId: number | null; code?: string }> {
  let token = ''
  try {
    token = (await scope.credentials.resolve(ACCESS_REF))?.value ?? ''
  } catch {
    return { ownerId: null, code: NO_SESSION }
  }
  if (token === '') return { ownerId: null, code: NO_SESSION }
  const tokenOwner = ownerIdFromAccessToken(token, Date.now())
  try {
    const status = await scope.qianshouAccount.state()
    const id = status.phase === 'authenticated' ? status.account?.id : null
    if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) return { ownerId: null, code: NO_SESSION }
    const ownerId = Number(id)
    if (!Number.isSafeInteger(ownerId) || (tokenOwner !== null && tokenOwner !== ownerId)) {
      return { ownerId: null, code: NO_SESSION }
    }
    return { ownerId }
  } catch {
    return { ownerId: null, code: NO_SESSION }
  }
}
