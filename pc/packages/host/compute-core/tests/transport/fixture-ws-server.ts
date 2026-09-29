/**
 * Minimal RFC 6455 server used to exercise the real socket path.
 *
 * Node ships a WebSocket *client* only, so a real handshake needs a real server.
 * Frames are decoded and encoded here from Node built-ins (`node:http`,
 * `node:crypto`) — no WebSocket library and no test double is involved, which is
 * the whole point: the resident edge session must be proven against a real TCP
 * socket, a real `Upgrade` handshake and real masked client frames.
 *
 * The server is deliberately tiny: text frames, close, ping/pong and the two
 * handshake headers the adapter depends on. It implements nothing the tests do
 * not assert.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'

/** One decoded client frame, in arrival order. */
export interface FixtureFrame {
  /** Frame type from the audited `{ v, type, payload }` envelope. */
  readonly type: string
  /** Decoded payload object. */
  readonly payload: Record<string, unknown>
  /** Whole decoded frame, so a test can assert the protocol version too. */
  readonly raw: Record<string, unknown>
  /** Zero-based index of the connection that delivered this frame. */
  readonly connection: number
}

/** Sending primitives handed to one server script invocation. */
export interface FixtureServerContext {
  /** Send one audited frame on the connection that produced the current frame. */
  reply(type: string, payload: Record<string, unknown>): void
  /** Send arbitrary text, to inject a frame the audited schema forbids. */
  sendRaw(text: string): void
  /** Destroy the socket without a close handshake. */
  destroy(): void
}

/** Fixture behaviour. */
export interface FixtureServerOptions {
  /** Runs for every decoded client frame; omitted means "reply to nothing". */
  readonly script?: (frame: FixtureFrame, context: FixtureServerContext) => void
  /** When false the server never echoes a subprotocol, so the handshake must fail. */
  readonly echoSubprotocol?: boolean
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE_TEXT = 0x1
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** Read every complete frame currently buffered on one socket. */
function readFrames(state: { buffer: Buffer }): { opcode: number; payload: Buffer }[] {
  const frames: { opcode: number; payload: Buffer }[] = []
  for (;;) {
    const buffer = state.buffer
    if (buffer.length < 2) return frames
    const first = buffer[0]
    const second = buffer[1]
    if (first === undefined || second === undefined) return frames
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return frames
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return frames
      const wide = buffer.readBigUInt64BE(offset)
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('fixture frame too large')
      length = Number(wide)
      offset += 8
    }
    const maskLength = masked ? 4 : 0
    if (buffer.length < offset + maskLength + length) return frames
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
    offset += maskLength
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
      }
    }
    state.buffer = buffer.subarray(offset + length)
    frames.push({ opcode, payload })
  }
}

/** Encode one unmasked server frame. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
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

/** One real WebSocket server bound to a loopback ephemeral port. */
export class FixtureWebSocketServer {
  /** Every decoded client frame across every connection, in arrival order. */
  readonly frames: FixtureFrame[] = []
  /** `Sec-WebSocket-Protocol` request header per connection, verbatim. */
  readonly protocolsRequested: (string | undefined)[] = []
  /** `Sec-WebSocket-Protocol` response header this server actually sent per connection. */
  readonly protocolsEchoed: (string | undefined)[] = []
  /** Sockets currently accepted, so `close` can tear every one down. */
  private readonly sockets = new Set<Duplex>()
  private readonly buffer = new Map<Duplex, { buffer: Buffer }>()
  private readonly connectionIndexOf = new Map<Duplex, number>()
  private latest: Duplex | null = null

  private constructor(
    private readonly server: Server,
    /** Port the fixture actually bound. */
    readonly port: number,
    private readonly options: FixtureServerOptions,
  ) {}

  /** Bound origin, usable directly as an `EdgeWorkerSessionOptions.endpoint`. */
  get origin(): string { return `http://127.0.0.1:${this.port}` }

  /** How many sockets the fixture has accepted. */
  get connectionCount(): number { return this.connectionIndexOf.size }

  /** Send one audited frame on the most recently accepted connection. */
  send(type: string, payload: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify({ v: '8.0', type, payload }))
  }

  /** Send arbitrary text on the most recently accepted connection. */
  sendRaw(text: string): void {
    this.latest?.write(encodeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8')))
  }

  /** Destroy the most recently accepted connection without a close handshake. */
  destroyLatest(): void {
    this.latest?.destroy()
  }

  /** Stop the server and destroy every accepted socket. */
  async close(): Promise<void> {
    for (const socket of [...this.sockets]) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => {
      this.server.close(() =>{  resolve() })
      // `close` waits for open sockets; the loop above already destroyed them,
      // and `closeAllConnections` covers an upgrade still in flight.
      this.server.closeAllConnections()
    })
  }

  /** Bind the fixture to an ephemeral loopback port and start accepting upgrades.
   * @param options - Script and handshake behaviour.
   * @returns The running fixture.
   */
  static async start(options: FixtureServerOptions = {}): Promise<FixtureWebSocketServer> {
    let fixture: FixtureWebSocketServer | null = null
    const server = createServer((_request, response) => { response.writeHead(426).end() })
    server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
      const current = fixture
      if (!current) { socket.destroy(); return }
      current.accept(request, socket)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () =>{  resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server did not bind a port')
    fixture = new FixtureWebSocketServer(server, address.port, options)
    return fixture
  }

  private accept(request: IncomingMessage, socket: Duplex): void {
    const index = this.connectionIndexOf.size
    this.connectionIndexOf.set(socket, index)
    this.sockets.add(socket)
    this.buffer.set(socket, { buffer: Buffer.alloc(0) })
    this.latest = socket
    const requested = request.headers['sec-websocket-protocol']
    this.protocolsRequested.push(requested)

    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') { socket.destroy(); return }
    const head = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createHash('sha1').update(`${key}${GUID}`).digest('base64')}`,
    ]
    // Only the audited subprotocol is echoed, and only when the client asked for it.
    const echo = this.options.echoSubprotocol !== false
      && typeof requested === 'string'
      && requested.split(',').map(value => value.trim()).includes('edgecompute.v8')
    if (echo) head.push('Sec-WebSocket-Protocol: edgecompute.v8')
    this.protocolsEchoed.push(echo ? 'edgecompute.v8' : undefined)
    socket.write(`${head.join('\r\n')}\r\n\r\n`)
    socket.on('data', (chunk: Buffer) =>{  this.receive(socket, index, chunk) })
    socket.on('error', () => { /* a destroyed fixture socket is expected during teardown */ })
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.buffer.delete(socket)
    })
  }

  private receive(socket: Duplex, index: number, chunk: Buffer): void {
    const state = this.buffer.get(socket)
    if (!state) return
    state.buffer = Buffer.concat([state.buffer, chunk])
    for (const frame of readFrames(state)) {
      if (frame.opcode === OPCODE_CLOSE) { socket.end(encodeFrame(OPCODE_CLOSE, Buffer.alloc(0))); continue }
      if (frame.opcode === OPCODE_PING) { socket.write(encodeFrame(OPCODE_PONG, frame.payload)); continue }
      if (frame.opcode !== OPCODE_TEXT) continue
      const decoded: unknown = JSON.parse(frame.payload.toString('utf8'))
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) continue
      const raw = decoded as Record<string, unknown>
      const payload = raw.payload
      const record: FixtureFrame = {
        type: typeof raw.type === 'string' ? raw.type : '',
        payload: payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {},
        raw,
        connection: index,
      }
      this.frames.push(record)
      this.options.script?.(record, {
        reply: (type, value) => {
          socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify({ v: '8.0', type, payload: value }), 'utf8')))
        },
        sendRaw: (text) => { socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8'))) },
        destroy: () => socket.destroy(),
      })
    }
  }
}
