/**
 * 工单 2 第 1+2 项的可红闸门：未知帧容错、能力协商缺省即关闭、握手可观测、重连退避有上限。
 *
 * 反向回归闸有两层，都不改动被审源码：
 * 1. 行为层：把 `connection.ts` 的未知帧分支改回 `throw 'unsupported frame'`（修复前的行为）
 *    ⇒ 「忽略未知类型帧」用例必红。修复前的真实红已在 `docs/dev-plan/report-W2-未知帧容错.md` 留证。
 * 2. 源码层（本文件最后一组）：随时读源码文本做审计，改回 `throw` 立刻红——不需要任何人先改文件再改回来。
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EdgeReconnectBackoff, EdgeWorkerConnection, type EdgeWorkerOptions } from '../../src/edge-worker/connection.ts'
import type { EdgeTaskOffer } from '../../src/edge-worker/types.ts'

/** 平台侧假 socket：能把任意帧、任意顺序塞给节点，并记录是否被节点关掉。 */
class FixtureSocket extends EventTarget {
  static OPEN = 1
  static latest: FixtureSocket
  /** `welcome.hb_interval_s`（生产实测 15）。 */
  static intervalSeconds = 15
  /** `welcome.hb_timeout_s`：undefined ⇒ welcome 里不带该字段。 */
  static timeoutSeconds: number | undefined = 45
  /** `welcome.features`：undefined ⇒ welcome 里不带该字段（缺省即关闭的情形）。 */
  static features: unknown = undefined
  /** `hello` 之后、真正的 `welcome` 之前要注入的帧。 */
  static beforeWelcome: { type: string; payload: Record<string, unknown> }[] = []
  /** `auth` 之后、真正的 `auth_ok` 之前要注入的帧。 */
  static beforeAuth: { type: string; payload: Record<string, unknown> }[] = []
  /** 置 true 后 fixture 不再回 `hb_ack`。 */
  static muteAcks = false
  readyState = 1
  sent: { type: string; payload: Record<string, unknown> }[] = []
  closes = 0
  constructor() { super(); FixtureSocket.latest = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
  send(data: string) {
    const frame = JSON.parse(data); this.sent.push(frame)
    if (frame.type === 'hello') {
      for (const injected of FixtureSocket.beforeWelcome) this.reply(injected.type, injected.payload)
      this.reply('welcome', { hb_interval_s: FixtureSocket.intervalSeconds,
        ...(FixtureSocket.timeoutSeconds === undefined ? {} : { hb_timeout_s: FixtureSocket.timeoutSeconds }),
        ...(FixtureSocket.features === undefined ? {} : { features: FixtureSocket.features }) })
    }
    if (frame.type === 'auth') {
      for (const injected of FixtureSocket.beforeAuth) this.reply(injected.type, injected.payload)
      this.reply('auth_ok', { worker_id: 'worker-1', owner_id: 2 })
    }
    if (frame.type === 'hb' && !FixtureSocket.muteAcks) this.reply('hb_ack', {})
  }
  close() { this.closes += 1; this.readyState = 3; this.dispatchEvent(new Event('close')) }
  reply(type: string, payload: Record<string, unknown>) { this.raw(JSON.stringify({ v: '8.0', type, payload })) }
  /** 原样注入一段报文，用来验证"真正非法的帧"仍走既有边界。 */
  raw(data: string) { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data }))) }
}
const offer = { workload_id: 'workload-1', shard_id: 'shard-1', attempt: 0, task_type: 'word_count', runtime: 'python3', input_kind: 'inline',
  inline_input: 'untrusted task data', input_ref: '', input_refs: [], code_url: 'https://untrusted.example/script.py', code_sha256: '',
  timeout_s: 60, verification_policy: 'semantic', execution_model: '', capability: '', capability_version: '', lease_token: 'fixture-private-lease' }
let now = 1_000
function setup(extra: Partial<EdgeWorkerOptions> = {}) {
  const onOffer = vi.fn(async (_offer: EdgeTaskOffer, _signal: AbortSignal) => {})
  const onEvent = vi.fn()
  const onIgnoredFrame = vi.fn()
  const connection = new EdgeWorkerConnection({ origin: 'http://127.0.0.1:18941', tokenProvider: () => 'fixture-token', expectedOwnerId: 2,
    name: 'test', clientBuild: 'test', os: 'test', arch: 'test', capabilities: {}, allowedTaskTypes: ['word_count'],
    handshakeTimeoutMs: 1000, maxFrameBytes: 65536, maxOutputBytes: 4096, readLoad: () => 0, onOffer, onEvent, onIgnoredFrame,
    clock: () => now, ...extra })
  return { connection, onOffer, onEvent, onIgnoredFrame }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
beforeEach(() => {
  vi.stubGlobal('WebSocket', FixtureSocket)
  FixtureSocket.timeoutSeconds = 45
  FixtureSocket.intervalSeconds = 15
  FixtureSocket.features = undefined
  FixtureSocket.beforeWelcome = []
  FixtureSocket.beforeAuth = []
  FixtureSocket.muteAcks = false
  now = 1_000
})
afterEach(() => vi.unstubAllGlobals())

describe('未知帧容错（反向回归闸：改回 throw 必须红）', () => {
  it('忽略未知类型帧：会话不断、仍 ready、有留痕、同一连接后续派单照常受理', async () => {
    const { connection, onOffer, onEvent, onIgnoredFrame } = setup()
    await connection.connect(); connection.updateMode('running')
    const socket = FixtureSocket.latest
    now = 2_000; socket.reply('platform_new_frame', { secret_platform_body: 'do-not-retain' })
    await flush()
    now = 3_000; socket.reply('platform_new_frame', { second: true })
    await flush()
    // ① 绝不因未知帧断连（修复前这里必然 EDGE_PROTOCOL_INVALID + socket.close）。
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_PROTOCOL_INVALID' })
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'closed' }))
    expect(socket.closes).toBe(0)
    // ② 会话仍然是 ready，而且**本地下一次操作仍然可用**（不是"没关但已经废了"）。
    expect(connection.observe().stage).toBe('ready')
    expect(() => connection.updateMode('running')).not.toThrow()
    // ③ 留痕：帧类型、次数、首次/最近时刻，且**不含帧体**（未知帧里的数据一律不落地）。
    expect(connection.observe().ignoredFrames).toMatchObject({ total: 2, overflow: 0, records: [
      { frameType: 'platform_new_frame', count: 2, firstSeenAt: 2_000, lastSeenAt: 3_000, classification: 'unknown-type' },
    ] })
    expect(JSON.stringify(connection.observe())).not.toContain('do-not-retain')
    expect(onIgnoredFrame).toHaveBeenCalledTimes(2)
    expect(onIgnoredFrame.mock.calls[0]![0]).toMatchObject({ frameType: 'platform_new_frame', count: 1, firstSeenAt: 2_000 })
    // ④ 会话没坏：未知帧之后的真实派单照常走到回调。
    socket.reply('shard_assign', offer)
    await vi.waitFor(() => expect(onOffer).toHaveBeenCalledOnce())
    await connection.close()
  })

  it('握手各阶段收到未知类型帧也不拆会话', async () => {
    FixtureSocket.beforeWelcome = [{ type: 'platform_pre_welcome_frame', payload: { n: 1 } }]
    FixtureSocket.beforeAuth = [{ type: 'platform_pre_auth_frame', payload: { n: 2 } }]
    const { connection, onEvent } = setup()
    await connection.connect()
    expect(connection.observe().stage).toBe('ready')
    expect(connection.observe().ignoredFrames.records.map(record => record.frameType).sort())
      .toEqual(['platform_pre_auth_frame', 'platform_pre_welcome_frame'])
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'closed' }))
    await connection.close()
  })

  it('已知帧出现在错误阶段同样只是被忽略，不是拆会话', async () => {
    // `auth_ok` 在 ready 阶段出现：本节点不解释它，但也没有理由因此断链。
    const { connection, onEvent } = setup()
    await connection.connect()
    FixtureSocket.latest.reply('auth_ok', { worker_id: 'worker-1', owner_id: 2 })
    await flush()
    expect(connection.observe().stage).toBe('ready')
    expect(connection.observe().ignoredFrames.records).toMatchObject([{ frameType: 'auth_ok', classification: 'out-of-stage' }])
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'closed' }))
    await connection.close()
  })

  it.each([
    ['版本号不对', JSON.stringify({ v: '9.0', type: 'shard_assign', payload: {} })],
    ['payload 不是对象', JSON.stringify({ v: '8.0', type: 'shard_assign', payload: 'text' })],
    ['type 不是字符串', JSON.stringify({ v: '8.0', type: 7, payload: {} })],
    ['不是 JSON', 'not-json-at-all'],
    ['不是对象', '[]'],
  ])('真正非法的帧（%s）仍走既有边界：EDGE_PROTOCOL_INVALID', async (_name, raw) => {
    const { connection, onEvent } = setup()
    await connection.connect()
    FixtureSocket.latest.raw(raw)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_PROTOCOL_INVALID' }))
    expect(connection.observe().stage).toBe('closed')
    expect(connection.observe().closeReason).toBe('EDGE_PROTOCOL_INVALID')
    await connection.close()
  })

  it('已知帧的载荷被平台发坏时，仍是既有边界（不静默咽下）', async () => {
    const { connection, onEvent, onOffer } = setup()
    await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', { ...offer, attempt: -1 })
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_PROTOCOL_INVALID' }))
    expect(onOffer).not.toHaveBeenCalled()
    await connection.close()
  })

  it('未知帧洪水不会撑爆留痕表，也不会断连', async () => {
    const { connection, onEvent } = setup()
    await connection.connect()
    for (let index = 0; index < 200; index += 1) FixtureSocket.latest.reply(`unknown_frame_${index}`, { index })
    await flush()
    const { ignoredFrames } = connection.observe()
    expect(ignoredFrames.total).toBe(200)
    expect(ignoredFrames.records.length).toBeLessThanOrEqual(64)
    expect(ignoredFrames.overflow).toBeGreaterThan(0)
    expect(connection.observe().stage).toBe('ready')
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'closed' }))
    await connection.close()
  })
})

describe('能力协商：welcome.features 缺省即关闭', () => {
  it('welcome 缺 features ⇒ 全部可选帧关闭，节点自己声明支持也不算数', async () => {
    const handled: string[] = []
    const { connection } = setup({ supportedOptionalFrames: ['edge.optional.frame'], onOptionalFrame: type => handled.push(type) })
    await connection.connect()
    expect(connection.observe().features).toEqual({ platform: [], supported: ['edge.optional.frame'], negotiated: [], interpreted: [] })
    FixtureSocket.latest.reply('edge.optional.frame', { n: 1 })
    await flush()
    expect(handled).toEqual([])
    expect(connection.observe().ignoredFrames.records).toMatchObject([{ frameType: 'edge.optional.frame', count: 1 }])
    expect(connection.observe().stage).toBe('ready')
    await connection.close()
  })

  it('平台与节点双方都声明时才解释该可选帧', async () => {
    FixtureSocket.features = ['edge.optional.frame']
    const handled: { type: string; payload: Record<string, unknown> }[] = []
    const { connection } = setup({ supportedOptionalFrames: ['edge.optional.frame'], onOptionalFrame: (type, payload) => handled.push({ type, payload }) })
    await connection.connect()
    expect(connection.observe().features).toEqual({ platform: ['edge.optional.frame'], supported: ['edge.optional.frame'],
      negotiated: ['edge.optional.frame'], interpreted: ['edge.optional.frame'] })
    FixtureSocket.latest.reply('edge.optional.frame', { n: 3 })
    await flush()
    expect(handled).toEqual([{ type: 'edge.optional.frame', payload: { n: 3 } }])
    expect(connection.observe().ignoredFrames.total).toBe(0)
    await connection.close()
  })

  it('平台声明了但节点不支持 ⇒ 不解释，只留痕（不擅自解释新帧）', async () => {
    FixtureSocket.features = ['edge.future.frame']
    const handled: string[] = []
    const { connection } = setup({ supportedOptionalFrames: ['edge.optional.frame'], onOptionalFrame: type => handled.push(type) })
    await connection.connect()
    expect(connection.observe().features.negotiated).toEqual([])
    FixtureSocket.latest.reply('edge.future.frame', { n: 1 })
    await flush()
    expect(handled).toEqual([])
    expect(connection.observe().ignoredFrames.records).toMatchObject([{ frameType: 'edge.future.frame' }])
    expect(connection.observe().stage).toBe('ready')
    await connection.close()
  })

  it('features 形状非法 ⇒ 按"缺省即关闭"处理，且不拆会话', async () => {
    FixtureSocket.features = { 'edge.optional.frame': true }
    const handled: string[] = []
    const { connection, onEvent } = setup({ supportedOptionalFrames: ['edge.optional.frame'], onOptionalFrame: type => handled.push(type) })
    await connection.connect()
    expect(connection.observe().features).toMatchObject({ platform: [], negotiated: [], interpreted: [] })
    FixtureSocket.latest.reply('edge.optional.frame', { n: 1 })
    await flush()
    expect(handled).toEqual([])
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'closed' }))
    await connection.close()
  })

  it('features 里混入垃圾项：合法项保留、垃圾项丢弃', async () => {
    FixtureSocket.features = ['edge.optional.frame', 42, '', 'has space', 'UPPER.too.long.name'.repeat(8)]
    const { connection } = setup({ supportedOptionalFrames: ['edge.optional.frame'] })
    await connection.connect()
    expect(connection.observe().features.platform).toEqual(['edge.optional.frame'])
    await connection.close()
  })

  it('没有声明可选帧支持的节点，任何非必需帧都只是被忽略', async () => {
    FixtureSocket.features = ['edge.optional.frame']
    const { connection, onEvent } = setup()
    await connection.connect()
    expect(connection.observe().features).toEqual({ platform: ['edge.optional.frame'], supported: [], negotiated: [], interpreted: [] })
    FixtureSocket.latest.reply('edge.optional.frame', { n: 1 })
    await flush()
    expect(connection.observe().stage).toBe('ready')
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'closed' }))
    await connection.close()
  })
})

describe('握手可观测', () => {
  it('暴露 stage / 心跳间隔 / ack 超时 / 最近一次应答时刻，且不泄露凭据与帧体', async () => {
    const { connection } = setup()
    await connection.connect()
    const before = connection.observe()
    expect(before.stage).toBe('ready')
    expect(before.closeReason).toBeNull()
    expect(before.workerId).toBe('worker-1')
    expect(before.heartbeat).toEqual({ intervalSeconds: 15, ackTimeoutMs: 45_000, lastSentAt: 1_000, lastAckAt: 1_000, awaitingAckSince: null, healthy: true })
    expect(JSON.stringify(before)).not.toContain('fixture-token')
    expect(JSON.stringify(before)).not.toContain('fixture-private-lease')
    // 心跳应答来了 ⇒ 最近应答时刻前进；没来 ⇒ awaitingAckSince 固化，供可见性判断"对端不回了"。
    now = 16_000; connection.updateMode('running'); await flush()
    expect(connection.observe().heartbeat).toMatchObject({ lastSentAt: 16_000, lastAckAt: 16_000, healthy: true })
    FixtureSocket.muteAcks = true
    now = 31_000; connection.updateMode('paused'); await flush()
    expect(connection.observe().heartbeat).toMatchObject({ lastSentAt: 31_000, lastAckAt: 16_000, awaitingAckSince: 31_000, healthy: false })
    await connection.close()
  })

  it('心跳超时 ⇒ 以明确原因 fail，且原因不被随后的 socket close 覆盖', async () => {
    FixtureSocket.timeoutSeconds = 1
    vi.useFakeTimers()
    try {
      const { connection, onEvent } = setup({ handshakeTimeoutMs: 600_000 })
      const connected = connection.connect()
      await vi.advanceTimersByTimeAsync(60)
      await connected
      FixtureSocket.muteAcks = true
      connection.updateMode('running')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_HEARTBEAT_TIMEOUT' })
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_CONNECTION_CLOSED' })
      const after = connection.observe()
      expect(after.stage).toBe('closed')
      expect(after.closeReason).toBe('EDGE_HEARTBEAT_TIMEOUT')
      expect(after.heartbeat.awaitingAckSince).not.toBeNull()
      expect(FixtureSocket.latest.closes).toBe(1)
      await connection.close()
    } finally { vi.useRealTimers() }
  })
})

describe('重连退避：有上限 + 抖动 + 每次原因与耗时', () => {
  it('时间推进不产生无限次重连：延迟封顶 maxMs', () => {
    let clock = 0
    const backoff = new EdgeReconnectBackoff({ baseMs: 1_000, maxMs: 30_000, jitterRatio: 0.2, random: () => 1, clock: () => clock })
    const budgetMs = 10 * 60_000
    let reconnects = 0
    while (clock < budgetMs) { const plan = backoff.next('EDGE_CONNECTION_CLOSED', 5); clock += plan.delayMs + 5; reconnects += 1 }
    // 封顶 30 秒 + 10 分钟预算 ⇒ 上限 = ceil(600/30) + 5 次封顶前的尝试 + 1 = 26 次；
    // 而恒定的 2 秒重试（今天守护进程的实际行为）在这一预算内是 300 次。
    expect(reconnects).toBeLessThanOrEqual(Math.ceil(budgetMs / 30_000) + 6)
    expect(backoff.history().every(plan => plan.delayMs >= 1 && plan.delayMs <= 30_000)).toBe(true)
    expect(backoff.history().at(-1)!.delayMs).toBe(30_000)
    expect(backoff.attempt).toBe(reconnects)
  })

  it('抖动有界且可注入（同一输入 ⇒ 同一序列），每次重连记录原因与上一次会话耗时', () => {
    const sequence = [0, 1, 0.5]
    let index = 0
    const backoff = new EdgeReconnectBackoff({ baseMs: 1_000, maxMs: 60_000, jitterRatio: 0.5,
      random: () => sequence[index++ % sequence.length]!, clock: () => 7 })
    expect(backoff.next('EDGE_HANDSHAKE_TIMEOUT', 123))
      .toEqual({ attempt: 1, delayMs: 500, reason: 'EDGE_HANDSHAKE_TIMEOUT', lastSessionMs: 123, at: 7 })
    expect(backoff.next('EDGE_HEARTBEAT_TIMEOUT', 456)).toMatchObject({ attempt: 2, delayMs: 3_000, reason: 'EDGE_HEARTBEAT_TIMEOUT', lastSessionMs: 456 })
    expect(backoff.next('EDGE_CONNECTION_CLOSED', 0)).toMatchObject({ attempt: 3, delayMs: 4_000 })
    // 抖动不会把延迟推出上限；记录是审计轨迹，重置计数器不抹掉它。
    for (let attempt = 0; attempt < 20; attempt += 1) expect(backoff.next('EDGE_CONNECTION_CLOSED').delayMs).toBeLessThanOrEqual(60_000)
    expect(backoff.history().map(plan => plan.reason)).toHaveLength(23)
    backoff.reset()
    expect(backoff.attempt).toBe(0)
    expect(backoff.next('EDGE_CONNECTION_CLOSED').attempt).toBe(1)
    expect(backoff.history()).toHaveLength(24)
  })

  it('拒绝会造出无限重连或零延迟的配置', () => {
    expect(() => new EdgeReconnectBackoff({ baseMs: 0 })).toThrow('EDGE_RECONNECT_CONFIG_INVALID')
    expect(() => new EdgeReconnectBackoff({ baseMs: 5_000, maxMs: 1_000 })).toThrow('EDGE_RECONNECT_CONFIG_INVALID')
    expect(() => new EdgeReconnectBackoff({ jitterRatio: 2 })).toThrow('EDGE_RECONNECT_CONFIG_INVALID')
    expect(() => new EdgeReconnectBackoff({ baseMs: 250, maxMs: 1_000, jitterRatio: 0 })).not.toThrow()
  })
})

/**
 * 外来补丁里我**保留**的那一部分（不属于我这份工单）：进度单调守卫。
 *
 * 它与我的实现不重复（我这边没有进度语义），而且补上了 `reportProgress` 的一个真实缺口：
 * 回退的进度曾经能被原样发出去。保留它就要有钉子，所以在这里钉住——它一旦被改坏，这里红。
 */
describe('保留的外来片段：进度单调守卫', () => {
  it('回退的进度被本地拒发（EDGE_PROGRESS_REGRESSION），会话不受影响，前进的进度照发', async () => {
    const { connection, onOffer } = setup()
    await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', offer)
    await vi.waitFor(() => expect(onOffer).toHaveBeenCalledOnce())
    const accepted = onOffer.mock.calls[0]![0] as EdgeTaskOffer
    connection.reportProgress(accepted, 0.5)
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'shard_progress', payload: { pct: 0.5 } })
    expect(() => connection.reportProgress(accepted, 0.25)).toThrow('EDGE_PROGRESS_REGRESSION')
    expect(connection.observe().stage).toBe('ready')
    connection.reportProgress(accepted, 0.75)
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'shard_progress', payload: { pct: 0.75 } })
    await connection.close()
  })
})

/**
 * 源码层的反向回归闸。
 *
 * @param source - `connection.ts` 的源码文本。
 * @returns 违规项；空数组 = 未知帧容错的三条底线都还在。
 */
function auditUnknownFramePath(source: string): string[] {
  const findings: string[] = []
  if (/throw[^\n]*(unsupported frame|unrecognized frame|unknown frame type)/iu.test(source)) {
    findings.push('未知帧又变回 throw 了：它会冒到 message 监听器里被 fail 成 EDGE_PROTOCOL_INVALID，第一帧就拆会话')
  }
  if (!/this\.ignoreFrame\(/u.test(source)) findings.push('未知帧没有走「忽略 + 留痕」通路')
  if (!/frame\.v !== '8\.0'/u.test(source)) findings.push('信封校验被一并删掉了：真正非法帧的既有边界也必须留着')
  return findings
}

describe('反向回归闸（源码审计）：改回 throw 必须红', () => {
  it('修复前的原文会被审计抓出来（这就是"改回 throw 必须红"的证明）', () => {
    // `git show 9c153d142d411bba8fe2ac9303d28aadaac6bfc3:packages/host/compute-core/src/edge-worker/connection.ts`
    // 的第 203-205 行，逐字抄录：修复前这里对任何非白名单帧一律 throw。
    const preFix = `    if (this.stage !== 'ready') return
    if (frame.type === 'hb_ack') { this.cancelWatchdog(); this.options.onEvent({ type: 'heartbeat-acknowledged' }); return }
    if (frame.type === 'shard_cancel') { this.fail('EDGE_CANCEL_RECONCILIATION_REQUIRED'); return }
    if (frame.type !== 'shard_assign') throw new Error('unsupported frame')
    const offer = parseOffer(payload, this.workerId)`
    expect(auditUnknownFramePath(preFix)).toContain(
      '未知帧又变回 throw 了：它会冒到 message 监听器里被 fail 成 EDGE_PROTOCOL_INVALID，第一帧就拆会话')
    expect(auditUnknownFramePath(preFix)).toHaveLength(3)
  })

  it('当前源码通过审计：未知帧走忽略通路，信封边界仍留着', () => {
    const source = readFileSync(new URL('../../src/edge-worker/connection.ts', import.meta.url), 'utf8')
    expect(auditUnknownFramePath(source)).toEqual([])
  })
})
