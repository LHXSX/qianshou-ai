/**
 * U1 本机节点中继（宿主侧半边）。
 *
 * 为什么必须有它：渲染进程不能直连回环端点——那个端点**有意**拒绝任何带浏览器 `Origin` 的请求
 * （任何网页都能向 `http://127.0.0.1:<port>` 发请求，所以 `Origin` 存在即 403；那道门是设计的一部分，
 * 不许为了让前端能读就去改它）。渲染进程的 fetch 恰好会带上 `Origin`（实测 `TypeError: Failed to fetch`），
 * 所以这次读取只能发生在本侧：Node 的 fetch 不带 `Origin`，客户端只走同源 `/qianshou-node/*`。
 *
 * 中继自己不是后门：只回环来源、拒绝任何带 `Origin` 的请求。
 * `/status` 与 `/command` 代打上游；`/power` 只在宿主注入了电源时由本进程处理，不转发给节点。
 * 口令**只从环境变量 `QIANSHOU_NODE_OWNER_PROOF` 读**（绝不从请求体里收）。
 *
 * 平台中立：本包（客户端插件包）的 tsconfig 是浏览器面，不引 Node 类型，因此这里的请求/响应
 * 只按**用到的结构**声明；运行时传进来的是真实 `IncomingMessage`/`ServerResponse`。
 */

/** 中继用到的请求结构（`IncomingMessage` 的结构子集）。 */
export interface RelayRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
  readonly headers: Record<string, string | string[] | undefined>
  readonly socket: { readonly remoteAddress?: string | undefined }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
}

/** 中继用到的响应结构（`ServerResponse` 的结构子集）。 */
export interface RelayResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

/** `webServer.register` 的 prefix 路由（只声明用到的那一格）。 */
export interface RelayRoute {
  readonly kind: 'prefix'
  readonly path: string
  readonly handler: (request: RelayRequest, response: RelayResponse) => void | Promise<void>
}

/** `webServer` 只用到 `register`。 */
export interface RelayWebServer {
  register(route: RelayRoute): () => void
}

/** 面板开关看到的电源状态。不含 pid，不含凭据。 */
export interface NodePowerRelayView {
  readonly running: boolean
  readonly managed: boolean
  readonly mode: 'paused' | 'running' | null
  readonly code?: string
}

/** 宿主注入的电源。`/power` 不转发到节点进程。 */
export interface NodePowerRelay {
  view(): Promise<NodePowerRelayView> | NodePowerRelayView
  set(on: boolean): Promise<NodePowerRelayView> | NodePowerRelayView
}

/** 中继目标与凭据。 */
export interface NodeRelayConfig {
  /** 上游端点基址，必须以 `/` 结尾。 */
  readonly upstream: string
  /** 端点若配了口令，中继用它填 `x-owner-proof`；空串表示端点没设。 */
  readonly proof: string
  /** 单次代打的超时。 */
  readonly timeoutMs: number
  /** 窗口自带节点的开关。缺省时 `/power` 与未知路由一样是 404。 */
  readonly power?: NodePowerRelay
  /**
   * 专员接单的状态。给了就由本进程回答 `/status`，不再转发给数词进程。
   */
  readonly agentStatus?: () => Promise<unknown> | unknown
}

/** 中继实例。 */
export interface NodeRelay {
  /** `webServer` prefix 路由的 handler。 */
  handle(request: RelayRequest, response: RelayResponse): Promise<void>
}

/** 路由前缀；客户端 `NODE_STATUS_ROUTE` 必须与它一致。 */
export const NODE_RELAY_PREFIX = '/qianshou-node'

/** 命令体上限：只够装一个分片 id。 */
const MAX_COMMAND_BYTES = 4096

/** 上游端点的默认端口（`--status-port` 可改）。 */
const DEFAULT_STATUS_PORT = 47_615

/**
 * 从环境变量解析配置。
 * @param env - 进程环境（值可能缺失）。
 * @returns 目标基址、口令与超时；端口非法时退回默认 47615。
 */
export function resolveNodeRelayConfig(env: Record<string, string | undefined> = process.env): NodeRelayConfig {
  const raw = env.QIANSHOU_NODE_STATUS_PORT ?? ''
  const parsed = Number(raw)
  const port = raw !== '' && Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : DEFAULT_STATUS_PORT
  return {
    upstream: `http://127.0.0.1:${String(port)}/`,
    proof: env.QIANSHOU_NODE_OWNER_PROOF ?? '',
    timeoutMs: 5000,
  }
}

/**
 * 建一个中继。
 * @param config - 目标与凭据。
 * @returns 中继。
 */
export function createNodeRelay(config: NodeRelayConfig): NodeRelay {
  return {
    async handle(request: RelayRequest, response: RelayResponse): Promise<void> {
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(payload))
      }
      if (!isLoopback(request.socket.remoteAddress)) {
        send(403, { ok: false, code: 'RELAY_NOT_LOCAL', message: 'the node relay answers loopback requests only' })
        return
      }
      if (request.headers.origin !== undefined) {
        send(403, { ok: false, code: 'RELAY_ORIGIN_REFUSED', message: 'browser-originated requests are never accepted' })
        return
      }
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const route = path.startsWith(NODE_RELAY_PREFIX) ? path.slice(NODE_RELAY_PREFIX.length) : path
      if (route === '/status') {
        if (request.method !== 'GET') { send(405, { ok: false, code: 'RELAY_METHOD_NOT_ALLOWED' }); return }
        if (config.agentStatus !== undefined) {
          send(200, await config.agentStatus())
          return
        }
        await forward(send, config, 'status', { method: 'GET' })
        return
      }
      if (route === '/command') {
        if (request.method !== 'POST') { send(405, { ok: false, code: 'RELAY_METHOD_NOT_ALLOWED' }); return }
        let body: string
        try {
          body = await readBody(request)
        } catch (error) {
          send(413, { ok: false, code: 'RELAY_BODY_REJECTED', message: messageOf(error) })
          return
        }
        await forward(send, config, 'command', {
          method: 'POST', body,
          headers: { 'content-type': 'application/json', ...(config.proof === '' ? {} : { 'x-owner-proof': config.proof }) },
        })
        return
      }
      if (route === '/power' && config.power !== undefined) {
        await servePower(send, request, config.power)
        return
      }
      send(404, { ok: false, code: 'RELAY_ROUTE_UNKNOWN' })
    },
  }
}

/** 开关路由：只回答电源状态，不把请求体转给节点。 */
async function servePower(
  send: (status: number, payload: unknown) => void,
  request: RelayRequest,
  power: NodePowerRelay,
): Promise<void> {
  if (request.method === 'GET') {
    send(200, await power.view())
    return
  }
  if (request.method !== 'POST') {
    send(405, { ok: false, code: 'RELAY_METHOD_NOT_ALLOWED' })
    return
  }
  let body: string
  try {
    body = await readBody(request)
  } catch (error) {
    send(413, { ok: false, code: 'RELAY_BODY_REJECTED', message: messageOf(error) })
    return
  }
  const parsed = parseJson(body)
  const on = typeof parsed === 'object' && parsed !== null ? (parsed as { on?: unknown }).on : undefined
  if (on !== true && on !== false) {
    send(400, { running: false, managed: false, mode: null, code: 'RELAY_BODY_REJECTED' })
    return
  }
  send(200, await power.set(on))
}

/** 代打一次：把上游的状态码与 JSON 原文原样回给同源调用方。 */
async function forward(
  send: (status: number, payload: unknown) => void,
  config: NodeRelayConfig,
  path: string,
  init: { method: string, body?: string, headers?: Record<string, string> },
): Promise<void> {
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, config.timeoutMs)
  let response: Response
  try {
    response = await fetch(new URL(path, config.upstream), {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      signal: abort.signal,
    })
  } catch (error) {
    // 节点没在跑不是异常，是一次明确的"未运行"。
    send(503, { ok: false, code: 'NODE_UNREACHABLE', message: messageOf(error) })
    return
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  const payload = parseJson(text)
  send(response.status, payload ?? { ok: response.ok, code: response.ok ? 'OK' : 'RELAY_UPSTREAM_NON_JSON', raw: text.slice(0, 512) })
}

/** 读一个有界的 JSON 命令体。 */
async function readBody(request: RelayRequest): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for await (const chunk of request) {
    const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk))
    size += bytes.byteLength
    if (size > MAX_COMMAND_BYTES) throw new Error('command body exceeds the relay limit')
    text += decoder.decode(bytes, { stream: true })
  }
  return text + decoder.decode()
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
