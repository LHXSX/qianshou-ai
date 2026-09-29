/** Owner-authenticated mobile sync: durable per-identity cursors and revisions over the Connection carrier. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { MobileSyncStore } from './store.ts'
import { MobileSyncService } from './service.ts'
import { registerRoutes } from './routes.ts'
import {
  PcWindowGateway as Gateway, PcWindowStore, createPairingTickets, createSessionCommandPort, registerGatewayRoutes,
  type PreparedSessionController,
} from './gateway/index.ts'

export { MobileSyncService, cursorAt, cursorRevision, type MobileSyncOutcome, type MobileSyncResult, type MobileSyncServiceOptions } from './service.ts'
export { MobileSyncStore, identityKey, type MobileSyncStoreConfig } from './store.ts'
export { MobileSyncError, type MobileSyncErrorCode } from './errors.ts'
export { registerRoutes } from './routes.ts'
export type { MobileSyncEntry, MobileSyncFile, MobileSyncRecord } from './types.ts'
export { MOBILE_SYNC_INITIAL_CURSOR, MOBILE_SYNC_STORE_VERSION } from './types.ts'
// ── PC session gateway (P0-4) ──────────────────────────────────────────────
// One re-export surface for the gateway, so the host route wiring below and any
// external consumer name the same module instance.
export * from './gateway/index.ts'

/** Deployment-owned storage and request bounds. */
export interface Config {
  /** Absolute private sync-state path; empty uses the DSH_HOME qianshou default. */
  statePath?: string
  /** Maximum retained participant records. */
  maxRecords?: number
  /** Maximum accepted store size in bytes. */
  maxStoreBytes?: number
  /** Maximum bytes admitted by the sync route. */
  maxRequestBytes?: number
  /** How long a participant may resume from an issued cursor, in milliseconds. */
  cursorMaxAgeMs?: number
  /** Absolute private PC-window command log; empty uses the DSH_HOME qianshou default. */
  pcWindowPath?: string
  /** 这台电脑在绑定里的稳定标识；省略时用主机名。 */
  pcId?: string
  /** 引导时写进绑定的会话 id；省略时引导以「没有会话」拒绝。 */
  sessionId?: string
  /** Maximum host-authorized phone origins the gateway retains. */
  maxBindings?: number
  /** Maximum command records the gateway retains. */
  maxCommands?: number
  /** Maximum accepted PC-window command file size in bytes. */
  maxWindowStoreBytes?: number
}

/** Runtime-validated request and storage limits. */
export const Config: z<Config> = z.object({
  statePath: z.string().default(''),
  maxRecords: z.number().step(1).min(1).max(100000).default(10000),
  maxStoreBytes: z.number().step(1).min(65536).max(33554432).default(4194304),
  maxRequestBytes: z.number().step(1).min(4096).max(131072).default(65536),
  cursorMaxAgeMs: z.number().step(1).min(60000).max(2592000000).default(86400000),
  pcWindowPath: z.string().default(''),
  pcId: z.string().default(''),
  sessionId: z.string().default(''),
  maxBindings: z.number().step(1).min(1).max(100000).default(10000),
  maxCommands: z.number().step(1).min(1).max(1000000).default(100000),
  maxWindowStoreBytes: z.number().step(1).min(65536).max(67108864).default(8388608),
})

/** Cordis plugin identity. */
export const name = 'qianshou-mobile-sync'

/** Both routes are mounted on the existing authenticated owner connection. */
export const inject = ['connection']

/** Install the durable mobile sync surface without opening a listening port.
 *
 * This plugin publishes cursor and revision state, and admits phone commands to an
 * already-existing Host Session through that Session's own public methods. It does
 * not relay media, open a push channel or move money, and it does not widen the
 * carrier's Host fence — LAN reachability stays a deployment decision.
 *
 * `session-controller` is deliberately absent from `inject`: profiles that do not
 * mount it still serve sync, and the gateway reports `unavailable` rather than
 * fabricating an admission it cannot perform.
 * @param ctx - Host scope providing the existing authenticated carrier.
 * @param config - Deployment-owned private paths and bounds.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
  const statePath = config.statePath || join(home, 'qianshou', 'mobile-sync.json')
  if (!isAbsolute(statePath)) throw new Error('MOBILE_SYNC_STATE_PATH_MUST_BE_ABSOLUTE')
  const store = new MobileSyncStore({
    path: statePath,
    maxRecords: config.maxRecords ?? 10000,
    maxBytes: config.maxStoreBytes ?? 4194304,
  })
  const service = new MobileSyncService(store, {
    ...(config.cursorMaxAgeMs === undefined ? {} : { cursorMaxAgeMs: config.cursorMaxAgeMs }),
  })
  ctx.provide('mobileSync', service)
  ctx.effect(() => () => { service.close(); void store.close() }, 'mobile-sync: drain durable writes')
  registerRoutes(ctx, service, config.maxRequestBytes ?? 65536)

  const windowPath = config.pcWindowPath || join(home, 'qianshou', 'pc-window.json')
  if (!isAbsolute(windowPath)) throw new Error('PC_WINDOW_STATE_PATH_MUST_BE_ABSOLUTE')
  const windowStore = new PcWindowStore({
    path: windowPath,
    maxBindings: config.maxBindings ?? 10000,
    maxCommands: config.maxCommands ?? 100000,
    maxBytes: config.maxWindowStoreBytes ?? 8388608,
  })
  const gateway = new Gateway(windowStore, createSessionCommandPort({
    // Resolved per call so the gateway never pins a controller that a later plugin
    // order change replaced, and so an unmounted controller stays merely absent.
    controller: () => sessionControllerOf(ctx),
  }))
  ctx.provide('pcWindowGateway', gateway)
  ctx.effect(() => () => { gateway.close(); void windowStore.close() }, 'mobile-sync: drain pc-window writes')
  /**
   * 配对票据：引导路由的闸门。由人在电脑上发起（显示成二维码），手机凭票换取绑定。
   *
   * 放在这里而不是路由内部：票据要跨请求存活（签发一次、兑换一次），而且界面那边
   * 需要独立拿到当前票据好画二维码，所以由插件持有。
   */
  const tickets = createPairingTickets()
  ctx.provide('pcWindowPairing', tickets)
  registerGatewayRoutes(ctx, gateway, config.maxRequestBytes ?? 65536, {
    redeem: (ticket, source) => tickets.redeem(ticket, source),
    // 身份对齐：绑定的 accountId 取**真实登录账号**。账号面没挂载、或还没登录时返回 null，
    // 引导会以 401 拒绝——没有一个可授权的身份就不该发绑定。
    accountId: async () => {
      const session = accountSessionOf(ctx)
      const account = await session?.account?.()
      return account === null || account === undefined ? null : String(account.id)
    },
    pcId: () => (config.pcId !== undefined && config.pcId.length > 0 ? config.pcId : hostname()),
    // 会话来源：先用配置（部署方指定这台电脑要继续哪个会话），控制器里的取法需要先核实契约。
    sessionId: () => (config.sessionId !== undefined && config.sessionId.length > 0 ? config.sessionId : null),
  })
}

/** 读取宿主账号会话（账号面是可选插件，没挂载时返回 undefined）。 */
function accountSessionOf(ctx: Context): { readonly account?: () => Promise<{ readonly id: number | string } | null> } | undefined {
  return ctx.get('accountSession') as { readonly account?: () => Promise<{ readonly id: number | string } | null> } | undefined
}

/** Read the optional Session authority without requiring the profile to mount it. */
function sessionControllerOf(ctx: Context): PreparedSessionController | undefined {
  const controller: unknown = ctx.get('sessionController')
  return controller === undefined ? undefined : controller as PreparedSessionController
}
