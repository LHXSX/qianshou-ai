/**
 * E9 第一层出口：`127.0.0.1` 上的**本地只读状态端点**（外加主人中止那一根闸）。
 *
 * 它存在的理由只有一条：今天"节点在跑什么"只存在于终端日志里（`node-daemon.mts:64-65,120,125,129,139`），
 * 界面（PC 客户端）与主人拿不到任何机器可读的东西。这个端点把 {@link NodeStatusSnapshot} 交出去。
 *
 * ## 安全硬要求（写在这里，不许被"顺手放宽"）
 *
 * 1. **只绑 `127.0.0.1`**：本模块**没有** `host` 选项，绑定地址是一个私有常量
 *    （{@link LOOPBACK_ADDRESS}）。不存在"传个参数就能对外"的路径，也**永不**绑 `0.0.0.0`。
 * 2. **非本机来源一律拒**：即使有人设法把请求送到 handler，只要 socket 对端不是回环地址就 403
 *    （{@link isLoopbackPeer}）。这一条是**授权**，不是"没监听"的副产品。
 * 3. **带浏览器 `Origin` 的请求一律拒**：机主浏览器里的任意网页都能向 `http://127.0.0.1:<port>`
 *    发请求；`Origin` 存在即拒 + 只接受 `application/json`（浏览器要预检，而本端点不回 CORS 头）
 *    两条一起挡住这类跨站驱动本地动作。
 * 4. **`source` 永不来自请求体**：来源由本地通道本身决定（E3：能从数据里设 `source` 的调用方
 *    等于自己给自己发了那把闸的钥匙）。请求体里出现 `source` ⇒ 400。
 * 5. **口令（可选）只从环境变量来**：配置了 `proof` 就必须出示 `x-owner-proof`；它只闸**动作**
 *    （`/command`），不闸只读。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { OwnerAbortOutcome } from './owner-abort.ts'
import type { NodeStatusSnapshot } from './node-status.ts'

/**
 * 唯一允许的绑定地址。
 *
 * 这是模块私有常量而不是配置项：`startNodeStatusSurface` 没有 `host` 参数，所以调用方
 * 无法把端点挪到对外网卡上。改这一行等于改产品的安全边界，需要人拍板。
 */
const LOOPBACK_ADDRESS = '127.0.0.1'

/** 命令体上限：主人命令只有目标与原因两个短字段。 */
const MAX_COMMAND_BYTES = 4096

/** handler 的形状；服务器与测试驱动**同一个** handler。 */
export type NodeStatusRequestHandler = (request: IncomingMessage, response: ServerResponse) => void

/** handler 的依赖：一份只读快照 + 一个动作。 */
export interface NodeStatusHandlerOptions {
  /** 当前快照（每次请求现取，不缓存）。 */
  readonly status: () => NodeStatusSnapshot
  /** 可选本地口令；空串表示本部署不另设第二因子（E3 的威胁模型：主人是本机唯一调用方）。 */
  readonly proof: string
  /** 主人中止：目标 + 原因 ⇒ 结果（实现来自 {@link NodeStatusTracker.stopOwnerTasks}）。 */
  readonly stopOwnerTasks: (input: { readonly target: 'all' | string; readonly reason: string }) => OwnerAbortOutcome
}

/** 起端点所需参数。 */
export interface NodeStatusSurfaceOptions extends NodeStatusHandlerOptions {
  /** 监听端口；`0` 表示由系统分配（测试用），生产用显式端口。 */
  readonly port: number
}

/** 端点句柄。 */
export interface NodeStatusSurface {
  /** 实际绑定地址，恒为 `127.0.0.1`。 */
  readonly address: string
  /** 实际端口（`port: 0` 时由系统分配）。 */
  readonly port: number
  /** 客户端要访问的源，例如 `http://127.0.0.1:47615`。 */
  readonly origin: string
  /** 关掉端点（幂等）。 */
  close(): Promise<void>
}

/** 一个只有回环地址才可能命中的 JSON handler。 */
class NodeStatusRequestRefusal extends Error {
  /** @param code - 稳定机器码，直接进响应体。 @param status - 对应的 HTTP 状态码。 */
  constructor(readonly code: string, readonly status: number) { super(code) }
}

/**
 * 这个对端地址算不算"本机"。
 *
 * `::ffff:127.0.0.1` 是 IPv4-mapped 的回环形态：双栈 socket 上 Node 可能报这个写法，
 * 它同样是本机。其它任何地址（含局域网、容器网桥、公网）都不算。
 * @param address - `socket.remoteAddress`，可能是 `undefined`（连接已关闭）。
 * @returns 只在明确是回环时为 true；未知一律 false。
 */
export function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 造一个本地状态端点的 handler。
 *
 * 与 {@link startNodeStatusSurface} 用的是同一个函数：测试里"非本机来源取不到"这条闸
 * 驱动的是**生产代码本身**，不是它的复制品。
 * @param options - 快照来源、口令与中止实现。
 * @returns 同步签名、内部异步的请求处理器（永远以响应结束，不抛给 Node）。
 */
export function createNodeStatusHandler(options: NodeStatusHandlerOptions): NodeStatusRequestHandler {
  return (request, response) => { void respond(request, response, options) }
}

/**
 * 起一个只监听 `127.0.0.1` 的本地状态端点。
 * @param options - 端口、快照来源、口令与中止实现。
 * @returns 端点句柄（含真实端口与源）。
 */
export async function startNodeStatusSurface(options: NodeStatusSurfaceOptions): Promise<NodeStatusSurface> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error(`status port must be an integer in 0..65535, got ${String(options.port)}`)
  }
  const server: Server = createServer(createNodeStatusHandler(options))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 绑定地址是常量而不是参数：这里没有"改成 0.0.0.0"的入口。
    server.listen(options.port, LOOPBACK_ADDRESS, resolve)
  })
  const bound = server.address()
  const port = typeof bound === 'object' && bound !== null ? bound.port : options.port
  return {
    address: LOOPBACK_ADDRESS,
    port,
    origin: `http://${LOOPBACK_ADDRESS}:${port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeIdleConnections()
      server.close(() => resolve())
    }),
  }
}

/**
 * 一条请求的全部处理。
 * @param request - Node 的请求对象。
 * @param response - Node 的响应对象。
 * @param options - handler 依赖。
 */
async function respond(request: IncomingMessage, response: ServerResponse, options: NodeStatusHandlerOptions): Promise<void> {
  const send = (status: number, payload: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(payload))
  }
  try {
    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      send(403, { ok: false, code: 'NODE_STATUS_NOT_LOCAL', message: 'this endpoint answers loopback requests only' })
      return
    }
    if (request.headers.origin !== undefined) {
      send(403, { ok: false, code: 'NODE_STATUS_BROWSER_ORIGIN_REFUSED', message: 'browser-originated requests are never accepted' })
      return
    }
    const path = new URL(request.url ?? '/', `http://${LOOPBACK_ADDRESS}`).pathname
    if (path === '/status') {
      if (request.method !== 'GET') { send(405, { ok: false, code: 'NODE_STATUS_METHOD_NOT_ALLOWED' }); return }
      // 只读端点：口令不闸读取，回环来源本身即授权。
      send(200, options.status())
      return
    }
    if (path === '/command') {
      if (request.method !== 'POST') { send(405, { ok: false, code: 'NODE_STATUS_METHOD_NOT_ALLOWED' }); return }
      if (options.proof !== '' && request.headers['x-owner-proof'] !== options.proof) {
        send(403, { ok: false, code: 'NODE_STATUS_PROOF_REQUIRED', message: 'the configured local owner proof is missing or wrong' })
        return
      }
      const body = await readCommand(request)
      if (body.source !== undefined) {
        send(400, { ok: false, code: 'NODE_STATUS_SOURCE_NOT_ACCEPTED', message: 'the abort source is the local channel, never request data' })
        return
      }
      if (body.command === 'tasks') {
        const snapshot = options.status()
        send(200, { ok: true, command: 'tasks', tasks: snapshot.tasks, connection: snapshot.connection })
        return
      }
      if (body.command === 'abort') {
        const target = body.target
        if (target !== 'all' && (typeof target !== 'string' || target === '')) {
          send(400, { ok: false, code: 'NODE_STATUS_TARGET_INVALID', message: 'abort target must be "all" or one shard id' })
          return
        }
        const snapshot = options.status()
        // 离线不是异常：明确回答"离线"，而不是让人去看一个 500。
        if (snapshot.connection.state !== 'online') {
          send(503, { ok: false, code: 'NODE_OFFLINE', message: 'the node has no live link; nothing on this node is executing', connection: snapshot.connection })
          return
        }
        const outcome = options.stopOwnerTasks({ target, reason: typeof body.reason === 'string' ? body.reason : '' })
        send(200, { ok: true, command: 'abort', outcome, connection: options.status().connection })
        return
      }
      send(400, { ok: false, code: 'NODE_STATUS_COMMAND_UNKNOWN', message: 'command must be "tasks" or "abort"' })
      return
    }
    send(404, { ok: false, code: 'NODE_STATUS_ROUTE_UNKNOWN' })
  } catch (error) {
    if (error instanceof NodeStatusRequestRefusal) {
      send(error.status, { ok: false, code: error.code })
      return
    }
    // 只有真正没预料到的故障才是 500；上面每一条"预期内的拒绝"都有自己的码。
    send(500, { ok: false, code: 'NODE_STATUS_INTERNAL' })
  }
}

/**
 * 读一个有界的 JSON 命令体。
 * @param request - 请求对象。
 * @returns 解析后的对象（非对象、非法 JSON、超长都会以明确的码拒绝）。
 */
async function readCommand(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new NodeStatusRequestRefusal('NODE_STATUS_CONTENT_TYPE_REQUIRED', 415)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > MAX_COMMAND_BYTES) throw new NodeStatusRequestRefusal('NODE_STATUS_BODY_TOO_LARGE', 413)
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new NodeStatusRequestRefusal('NODE_STATUS_BODY_INVALID', 400)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new NodeStatusRequestRefusal('NODE_STATUS_BODY_INVALID', 400)
  }
  return parsed as Record<string, unknown>
}
