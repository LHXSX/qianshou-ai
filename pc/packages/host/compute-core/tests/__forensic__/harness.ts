/**
 * 节点侧「掉线/会话顶替」取证台（只读优先 · 改前不改生产代码）。
 *
 * 真 WebSocket（Node 全局 WebSocket 客户端）+ 本机真协议网关，跑**生产代码路径**：
 *   · `bindInlineEdgeResident`（部署层真实装配：hello 载荷、worker 身份回带）
 *   · `EdgeWorkerResidentConnector` / `EdgeWorkerResidentSession`（真 socket 会话）
 *   · `ResidentNodeRuntime`（常驻接单循环 + pause→resume 重连策略）
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE_TEXT = 0x1
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const head: number[] = [0x80 | opcode]
  if (payload.length < 126) head.push(payload.length)
  else if (payload.length < 65_536) head.push(126, payload.length >> 8, payload.length & 0xff)
  else {
    head.push(127)
    const wide = Buffer.alloc(8)
    wide.writeBigUInt64BE(BigInt(payload.length))
    return Buffer.concat([Buffer.from(head), wide, payload])
  }
  return Buffer.concat([Buffer.from(head), payload])
}

function frameText(text: string): Buffer { return encodeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8')) }

function readFrames(state: { buffer: Buffer }): { opcode: number; payload: Buffer }[] {
  const frames: { opcode: number; payload: Buffer }[] = []
  for (;;) {
    const buffer = state.buffer
    if (buffer.length < 2) return frames
    const first = buffer[0] as number
    const second = buffer[1] as number
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return frames
      length = buffer.readUInt16BE(offset); offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return frames
      const wide = buffer.readBigUInt64BE(offset)
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large')
      length = Number(wide); offset += 8
    }
    const maskLength = masked ? 4 : 0
    if (buffer.length < offset + maskLength + length) return frames
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
    offset += maskLength
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number)
    state.buffer = buffer.subarray(offset + length)
    frames.push({ opcode, payload })
  }
}

export interface ServerFrame {
  readonly at: number
  readonly connection: number
  readonly type: string
  readonly payload: Record<string, unknown>
}

export interface ServerEvent {
  readonly at: number
  readonly kind: string
  readonly connection?: number
  readonly detail?: Record<string, unknown>
}

/** 本机真协议网关：固定端口、可服务器主动断链、可整体重启，逐帧留时间线。 */
export class LocalGateway {
  readonly frames: ServerFrame[] = []
  readonly events: ServerEvent[] = []
  /** 每条连接的 hello 里是否回带了 worker_id（undefined = 没带）。 */
  readonly helloWorkerIds: (string | undefined)[] = []
  /** 每条连接我们（服务器）在 auth_ok 里给出的权威 worker_id。 */
  readonly authWorkerIds: (string | undefined)[] = []
  /** 断链注入：TCP accept 后 N 毫秒服务器主动关掉这条连接。 */
  autoDropAfterMs: number | null = null
  /** 黑洞注入：accept 之后一个字节都不回（socket 半死：TCP 活着、对端不理）。 */
  blackhole = false
  /** 每条连接上收到的 hb 帧计数。 */
  readonly hbCounts: number[] = []
  /** 每条新连接被 accept 时，服务器侧仍然打开的旧连接数（「一行两会话」判据）。 */
  readonly openSocketsAtAccept: number[] = []
  private readonly sockets = new Map<Duplex, { index: number; buffer: Buffer }>()
  private nextIndex = 0

  private constructor(private readonly server: Server, readonly port: number) {}

  get connectionCount(): number { return this.nextIndex }

  private event(kind: string, connection?: number, detail?: Record<string, unknown>): void {
    this.events.push({ at: Date.now(), kind, ...(connection === undefined ? {} : { connection }), ...(detail === undefined ? {} : { detail }) })
  }

  /** 服务器主动断掉一条连接（close 握手，等价于平台关掉这条 WS）。 */
  dropConnection(index?: number): boolean {
    const target = index ?? Math.max(0, this.nextIndex - 1)
    for (const [socket, state] of [...this.sockets]) {
      if (state.index !== target) continue
      socket.write(encodeFrame(OPCODE_CLOSE, Buffer.alloc(0)))
      socket.end()
      const timer = setTimeout(() => socket.destroy(), 50)
      if (typeof timer.unref === 'function') timer.unref()
      return true
    }
    return false
  }

  send(connection: number, type: string, payload: Record<string, unknown>): boolean {
    for (const [socket, state] of this.sockets) {
      if (state.index !== connection) continue
      socket.write(frameText(JSON.stringify({ v: '8.0', type, payload })))
      return true
    }
    return false
  }

  static async listen(port: number): Promise<LocalGateway> {
    let gateway: LocalGateway | null = null
    const server = createServer((_request, response) => { response.writeHead(426).end() })
    server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
      const current = gateway
      if (!current) { socket.destroy(); return }
      current.accept(request, socket)
    })
    await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => resolve()) })
    gateway = new LocalGateway(server, port)
    gateway.event('listening', undefined, { port })
    return gateway
  }

  private accept(request: IncomingMessage, socket: Duplex): void {
    const index = this.nextIndex++
    // 记录「新连接到来时旧连接是否还开着」——这正是「一行两会话」的服务器侧判据。
    this.openSocketsAtAccept[index] = this.sockets.size
    this.sockets.set(socket, { index, buffer: Buffer.alloc(0) })
    this.hbCounts[index] = 0
    this.event('accept', index, { open_sockets_before_accept: this.openSocketsAtAccept[index] })
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') { socket.destroy(); return }
    const head = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createHash('sha1').update(`${key}${GUID}`).digest('base64')}`,
    ]
    const requested = request.headers['sec-websocket-protocol']
    const negotiated = typeof requested === 'string' && requested.split(',').map(v => v.trim()).includes('edgecompute.v8')
    if (negotiated) head.push('Sec-WebSocket-Protocol: edgecompute.v8')
    this.event('subprotocol', index, { negotiated, requested: requested ?? null })
    socket.write(`${head.join('\r\n')}\r\n\r\n`)
    socket.on('data', (chunk: Buffer) => { this.receive(socket, index, chunk) })
    socket.on('error', () => { /* teardown */ })
    socket.on('close', () => { this.event('close', index); this.sockets.delete(socket) })
    if (this.autoDropAfterMs !== null) {
      const delay = this.autoDropAfterMs
      const timer = setTimeout(() => { this.dropConnection(index) }, delay)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  private receive(socket: Duplex, index: number, chunk: Buffer): void {
    const state = this.sockets.get(socket)
    if (!state) return
    state.buffer = Buffer.concat([state.buffer, chunk])
    for (const frame of readFrames(state)) {
      if (frame.opcode === OPCODE_CLOSE) { socket.end(encodeFrame(OPCODE_CLOSE, Buffer.alloc(0))); continue }
      if (frame.opcode === OPCODE_PING) { socket.write(encodeFrame(OPCODE_PONG, frame.payload)); continue }
      if (frame.opcode !== OPCODE_TEXT) continue
      const decoded: unknown = JSON.parse(frame.payload.toString('utf8'))
      if (decoded === null || typeof decoded !== 'object') continue
      const raw = decoded as Record<string, unknown>
      const payload = raw.payload
      const record: ServerFrame = {
        at: Date.now(), connection: index,
        type: typeof raw.type === 'string' ? raw.type : '',
        payload: payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {},
      }
      this.frames.push(record)
      if (record.type === 'hello') {
        const carried = record.payload.worker_id
        this.helloWorkerIds[index] = typeof carried === 'string' ? carried : undefined
        this.event('hello', index, { carried_worker_id: typeof carried === 'string' ? carried : null, connection_index: index })
        if (!this.blackhole) this.send(index, 'welcome', { hb_interval_s: 5, hb_timeout_s: 5, server_time: new Date().toISOString() })
      }
      if (record.type === 'auth' && this.blackhole) {
        this.event('blackholed_auth', index)
      }
      if (record.type === 'auth' && !this.blackhole) {
        const wid = this.workerIdFor(index)
        const welcomeBack = this.helloWorkerIds[index] !== undefined
        this.send(index, 'auth_ok', { worker_id: wid, owner_id: 7, welcome_back: welcomeBack, server_clock: new Date().toISOString() })
        this.event('auth_ok_sent', index, { worker_id: wid, welcome_back: welcomeBack })
      }
      if (record.type === 'hb') {
        this.hbCounts[index] = (this.hbCounts[index] ?? 0) + 1
        this.event('hb', index, { count: this.hbCounts[index] })
        if (!this.blackhole) this.send(index, 'hb_ack', {})
      }
      if (record.type === 'shard_result') this.event('result', index, { shard_id: record.payload.shard_id, ok: record.payload.ok, failure_class: record.payload.failure_class ?? null })
      if (record.type === 'shard_progress') this.event('progress', index, { shard_id: record.payload.shard_id })
    }
  }

  /** 平台语义（ws.py:334-345）：hello 带 id ⇒ 同一 id（uuid5 派生）；不带 ⇒ 铸一个新的。 */
  private workerIdFor(index: number): string {
    const carried = this.helloWorkerIds[index]
    const id = carried === undefined
      ? `w-${createHash('sha1').update(`mint:${index}:${Date.now()}`).digest('hex').slice(0, 12)}`
      : `uuid5-${createHash('sha1').update(carried).digest('hex').slice(0, 12)}`
    this.authWorkerIds[index] = id
    return id
  }

  /** 整体停掉（监听 + 所有连接），用于模拟网关进程重启。 */
  async stop(): Promise<void> {
    this.event('server_stop')
    for (const socket of [...this.sockets.keys()]) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }
}

/** 真 TCP 代理：节点 → 代理 → 网关，用来制造「节点侧网络抖动」。 */
export class FlakyProxy {
  private readonly pairs = new Set<Socket>()
  private accepting = true
  private constructor(private readonly server: Server, readonly port: number, private readonly upstreamPort: number) {}

  static async listen(port: number, upstreamPort: number): Promise<FlakyProxy> {
    const server = createServer()
    const proxy = new FlakyProxy(server, port, upstreamPort)
    server.on('connection', (client: Socket) => {
      if (!proxy.accepting) { client.destroy(); return }
      const upstream = netConnect(proxy.upstreamPort, '127.0.0.1')
      proxy.pairs.add(client); proxy.pairs.add(upstream)
      client.pipe(upstream); upstream.pipe(client)
      const drop = (): void => { client.destroy(); upstream.destroy() }
      client.on('error', drop); upstream.on('error', drop)
      client.on('close', () => { proxy.pairs.delete(client); upstream.destroy() })
      upstream.on('close', () => { proxy.pairs.delete(upstream); client.destroy() })
    })
    await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => resolve()) })
    return proxy
  }

  /** 阻断：切断所有在建连接并拒绝新连接（= 到服务器的路由被摘掉）。 */
  cut(): void {
    this.accepting = false
    for (const socket of [...this.pairs]) socket.destroy()
    this.pairs.clear()
  }

  restore(): void { this.accepting = true }

  async close(): Promise<void> {
    for (const socket of [...this.pairs]) socket.destroy()
    this.pairs.clear()
    await new Promise<void>((resolve) => { this.server.close(() => resolve()) })
  }
}

export function sleep(ms: number): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, ms) }) }

export async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return Date.now() - start
    await sleep(20)
  }
  throw new Error(`timeout: ${label} (${timeoutMs}ms)`)
}

export function assignment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workload_id: 'workload-1', shard_id: 'shard-1', attempt: 0, task_type: 'word_count', runtime: 'python3',
    input_kind: 'inline', inline_input: 'alpha beta gamma delta', input_ref: '', input_refs: [],
    code_url: 'https://untrusted.example/script.py', code_sha256: '', timeout_s: 60,
    verification_policy: 'semantic', execution_model: '', capability: 'word.count', capability_version: '1.0.0',
    lease_token: 'server-issued-lease-token', ...overrides,
  }
}

/** 从验收报表里读事实，避免把「没观察到」写成「不存在」。 */
export function summarize(gateway: LocalGateway): Record<string, unknown> {
  return {
    connections: gateway.connectionCount,
    hello_carried_worker_id: gateway.helloWorkerIds.map(value => value ?? null),
    server_acknowledged_worker_id: gateway.authWorkerIds.map(value => value ?? null),
    hb_frames_per_connection: [...gateway.hbCounts],
    frames: gateway.frames.map(frame => ({ t: frame.at, c: frame.connection, type: frame.type })),
    events: gateway.events,
  }
}
