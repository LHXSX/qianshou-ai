/**
 * 账户卡的读状态机。
 *
 * 设计取舍只有三条，都是被界面需求逼出来的：
 *
 * 1. **两条路由分两次读，成功各自落地**。额度读不回来时"你已登录"仍然显示——
 *    这正是最需要它的时候（网关挂了不等于你没登录）。
 * 2. **失败要分类，不能都说"出错"**。`unavailable`（读不到）与 `anonymous`（没登录）
 *    在界面上导向相反的动作：前者让用户稍后再试，后者让用户去登录。
 *    把两者混成一个"失败"会让已登录的人跑去重新登录。
 * 3. **短 TTL + 单飞**。账户卡挂在侧栏上，任何一次重渲染都可能触发读取；
 *    没有 TTL 会把它变成打自己后端的轮询器。但**手动刷新必须真的刷新**，
 *    所以 `refresh({ force: true })` 绕过 TTL——用户点了就去读，不等缓存。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ACCOUNT_STATE_PATH, AI_STATUS_PATH, READY_TTL_MS, UNAVAILABLE_RETRY_MS, readRequest } from './endpoints.ts'
import {
  parseAccountState, parseGatewayStatus,
  type AccountFacts, type GatewayFacts,
} from './status.ts'

/** 两个独立事实各自的可用性。 */
export type FactPhase = 'idle' | 'loading' | 'ready' | 'anonymous' | 'unavailable'

/**
 * 账户卡要显示的全部内容。
 *
 * 字段刻意**不用 `readonly`**：`createSnapshotStore().update()` 走 immer draft，
 * 只读标记会让 draft 赋值在类型上失败。这与仓库既有范式一致
 * （见 `ui-settings-routing/src/client/controller.ts` 的 `RouteConsoleState`）：
 * 顶层字段可变、嵌套值只读。
 */
export interface AccountView {
  /** 账号会话侧的事实。 */
  accountPhase: FactPhase
  account: AccountFacts | null
  /** 订阅网关侧的事实。 */
  gatewayPhase: FactPhase
  gateway: GatewayFacts | null
  /** 网关拒绝的原因原话（服务端中文），用于在卡上给可行动提示。 */
  gatewayMessage: string | null
  /** 最近一次成功的读取时刻（毫秒）；从未成功过就是 `null`。 */
  readAt: number | null
}

/** 初始状态：什么都还不知道，而且**不假装**知道。 */
export function initialAccountView(): AccountView {
  return {
    accountPhase: 'idle',
    account: null,
    gatewayPhase: 'idle',
    gateway: null,
    gatewayMessage: null,
    readAt: null,
  }
}

/** 从服务端错误正文里取中文原话；取不到就返回 `null`。 */
async function messageOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return null
    const root = body as { message?: unknown; error?: { message?: unknown } }
    const text = root.message ?? root.error?.message
    return typeof text === 'string' && text.length > 0 ? text : null
  } catch {
    return null
  }
}

/** 读取账户会话；任何异常都折叠成 `unavailable`，不抛出。 */
export async function readAccountState(signal: AbortSignal): Promise<AccountFacts | 'anonymous' | 'unavailable'> {
  try {
    const response = await readRequest(ACCOUNT_STATE_PATH, signal)
    if (!response.ok) return 'unavailable'
    const facts = parseAccountState(await response.json())
    if (facts.state === 'authenticated') return facts.account
    return facts.state === 'anonymous' ? 'anonymous' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** 一次额度读取的结果：成功带事实，被拒带原因，读不到两者皆无。 */
export interface GatewayRead {
  readonly kind: 'ok' | 'rejected' | 'unavailable'
  readonly facts: GatewayFacts | null
  readonly message: string | null
}

/** 读取额度；同样不抛出。 */
export async function readGateway(signal: AbortSignal): Promise<GatewayRead> {
  try {
    const response = await readRequest(AI_STATUS_PATH, signal)
    if (response.ok) {
      const facts = parseGatewayStatus(await response.json())
      return facts === null
        ? { kind: 'unavailable', facts: null, message: null }
        : { kind: 'ok', facts, message: null }
    }
    // 401/402/403 这类是**服务端有话说**，原话照抄给用户。
    return { kind: 'rejected', facts: null, message: await messageOf(response) }
  } catch {
    return { kind: 'unavailable', facts: null, message: null }
  }
}

/** 构造参数：传输与时钟可注入，单测因此不需要浏览器也不需要真服务。 */
export interface AccountViewConfig {
  /** 覆盖读取实现（测试用）。 */
  readonly readAccount?: (signal: AbortSignal) => Promise<AccountFacts | 'anonymous' | 'unavailable'>
  /** 覆盖额度读取（测试用）。 */
  readonly readGateway?: (signal: AbortSignal) => Promise<GatewayRead>
  /** 覆盖时钟（测试用）。 */
  readonly now?: () => number
}

/**
 * 账户视图的服务。侧栏卡片与个人中心页**共用同一个实例**，
 * 所以两处显示的额度永远一致——不会出现侧栏说 389、页面说 385。
 */
export class AccountViewService {
  readonly store = createSnapshotStore<AccountView>(initialAccountView())
  private readonly abort = new AbortController()
  private readonly now: () => number
  private readonly readAccount: (signal: AbortSignal) => Promise<AccountFacts | 'anonymous' | 'unavailable'>
  private readonly readGateway: (signal: AbortSignal) => Promise<GatewayRead>
  private inFlight: Promise<void> | null = null
  private lastAt = 0
  private lastGatewayFailed = false

  constructor(config: AccountViewConfig = {}) {
    this.now = config.now ?? (() => Date.now())
    this.readAccount = config.readAccount ?? readAccountState
    this.readGateway = config.readGateway ?? readGateway
  }

  /**
   * 读一次。短 TTL 内的重复调用直接复用上一次结果。
   * @param opts - `force` 绕过节流（用户手动刷新时用）。
   * @returns 读完的 Promise；并发调用共享同一次往返。
   */
  refresh(opts: { readonly force?: boolean } = {}): Promise<void> {
    if (this.inFlight !== null) return this.inFlight
    const ttl = this.lastGatewayFailed ? UNAVAILABLE_RETRY_MS : READY_TTL_MS
    if (opts.force !== true && this.lastAt !== 0 && this.now() - this.lastAt < ttl) return Promise.resolve()
    this.inFlight = this.run().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  /** 真的去读两条路由，各自落地。 */
  private async run(): Promise<void> {
    const signal = this.abort.signal
    const [account, gateway] = await Promise.all([this.readAccount(signal), this.readGateway(signal)])
    if (signal.aborted) return
    this.lastAt = this.now()
    this.lastGatewayFailed = gateway.kind !== 'ok'
    this.store.update((draft) => {
      draft.accountPhase = account === 'unavailable' ? 'unavailable' : account === 'anonymous' ? 'anonymous' : 'ready'
      draft.account = account === 'unavailable' || account === 'anonymous' ? null : account
      draft.gatewayPhase = gateway.kind === 'ok' ? 'ready' : gateway.kind === 'rejected' ? 'anonymous' : 'unavailable'
      draft.gateway = gateway.facts
      draft.gatewayMessage = gateway.message
      if (gateway.kind === 'ok') draft.readAt = this.now()
    })
  }

  /** 释放：中止在途请求，避免插件卸载后回调还写 store。 */
  dispose(): void {
    this.abort.abort()
  }
}
