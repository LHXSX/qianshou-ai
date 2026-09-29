/**
 * 工作台连接层：让手机端能读到用户电脑上真实的数据。
 *
 * ## 为什么需要它
 * 手机端本身是独立的（BYOK 直连模型），但**真实的会话、子智能体、命令、任务**
 * 都只存在于用户电脑上的工作台进程里。不连它，那些页面就只能是空的或编的。
 * 连上之后，这些页面显示的就是**用户自己电脑上的真实内容**。
 *
 * ## 与 BYOK 的关系（两者并存，不是二选一）
 * - **不配工作台**：手机端仍可独立对话（BYOK 直连模型），只是看不到会话与任务。
 * - **配了工作台**：额外获得真实会话列表、子智能体、命令与运行状态。
 * 连不上时界面显示空态与原因，**绝不回退到假数据**。
 *
 * ## 认证
 * 工作台用 `dsh-auth-<authority>` 形式的 cookie 鉴权。手机端让用户粘贴一条
 * **带 token 的入口地址**（工作台启动时会打印），本模块负责把它换成 cookie 并复用。
 * token 只存在用户自己的设备上。
 */

/** 一次调用失败的结构化原因。 */
export type WorkbenchFailureKind =
  | 'not-configured'
  | 'unauthorized'
  | 'unreachable'
  | 'bad-response'
  | 'failed'

/** 调用失败；`message` 是面向用户的中文说明。 */
export class WorkbenchFailure extends Error {
  /**
   * @param kind - 结构化原因。
   * @param message - 面向用户的说明。
   * @param status - HTTP 状态码（若有）。
   */
  constructor(readonly kind: WorkbenchFailureKind, message: string, readonly status?: number) {
    super(message)
    this.name = 'WorkbenchFailure'
  }
}

/** 每个原因对应的用户可见说明。 */
export const WORKBENCH_COPY: Readonly<Record<WorkbenchFailureKind, string>> = {
  'not-configured': '还没有连接电脑上的工作台。去「我的 → 连接工作台」粘贴工作台启动时打印的那条地址。',
  unauthorized: '工作台拒绝了这次访问。把工作台重启后打印的新地址重新粘贴一次（每次重启地址里的 token 会变）。',
  unreachable: '连不上电脑上的工作台。确认电脑开着、工作台在运行，并且手机与它网络可达。',
  'bad-response': '工作台返回了无法解析的内容。',
  failed: '这次请求失败了。',
}

/** 工作台连接配置。 */
export interface WorkbenchSettings {
  /** 工作台根地址，例如 `http://192.168.1.5:3091` 或隧道地址。 */
  readonly origin: string
  /** 入口 token；存下来用于在 cookie 过期后重新换取。 */
  readonly token: string
}

/** 一个会话的公开投影；字段与工作台的 `session/list` 响应一致。 */
export interface WorkbenchSession {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly cwd: string
  readonly title: string | null
}

/** 一条可选命令。 */
export interface WorkbenchCommand {
  readonly name: string
  readonly description: string
}

/** 一个子智能体条目。 */
export interface WorkbenchSubagent {
  readonly id: string
  readonly label: string
  readonly state: string
}

/**
 * 从用户粘贴的入口地址里抽出根地址与 token。
 *
 * 工作台启动时会打印 `http://127.0.0.1:3091/?token=xxxx`；用户可能连查询串一起粘贴，
 * 也可能只粘根地址。两种都要能解析。
 * @param input - 用户粘贴的原文。
 * @returns 根地址与 token；无法解析时返回 null。
 */
export function parseEntryUrl(input: string): WorkbenchSettings | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const token = url.searchParams.get('token') ?? ''
  return { origin: `${url.protocol}//${url.host}`, token }
}

/** 用入口 token 换取会话 cookie；成功后返回 `Cookie` 头的值。 */
async function exchangeCookie(settings: WorkbenchSettings, signal: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${settings.origin}/?token=${encodeURIComponent(settings.token)}`, {
      redirect: 'manual',
      signal,
    })
  } catch {
    throw new WorkbenchFailure('unreachable', WORKBENCH_COPY.unreachable)
  }
  // 工作台对正确 token 回 303 并下发 cookie；cookie 不在 2xx 上。
  const headers = response.headers
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const pair = cookies.map(value => value.split(';')[0]).filter(value => value.startsWith('dsh-auth-'))
  if (pair.length > 0) return pair.join('; ')
  if (response.status === 401 || response.status === 403) {
    throw new WorkbenchFailure('unauthorized', WORKBENCH_COPY.unauthorized, response.status)
  }
  // 有些浏览器环境不暴露 Set-Cookie；此时靠后续请求的 cookie 自动携带。
  return ''
}

/** 调用工作台 RPC 的客户端。 */
export class WorkbenchClient {
  private cookie = ''
  private readonly settings: WorkbenchSettings

  /** @param settings - 工作台根地址与入口 token。 */
  constructor(settings: WorkbenchSettings) {
    this.settings = settings
  }

  /** 换取（或刷新）会话 cookie。 */
  async connect(signal: AbortSignal): Promise<void> {
    this.cookie = await exchangeCookie(this.settings, signal)
  }

  /** 已经拿到会话 cookie 了吗（连接成功的判据）。 */
  get connected(): boolean {
    return this.cookie.length > 0
  }

  /**
   * 往工作台的**任意路径**发一次带会话的请求，并把它交给调用方。
   *
   * 为什么不让外部拿 cookie：那是这个进程的会话凭据，一旦暴露出去，任何拿到它的代码
   * 都能以用户身份访问工作台。所以这里只开放「发请求」这个动作，凭据本身不外流。
   * 账号面经电脑走时用的就是它——宿主进程不受浏览器同源策略约束，那条路才通得过去。
   * @param path - 工作台路径，例如 `/api/qianshou/account/login`。
   * @param init - 请求方法与请求体。
   * @param signal - 取消信号。
   * @returns 原始响应；**不解析**，因为账号面的失败形状由账号层自己翻译。
   */
  async request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.settings.origin}${path}`, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          ...(this.cookie.length > 0 ? { cookie: this.cookie } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      })
    } catch {
      throw new WorkbenchFailure('unreachable', WORKBENCH_COPY.unreachable)
    }
  }

  /** 发一次 RPC；失败一律抛 `WorkbenchFailure`，不返回半截数据。 */
  private async call<T>(method: string, args: unknown, signal: AbortSignal): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.settings.origin}/api/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args } }),
        signal,
      })
    } catch {
      throw new WorkbenchFailure('unreachable', WORKBENCH_COPY.unreachable)
    }
    if (response.status === 401 || response.status === 403) {
      throw new WorkbenchFailure('unauthorized', WORKBENCH_COPY.unauthorized, response.status)
    }
    let envelope: { result?: { ok?: boolean; value?: unknown; error?: { message?: string } } } | null
    try {
      envelope = await response.json() as typeof envelope
    } catch {
      throw new WorkbenchFailure('bad-response', WORKBENCH_COPY['bad-response'], response.status)
    }
    const result = envelope?.result
    if (result?.ok !== true) {
      throw new WorkbenchFailure('failed', result?.error?.message ?? WORKBENCH_COPY.failed, response.status)
    }
    return result.value as T
  }

  /** 真实会话列表，按最近更新排序。 */
  async sessions(signal: AbortSignal): Promise<readonly WorkbenchSession[]> {
    const value = await this.call<{ items?: unknown[] }>('session/list', { _request: {} }, signal)
    const items = Array.isArray(value?.items) ? value.items : []
    return items.flatMap((raw): WorkbenchSession[] => {
      if (typeof raw !== 'object' || raw === null) return []
      const record = raw as Record<string, unknown>
      const sessionId = record.sessionId
      if (typeof sessionId !== 'string') return []
      const projections = record.projections as { values?: { title?: unknown } } | undefined
      const title = projections?.values?.title
      return [{
        sessionId,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
        running: record.running === true,
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
        title: typeof title === 'string' && title.trim().length > 0 ? title : null,
      }]
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 某个会话下的子智能体。 */
  async subagents(parentSessionId: string, signal: AbortSignal): Promise<readonly WorkbenchSubagent[]> {
    const value = await this.call<{ entries?: unknown[] }>('subagents/list', { parentSessionId }, signal)
    const entries = Array.isArray(value?.entries) ? value.entries : []
    return entries.flatMap((raw): WorkbenchSubagent[] => {
      if (typeof raw !== 'object' || raw === null) return []
      const record = raw as Record<string, unknown>
      const id = record.id ?? record.subagentId
      if (typeof id !== 'string') return []
      return [{
        id,
        label: typeof record.label === 'string' ? record.label : (typeof record.name === 'string' ? record.name : id.slice(0, 8)),
        state: typeof record.state === 'string' ? record.state : (typeof record.status === 'string' ? record.status : ''),
      }]
    })
  }

  /** 某个 agent 可用的命令清单。 */
  async commands(agentId: string, signal: AbortSignal): Promise<readonly WorkbenchCommand[]> {
    const value = await this.call<unknown[]>('commands/list', { agentId }, signal)
    const items = Array.isArray(value) ? value : []
    return items.flatMap((raw): WorkbenchCommand[] => {
      if (typeof raw !== 'object' || raw === null) return []
      const record = raw as Record<string, unknown>
      const name = record.name
      if (typeof name !== 'string') return []
      return [{ name, description: typeof record.description === 'string' ? record.description : '' }]
    })
  }
}
