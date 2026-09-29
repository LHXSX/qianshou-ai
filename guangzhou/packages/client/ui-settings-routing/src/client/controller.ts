/**
 * 控制台的请求层：一次目录读取 + 一次绑定追加，状态如实呈现。
 *
 * 为什么把状态码分开表达：401 是「没登录或登录失效」，403 是「登录了但不是管理员」，
 * 400 + 中文原因才是「你的这次追加被拒了」。把它们统一成「网络错误」，
 * 管理员会去查网络，而真正要做的是去登录或换个账号。
 * 服务端给的中文原因是**可行动信息**，原样带上去，不用泛化文案覆盖。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RoutingKey } from './locales.ts'
import {
  ADMIN_BIND_PATH, ADMIN_NAMES_PATH, INVALID_ROUTE_RESPONSE, bindFailure, historyOf, latestBindingAt,
  parseBinding, parseRouteCatalog, serverMessage,
  type BackendBinding, type BindRequestPayload, type RouteCatalog,
} from './route-catalog.ts'

/** 一条失败的可展示形态：分类、服务端原话，以及回退文案的键。 */
export interface RouteFailure {
  readonly kind: string
  /** 服务端给的原因（原样）；本地失败时可能是空串。 */
  readonly message: string
  /** 没有服务端原因时显示的本地文案键。 */
  readonly key: RoutingKey
}

/** 控制台的发布状态。 */
export interface RouteConsoleState {
  /** 已校验的目录；读取失败或被拒时为 `null`（不保留过期目录当有效事实）。 */
  catalog: RouteCatalog | null
  loading: boolean
  submitting: boolean
  /** 读取目录的失败（含未登录/非管理员）。 */
  readError: RouteFailure | null
  /** 追加失败的失败（服务端中文原因照抄）。 */
  bindError: RouteFailure | null
  /** 最近一次追加后的完整历史（服务端回读，用于当场核对）。 */
  lastAppended: { readonly publishedName: string; readonly history: readonly BackendBinding[] } | null
}

/** 页面渲染需要的初始状态。 */
function initialState(): RouteConsoleState {
  return { catalog: null, loading: true, submitting: false, readError: null, bindError: null, lastAppended: null }
}

/**
 * 一个控制台会话：读取目录、追加绑定。
 *
 * 传输层是构造参数（默认 `globalThis.fetch`），所以单测直接注入假 fetch，
 * 不需要浏览器，也不需要真的宿主。
 */
export class RouteConsoleController {
  /** 插槽渲染器绑定成 `useCatalog` 的快照源。 */
  readonly store = createSnapshotStore<RouteConsoleState>(initialState())
  private readonly abort = new AbortController()
  private generation = 0
  private readPending = false

  constructor(private readonly transport: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  /** 这次追加会被服务端拒绝的最晚时刻（同名字上一条绑定）；没有绑定时为 `null`。 */
  appendFloor(publishedName: string): number | null {
    const catalog = this.store.getSnapshot().catalog
    return catalog === null ? null : latestBindingAt(historyOf(catalog, publishedName))
  }

  /** 读取目录与可选后端。失败时清空目录——过期目录不是有效事实。 */
  async refresh(): Promise<void> {
    if (this.readPending || this.abort.signal.aborted || this.store.getSnapshot().submitting) return
    this.readPending = true
    const generation = ++this.generation
    this.store.update((state) => { state.loading = true; state.readError = null })
    try {
      const payload = await this.request(ADMIN_NAMES_PATH, undefined)
      const catalog = parseRouteCatalog(payload)
      if (this.stale(generation)) return
      this.store.update((state) => { state.catalog = catalog; state.loading = false })
    } catch (error) {
      if (this.stale(generation)) return
      const failure = this.classify(error, 'read')
      this.store.update((state) => { state.catalog = null; state.loading = false; state.readError = failure })
    } finally {
      this.readPending = false
    }
  }

  /**
   * 追加一条未来生效的绑定。**入参必须已经通过 {@link validateBindRequest}**：
   * 这里只做请求与状态发布，不重复解释规则。
   * @param request - 已校验的请求体。
   * @returns 服务端是否接受。
   */
  async bind(request: BindRequestPayload): Promise<boolean> {
    if (this.store.getSnapshot().submitting || this.abort.signal.aborted) return false
    this.store.update((state) => { state.submitting = true; state.bindError = null; state.lastAppended = null })
    try {
      const payload = await this.request(ADMIN_BIND_PATH, request)
      if (this.abort.signal.aborted) return false
      const history = this.history(payload)
      this.store.update((state) => {
        state.submitting = false
        state.lastAppended = { publishedName: request.publishedName, history }
      })
      // 回读全量目录：追加会钉住上一条的失效时刻，界面必须显示真实结果而不是本地推测。
      await this.refreshAfterAppend()
      return true
    } catch (error) {
      const failure = this.classify(error, 'bind')
      this.store.update((state) => { state.submitting = false; state.bindError = failure })
      return false
    }
  }

  /** 丢掉快照与进行中的请求（插件卸载时调用）。 */
  dispose(): void {
    this.generation += 1
    this.abort.abort()
  }

  /** 追加成功后重新读目录；失败只记在读取错误上，不抹掉刚才的成功。 */
  private async refreshAfterAppend(): Promise<void> {
    try {
      const catalog = parseRouteCatalog(await this.request(ADMIN_NAMES_PATH, undefined))
      if (this.abort.signal.aborted) return
      this.store.update((state) => { state.catalog = catalog; state.loading = false })
    } catch (error) {
      if (this.abort.signal.aborted) return
      this.store.update((state) => { state.readError = this.classify(error, 'read') })
    }
  }

  /** 追加响应里的历史；形状不认识时留空，界面不推测。 */
  private history(payload: unknown): readonly BackendBinding[] {
    if (typeof payload !== 'object' || payload === null) return []
    const history = (payload as Record<string, unknown>)['history']
    if (!Array.isArray(history)) return []
    try {
      return history.map(parseBinding).sort((left, right) => left.effectiveFrom - right.effectiveFrom)
    } catch { return [] }
  }

  /** 一次 POST 往返；非 2xx 或非 JSON 都抛出去交给分类器。 */
  private async request(path: string, body: BindRequestPayload | undefined): Promise<unknown> {
    const response = await this.transport(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: this.abort.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    let payload: unknown
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok) throw new ResponseFailure(response.status, payload)
    return payload
  }

  /** 分类一个失败：状态码优先，其次才是服务端说明。 */
  private classify(error: unknown, phase: 'read' | 'bind'): RouteFailure {
    const key: RoutingKey = phase === 'read' ? 'requestFailed' : 'serverRejected'
    if (error instanceof ResponseFailure) {
      const failure = bindFailure(error.status, error.payload)
      if (failure.kind === 'not-signed-in') return { kind: 'not-signed-in', message: failure.message, key: 'notSignedIn' }
      if (failure.kind === 'forbidden') return { kind: 'forbidden', message: failure.message, key: 'forbidden' }
      return { kind: failure.kind, message: failure.message, key }
    }
    if (error instanceof Error && error.message === INVALID_ROUTE_RESPONSE) {
      return { kind: INVALID_ROUTE_RESPONSE, message: '', key: 'invalidResponse' }
    }
    return {
      kind: 'request-failed',
      message: error instanceof Error ? error.message : '',
      key: 'requestFailed',
    }
  }

  private stale(generation: number): boolean {
    return this.abort.signal.aborted || generation !== this.generation
  }
}

/** 非 2xx 响应：把状态码和已解析的响应体一起带出请求层。 */
class ResponseFailure extends Error {
  constructor(readonly status: number, readonly payload: unknown) {
    super(serverMessage(payload) ?? `HTTP_${status}`)
  }
}
