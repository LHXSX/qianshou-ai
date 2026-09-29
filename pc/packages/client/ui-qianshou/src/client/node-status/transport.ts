/**
 * U1 取数口：`/status` 读，`/command` 发主人中止。
 *
 * 为什么默认走**同源**而不是直连 `http://127.0.0.1:47615`：端点有意拒绝带浏览器 `Origin` 的请求
 * （任何网页都能向回环口发请求，所以 `Origin` 存在即 403），渲染进程的 fetch 恰好会带上它。
 * 实测（见报告 §C2）：渲染进程直连 = `TypeError: Failed to fetch`；同源 `dsh-app://app/*`
 * 由 Electron 主进程转给自有宿主，再在 Node 侧代打，端点才收到一个**没有 Origin** 的请求。
 */
import {
  NODE_STATUS_PORT_DEFAULT, NODE_STATUS_ROUTE, parseNodeStatus,
  type NodeCommand, type NodeCommandOutcome, type NodePowerState, type NodeStatusReadout, type NodeStatusTransport,
  type NodeUnreachableCode,
} from './types.ts'

/** 取数口的地址与注入点。 */
export interface NodeTransportOptions {
  /** 端点基址，必须以 `/` 结尾（例如 `dsh-app://app/qianshou-node/` 或 `http://127.0.0.1:47615/`）。 */
  readonly baseUrl: string | URL
  /** 相对基址是否属于**同源中继**（决定 404 是"没接线"还是"节点没跑"）。 */
  readonly relay?: boolean
  /** fetch 实现（测试注入）。 */
  readonly fetchImpl?: typeof fetch
}

/**
 * 一个基于 HTTP 的取数口。
 * @param options - 基址与注入点。
 * @returns 显示面用的传输。
 */
export function createHttpNodeTransport(options: NodeTransportOptions): NodeStatusTransport {
  const base = typeof options.baseUrl === 'string' ? new URL(options.baseUrl) : options.baseUrl
  const request = options.fetchImpl ?? fetch
  const url = (path: string): string => new URL(path, base).toString()
  const unreachable = (code: NodeUnreachableCode, message: string): NodeStatusReadout => ({ kind: 'unreachable', code, message })
  return {
    async read(init): Promise<NodeStatusReadout> {
      let response: Response
      try {
        response = await request(url('status'), {
          method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit',
          ...(init?.signal === undefined ? {} : { signal: init.signal }),
        })
      } catch (error) {
        return unreachable('NODE_UNREACHABLE', messageOf(error))
      }
      const payload = await readJson(response)
      if (!response.ok) {
        if (response.status === 404) return unreachable(options.relay === true ? 'RELAY_MISSING' : 'NODE_UNREACHABLE', 'status route is not served here')
        if (response.status === 403) return unreachable('RELAY_REFUSED', codeOf(payload) ?? 'REFUSED')
        return unreachable('NODE_UNREACHABLE', codeOf(payload) ?? `HTTP ${String(response.status)}`)
      }
      const snapshot = parseNodeStatus(payload)
      if (snapshot === null) return unreachable('BAD_PAYLOAD', 'status payload is not a qianshou.node-status.v1 snapshot')
      return { kind: 'snapshot', snapshot }
    },
    async command(command: NodeCommand, init): Promise<NodeCommandOutcome> {
      let response: Response
      try {
        response = await request(url('command'), {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
          body: JSON.stringify(command),
          ...(init?.signal === undefined ? {} : { signal: init.signal }),
        })
      } catch (error) {
        return { ok: false, code: 'NODE_UNREACHABLE', message: messageOf(error) }
      }
      const payload = await readJson(response)
      const code = codeOf(payload) ?? `HTTP ${String(response.status)}`
      return response.ok ? { ok: true, code: 'OK', detail: payload } : { ok: false, code, message: code }
    },
    power(init) {
      return readPower(request, url('power'), { method: 'GET' }, init?.signal)
    },
    setPower(on, init) {
      return readPower(request, url('power'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on }),
      }, init?.signal)
    },
  }
}

/**
 * 生产用取数口：同源中继（桌面外壳 `/plugins` 之外的同源路径都会转给自有宿主）。
 * @param options - 基址覆盖与 fetch 注入。
 * @returns 传输。
 */
export function createRelayTransport(options: { readonly baseUri?: string, readonly fetchImpl?: typeof fetch } = {}): NodeStatusTransport {
  const baseUri = options.baseUri ?? (typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI)
  const base = new URL(`${NODE_STATUS_ROUTE}/`, baseUri)
  return createHttpNodeTransport({ baseUrl: base, relay: true, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) })
}

/**
 * 直连回环端点：只在**没有浏览器 Origin 的 Node 侧**有意义（自检、测试、宿主代打）。
 * @param options - 端口与 fetch 注入。
 * @returns 传输。
 */
export function createLoopbackTransport(options: { readonly port?: number, readonly fetchImpl?: typeof fetch } = {}): NodeStatusTransport {
  const port = options.port ?? NODE_STATUS_PORT_DEFAULT
  return createHttpNodeTransport({
    baseUrl: `http://127.0.0.1:${String(port)}/`, relay: false,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}

async function readPower(
  request: typeof fetch,
  target: string,
  init: { method: string, headers?: Record<string, string>, body?: string },
  signal: AbortSignal | undefined,
): Promise<NodePowerState> {
  let response: Response
  try {
    response = await request(target, {
      method: init.method,
      credentials: 'omit',
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch {
    // 中继没应答时开关停在关，不把异常文本带到面板。
    return { running: false, managed: false, mode: null, code: 'NODE_UNREACHABLE' }
  }
  const payload = await readJson(response)
  return parsePower(payload) ?? {
    running: false, managed: false, mode: null, code: codeOf(payload) ?? `HTTP ${String(response.status)}`,
  }
}

function parsePower(payload: unknown): NodePowerState | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.running !== 'boolean' || typeof record.managed !== 'boolean') return null
  const mode = record.mode === 'running' || record.mode === 'paused' ? record.mode : null
  const code = typeof record.code === 'string' ? record.code : undefined
  return { running: record.running, managed: record.managed, mode, ...(code === undefined ? {} : { code }) }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function codeOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const code = (payload as Record<string, unknown>).code
  return typeof code === 'string' ? code : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
