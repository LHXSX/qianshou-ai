/**
 * E9 · 本地状态出口的四条闸：字段齐全并随任务状态变化 / 非本机来源取不到 / 中止经端点触发并留痕 / 离线明确。
 *
 * 这四条闸测的是**同一个 handler**（真实 HTTP）与**同一个 ledger**（同一份记录），不是它们的复制品：
 * ①②③④ 全部通过 `startNodeStatusSurface` 起的真实 `127.0.0.1` 服务；② 额外直接驱动
 * {@link createNodeStatusHandler}，因为"非本机来源"在本机无法用真实 socket 复现。
 */
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EdgeInlineResult, EdgeResultSent, EdgeTaskOffer } from '@deepseek-ai/dsh-compute-core'
import { OWNER_CANCEL_CODE, OWNER_CANCEL_STATE } from '../owner-abort.ts'
import { createNodeStatusTracker, observeNodeConnection, type NodeExecutionPort, type NodeStatusSnapshot } from '../node-status.ts'
import { createNodeStatusHandler, isLoopbackPeer, startNodeStatusSurface, type NodeStatusSurface } from '../node-status-server.ts'

const OFFER: EdgeTaskOffer = {
  workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 2,
  taskType: 'word_count', runtime: 'node', inputKind: 'inline', inlineInput: 'Hello hello 世界',
  inputRef: '', inputRefs: [], codeUrl: '', codeSha256: '', timeoutSeconds: 60,
  verificationPolicy: 'semantic', executionModel: '', capability: 'text.transform', capabilityVersion: '1.0.0',
}

const ONLINE = { core: 'https://qianshousuanli.com', workerId: 'worker-1', ownerId: 167, mode: 'running' } as const

/** 一个可推的本地时钟：快照里的"已经跑了多久"必须能被断言，而不是靠睡眠。 */
let now = 1_700_000_000_000
const clock = () => now

const surfaces: NodeStatusSurface[] = []

beforeEach(() => { now = 1_700_000_000_000 })
afterEach(async () => { for (const surface of surfaces.splice(0)) await surface.close() })

/** 只记录"往链路上真的发了什么"的传输替身；它是被观察的那一侧，不是被断言的那一侧。 */
function transportStub() {
  const frames: { readonly type: string; readonly code?: string }[] = []
  const port: NodeExecutionPort = {
    reportProgress: () => { frames.push({ type: 'progress' }) },
    complete: (): EdgeResultSent => { frames.push({ type: 'result' }); return { state: 'sent-awaiting-verification' } },
    reject: (_identity, failure): void => { frames.push({ type: 'refuse', code: failure.code }) },
  }
  return { frames, port }
}

/** 端点 + ledger 的真装配：测试里没有第二份状态。 */
async function harness(options: { readonly proof?: string } = {}) {
  const status = createNodeStatusTracker({ clock, pid: 4242 })
  const transport = transportStub()
  const observed = observeNodeConnection(transport.port, status)
  const surface = await startNodeStatusSurface({
    port: 0,
    proof: options.proof ?? '',
    status: () => status.snapshot(),
    stopOwnerTasks: input => status.stopOwnerTasks({ target: input.target, reason: input.reason, reject: observed.reject }),
  })
  surfaces.push(surface)
  return { status, transport, observed, surface }
}

/** 从真实服务读一份快照。 */
async function readStatus(surface: NodeStatusSurface): Promise<NodeStatusSnapshot> {
  const response = await fetch(`${surface.origin}/status`)
  expect(response.status).toBe(200)
  return await response.json() as NodeStatusSnapshot
}

/** 经真实 HTTP 发一条主人命令。 */
async function command(surface: NodeStatusSurface, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${surface.origin}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json() as Record<string, unknown> }
}

/** 一个本机的非回环地址；容器/CI 里可能没有，没有时 §② 的网络那一跳自我跳过。 */
function nonLoopbackIPv4(): string | undefined {
  for (const group of Object.values(networkInterfaces())) {
    for (const address of group ?? []) if (address.family === 'IPv4' && !address.internal) return address.address
  }
  return undefined
}

const lanAddress = nonLoopbackIPv4()

describe('E9 ① 端点输出字段齐全，且随任务状态变化', () => {
  it('快照字段集合被钉死；空闲、执行中、已回传、被拒绝四态各不相同', async () => {
    const { status, observed, surface } = await harness()
    status.connectionOnline(ONLINE)

    const idle = await readStatus(surface)
    expect(Object.keys(idle).sort()).toEqual([
      'connection', 'counters', 'current', 'earnings', 'lastRefusal', 'pid', 'recent', 'schema', 'startedAt', 'tasks', 'uptimeSeconds',
    ])
    expect(Object.keys(idle.connection).sort()).toEqual([
      'core', 'mode', 'onlineSeconds', 'onlineSince', 'ownerId', 'reason', 'state', 'workerId',
    ])
    expect(Object.keys(idle.counters).sort()).toEqual([
      'accepted', 'canceledByOwner', 'failed', 'offersReceived', 'rejected', 'succeeded',
    ])
    expect(idle.schema).toBe('qianshou.node-status.v1')
    expect(idle.pid).toBe(4242)
    expect(idle.connection.state).toBe('online')
    expect(idle.connection.workerId).toBe('worker-1')
    expect(idle.connection.ownerId).toBe(167)
    expect(idle.connection.mode).toBe('running')
    expect(idle.current).toBeNull()
    expect(idle.tasks).toEqual([])
    expect(idle.lastRefusal).toBeNull()
    expect(idle.recent).toEqual([])
    expect(idle.counters).toEqual({ offersReceived: 0, accepted: 0, succeeded: 0, failed: 0, rejected: 0, canceledByOwner: 0 })

    // 已上线时长随时钟前进，而不是恒为 0 或一次定值。
    expect(idle.connection.onlineSeconds).toBe(0)
    now += 30_000
    expect((await readStatus(surface)).connection.onlineSeconds).toBe(30)

    // 派单到手但还没开始执行：已接单数不动，current 已经指向它。
    const parent = new AbortController()
    status.offerDelivered(OFFER, parent.signal)
    const delivered = await readStatus(surface)
    expect(delivered.counters.offersReceived).toBe(1)
    expect(delivered.counters.accepted).toBe(0)
    expect(delivered.current).toMatchObject({ shardId: 'shard-1', workloadId: 'workload-1', attempt: 2, taskType: 'word_count', progressPct: 0, progressEvents: 0 })
    expect(delivered.current?.startedAt).toBe(new Date(now).toISOString())
    expect(Object.keys(delivered.current ?? {}).sort()).toEqual([
      'attempt', 'elapsedMs', 'progressEvents', 'progressPct', 'shardId', 'startedAt', 'taskType', 'workloadId',
    ])

    // 开始执行（runner 自己的 shard_progress 0）⇒ 接单数 +1；进度是**测到的**，不是猜的。
    now += 1500
    observed.reportProgress(OFFER, 0)
    const running = await readStatus(surface)
    expect(running.counters.accepted).toBe(1)
    expect(running.current?.elapsedMs).toBe(1500)
    expect(running.current?.progressEvents).toBe(1)
    expect(running.tasks).toHaveLength(1)

    observed.reportProgress(OFFER, 0.5)
    const halfway = await readStatus(surface)
    expect(halfway.current?.progressPct).toBe(50)
    expect(halfway.current?.progressEvents).toBe(2)

    // 回传 + 轮询核验结论：成功数 +1，current 清空，最近结果带上耗时与核验态。
    now += 500
    observed.complete(OFFER, { inlineOutputUtf8: '{"status":"ok"}', elapsedMs: 2000 })
    status.recordVerification('shard-1', 'workload-completed-shard-observed')
    const completed = await readStatus(surface)
    expect(completed.counters.succeeded).toBe(1)
    expect(completed.current).toBeNull()
    expect(completed.tasks).toEqual([])
    expect(completed.recent).toHaveLength(1)
    expect(completed.recent[0]).toMatchObject({
      shardId: 'shard-1', taskType: 'word_count', outcome: 'succeeded',
      durationMs: 2000, verification: 'workload-completed-shard-observed', reason: null,
    })
    expect(Object.keys(completed.recent[0] ?? {}).sort()).toEqual([
      'at', 'durationMs', 'outcome', 'reason', 'shardId', 'taskType', 'verification',
    ])

    // 拒绝一次：成功数不动，拒绝数 +1，最近一次拒绝原因带原文。
    status.offerDelivered({ ...OFFER, shardId: 'shard-2', workloadId: 'workload-2', attempt: 1 }, parent.signal)
    observed.reject({ ...OFFER, shardId: 'shard-2', workloadId: 'workload-2', attempt: 1 }, { code: 'EDGE_INPUT_UNSUPPORTED', message: 'Built-in node execution requires inline text' })
    const refused = await readStatus(surface)
    expect(refused.counters).toMatchObject({ offersReceived: 2, accepted: 1, succeeded: 1, rejected: 1, failed: 0 })
    expect(refused.lastRefusal).toMatchObject({
      shardId: 'shard-2', kind: 'refused', code: 'EDGE_INPUT_UNSUPPORTED',
      reason: 'Built-in node execution requires inline text', at: new Date(now).toISOString(),
    })
    expect(refused.current).toBeNull()
    expect(refused.recent.map(entry => entry.outcome)).toEqual(['succeeded', 'refused'])
  })

  it('执行失败的拒绝记为 failed 而不是 refused（两者在快照里可分）', async () => {
    const { status, observed, surface } = await harness()
    status.connectionOnline(ONLINE)
    status.offerDelivered(OFFER, new AbortController().signal)
    observed.reportProgress(OFFER, 0)
    observed.reject(OFFER, { code: 'EDGE_EXECUTION_FAILED', message: 'Built-in node execution failed' })
    const snapshot = await readStatus(surface)
    expect(snapshot.counters).toMatchObject({ accepted: 1, rejected: 0, failed: 1 })
    expect(snapshot.lastRefusal).toMatchObject({ kind: 'failed', code: 'EDGE_EXECUTION_FAILED' })
  })

  it('预计收益如实报"在派单帧里没有钱"，不猜一个数字', async () => {
    const { surface } = await harness()
    const snapshot = await readStatus(surface)
    expect(snapshot.earnings.estimatedNodeYuan).toBeNull()
    expect(snapshot.earnings.basis).toBe('not-carried-in-dispatch-frame')
  })
})

describe('E9 ② 未授权 / 非本机来源取不到（安全闸）', () => {
  it('服务只绑 127.0.0.1，且本机其它地址连不上', async () => {
    const { surface } = await harness()
    expect(surface.address).toBe('127.0.0.1')
    expect(surface.origin).toBe(`http://127.0.0.1:${surface.port}`)
    expect(surface.port).toBeGreaterThan(0)
  })

  it.skipIf(lanAddress === undefined)('经本机非回环地址访问被拒（不是靠"没监听"侥幸）', async () => {
    const { surface } = await harness()
    await expect(fetch(`http://${lanAddress}:${surface.port}/status`)).rejects.toThrow()
  })

  it('非回环来源一律 403，即使命中的是同一条路由', async () => {
    const status = createNodeStatusTracker({ clock })
    const handler = createNodeStatusHandler({ status: () => status.snapshot(), proof: '', stopOwnerTasks: () => { throw new Error('must not be reachable') } })
    const remote = await callHandler(handler, { method: 'GET', url: '/status', peer: '203.0.113.9' })
    expect(remote.code).toBe(403)
    expect(remote.body.code).toBe('NODE_STATUS_NOT_LOCAL')
    expect(remote.body.ok).toBe(false)
    expect(isLoopbackPeer('203.0.113.9')).toBe(false)
    expect(isLoopbackPeer('127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('::1')).toBe(true)
    expect(isLoopbackPeer(undefined)).toBe(false)
    // 同一 handler、同一条路由，回环来源必须真的取得到（否则上面那条 403 可能只是"全拒"）。
    const local = await callHandler(handler, { method: 'GET', url: '/status', peer: '127.0.0.1' })
    expect(local.code).toBe(200)
    expect(local.body.ok).toBeUndefined()
    expect(local.body.schema).toBe('qianshou.node-status.v1')
  })

  it('带浏览器 Origin 的请求一律 403（网页不能驱动本机中止）', async () => {
    const { surface } = await harness()
    const response = await fetch(`${surface.origin}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://qianshousuanli.com' },
      body: JSON.stringify({ command: 'tasks' }),
    })
    expect(response.status).toBe(403)
    expect((await response.json() as Record<string, unknown>).code).toBe('NODE_STATUS_BROWSER_ORIGIN_REFUSED')
  })

  it('配了本地口令就必须出示；口令只从环境变量来，不从请求体来', async () => {
    const { surface } = await harness({ proof: 'owner-only-secret' })
    const without = await command(surface, { command: 'tasks' })
    expect(without.response.status).toBe(403)
    expect(without.body.code).toBe('NODE_STATUS_PROOF_REQUIRED')
    const wrong = await command(surface, { command: 'tasks' }, { 'x-owner-proof': 'guess' })
    expect(wrong.response.status).toBe(403)
    const right = await command(surface, { command: 'tasks' }, { 'x-owner-proof': 'owner-only-secret' })
    expect(right.response.status).toBe(200)
    expect(right.body.ok).toBe(true)
  })

  it('请求体不能自带 source：来源由本地通道决定，不从数据里解析', async () => {
    const { surface } = await harness()
    const injected = await command(surface, { command: 'abort', target: 'all', source: 'owner-local' })
    expect(injected.response.status).toBe(400)
    expect(injected.body.code).toBe('NODE_STATUS_SOURCE_NOT_ACCEPTED')
  })

  it('未知路由/坏 JSON/坏命令都是 4xx，不是 500', async () => {
    const { surface } = await harness()
    expect((await fetch(`${surface.origin}/unknown`)).status).toBe(404)
    expect((await fetch(`${surface.origin}/status`, { method: 'DELETE' })).status).toBe(405)
    const bad = await fetch(`${surface.origin}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(bad.status).toBe(400)
    const unknown = await command(surface, { command: 'shutdown' })
    expect(unknown.response.status).toBe(400)
    expect(unknown.body.code).toBe('NODE_STATUS_COMMAND_UNKNOWN')
  })
})

describe('E9 ③ 主人中止可从端点触发并留痕', () => {
  it('平台或任务方当来源时不中止，执行继续', async () => {
    const { status } = await harness()
    status.connectionOnline(ONLINE)
    const parent = new AbortController()
    const taskSignal = status.offerDelivered(OFFER, parent.signal)
    const outcome = status.stopOwnerTasks({
      target: 'all', reason: '平台要求停', source: 'platform',
      reject: () => { throw new Error('unauthorized source must not send a frame') },
    })
    expect(outcome.stopped).toBe(false)
    expect(outcome.retryScheduled).toBe(false)
    expect(outcome.aborted).toEqual([])
    expect(outcome.skipped).toEqual([{ shardId: 'shard-1', why: 'unauthorized' }])
    expect(taskSignal.aborted).toBe(false)
    expect(status.snapshot().tasks.map(task => task.shardId)).toEqual(['shard-1'])
  })

  it('abort all 真的停掉执行、真的发了拒绝帧，并记成 canceled-by-owner', async () => {
    const { status, transport, surface } = await harness()
    status.connectionOnline(ONLINE)
    const parent = new AbortController()
    const taskSignal = status.offerDelivered(OFFER, parent.signal)
    expect(taskSignal.aborted).toBe(false)
    status.observeProgress(OFFER, 0)

    const stopped = await command(surface, { command: 'abort', target: 'all', reason: '主人手动叫停' })
    expect(stopped.response.status).toBe(200)
    expect(stopped.body.ok).toBe(true)
    expect(stopped.body.command).toBe('abort')
    const outcome = stopped.body.outcome as Record<string, unknown>
    expect(outcome.state).toBe(OWNER_CANCEL_STATE)
    expect(outcome.aborted).toEqual(['shard-1'])
    expect(outcome.skipped).toEqual([])
    expect(outcome.reason).toBe('主人手动叫停')
    expect(outcome.stopped).toBe(true)
    expect(outcome.classifiedAsFailure).toBe(false)
    expect(outcome.retryScheduled).toBe(false)
    expect(outcome.refundRequested).toBe(false)

    // 真停：runner 拿到的那条 signal 已经 aborted；真发帧：链路上出现 E3 的中止码。
    expect(taskSignal.aborted).toBe(true)
    expect(transport.frames).toEqual([{ type: 'refuse', code: OWNER_CANCEL_CODE }])

    // 留痕：快照的四个位置同时改口，且不再是"在跑"。
    const snapshot = await readStatus(surface)
    expect(snapshot.counters.canceledByOwner).toBe(1)
    expect(snapshot.counters.accepted).toBe(1)
    expect(snapshot.current).toBeNull()
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.lastRefusal).toMatchObject({ shardId: 'shard-1', kind: 'canceled-by-owner', code: OWNER_CANCEL_CODE })
    expect(snapshot.recent[0]).toMatchObject({ shardId: 'shard-1', outcome: 'canceled-by-owner', reason: '主人手动叫停' })
  })

  it('tasks 命令列出正在跑什么；按 shardId 精确中止只动那一个', async () => {
    const { status, surface } = await harness()
    status.connectionOnline(ONLINE)
    const parent = new AbortController()
    const first = status.offerDelivered(OFFER, parent.signal)
    const second = status.offerDelivered({ ...OFFER, shardId: 'shard-2', workloadId: 'workload-2', attempt: 1 }, parent.signal)
    status.observeProgress(OFFER, 0)

    const listed = await command(surface, { command: 'tasks' })
    expect(listed.response.status).toBe(200)
    expect((listed.body.tasks as { shardId: string }[]).map(task => task.shardId)).toEqual(['shard-1', 'shard-2'])

    const one = await command(surface, { command: 'abort', target: 'shard-2', reason: '只停这一个' })
    expect((one.body.outcome as Record<string, unknown>).aborted).toEqual(['shard-2'])
    expect(first.aborted).toBe(false)
    expect(second.aborted).toBe(true)
    const snapshot = await readStatus(surface)
    expect(snapshot.tasks.map(task => task.shardId)).toEqual(['shard-1'])
    expect(snapshot.counters.canceledByOwner).toBe(1)

    // 点名一个不在跑的：如实说"没停到"，并带上跳过原因，而不是谎报成功。
    const missing = await command(surface, { command: 'abort', target: 'shard-404' })
    expect(missing.response.status).toBe(200)
    expect((missing.body.outcome as Record<string, unknown>).aborted).toEqual([])
    expect((missing.body.outcome as Record<string, unknown>).skipped).toEqual([{ shardId: 'shard-404', why: 'not-running' }])
  })

  it('一条中止过的任务不会被随后到达的结果改写（迟到结果不许覆盖主人的决定）', async () => {
    const { status, observed, surface } = await harness()
    status.connectionOnline(ONLINE)
    status.offerDelivered(OFFER, new AbortController().signal)
    status.observeProgress(OFFER, 0)
    await command(surface, { command: 'abort', target: 'all', reason: '叫停' })
    observed.complete(OFFER, { inlineOutputUtf8: '{"status":"ok"}', elapsedMs: 10 })
    const snapshot = await readStatus(surface)
    expect(snapshot.counters).toMatchObject({ succeeded: 0, canceledByOwner: 1 })
    expect(snapshot.recent[0]?.outcome).toBe('canceled-by-owner')
  })

  it('链路断了会连带停掉在跑的任务，但记的是 failed（不是主人的决定）', async () => {
    const { status, surface } = await harness()
    status.connectionOnline(ONLINE)
    const parent = new AbortController()
    const taskSignal = status.offerDelivered(OFFER, parent.signal)
    status.observeProgress(OFFER, 0)
    parent.abort()
    status.connectionOffline('EDGE_CONNECTION_CLOSED')
    const snapshot = await readStatus(surface)
    expect(taskSignal.aborted).toBe(true)
    expect(snapshot.counters).toMatchObject({ accepted: 1, canceledByOwner: 0, failed: 1 })
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.lastRefusal).toMatchObject({ shardId: 'shard-1', kind: 'failed', code: 'EDGE_LINK_LOST' })
    expect(snapshot.connection.state).toBe('offline')
  })
})

describe('E9 ④ 节点离线时端点给出明确的"离线"，不是 500', () => {
  it('未上线时报 connecting；掉线后报 offline + 原因，且 /status 仍然 200', async () => {
    const { status, surface } = await harness()
    const connecting = await readStatus(surface)
    expect(connecting.connection.state).toBe('connecting')
    expect(connecting.connection.reason).toBeNull()
    expect(connecting.connection.onlineSince).toBeNull()

    status.connectionOffline('EDGE_CONNECTION_CLOSED')
    const offline = await readStatus(surface)
    expect(offline.connection.state).toBe('offline')
    expect(offline.connection.reason).toBe('EDGE_CONNECTION_CLOSED')
    expect(offline.connection.onlineSince).toBeNull()
    expect(offline.connection.onlineSeconds).toBeNull()
    expect(offline.counters.offersReceived).toBe(0)
  })

  it('离线时中止请求返回 503 + NODE_OFFLINE（明确答复，不是 500）', async () => {
    const { status, surface } = await harness()
    status.connectionOffline('EDGE_HANDSHAKE_TIMEOUT')
    const stopped = await command(surface, { command: 'abort', target: 'all', reason: '离线叫停' })
    expect(stopped.response.status).toBe(503)
    expect(stopped.response.status).not.toBe(500)
    expect(stopped.body.ok).toBe(false)
    expect(stopped.body.code).toBe('NODE_OFFLINE')
    expect((stopped.body.connection as Record<string, unknown>).reason).toBe('EDGE_HANDSHAKE_TIMEOUT')
  })

  it('离线时仍可读 tasks（本地账不因掉线消失），但账里如实为空', async () => {
    const { status, surface } = await harness()
    status.connectionOnline(ONLINE)
    const parent = new AbortController()
    status.offerDelivered(OFFER, parent.signal)
    parent.abort()
    status.connectionOffline('EDGE_CONNECTION_CLOSED')
    const listed = await command(surface, { command: 'tasks' })
    expect(listed.response.status).toBe(200)
    expect(listed.body.tasks).toEqual([])
  })
})

/** 用最小替身直接驱动 handler：测的是 gate 本身，不是"有没有监听"。 */
async function callHandler(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  init: { readonly method: string; readonly url: string; readonly peer: string; readonly headers?: Record<string, string>; readonly body?: string },
): Promise<{ readonly code: number; readonly body: Record<string, unknown> }> {
  const chunks = init.body === undefined ? [] : [Buffer.from(init.body)]
  const request = {
    method: init.method,
    url: init.url,
    headers: init.headers ?? {},
    socket: { remoteAddress: init.peer },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  } as unknown as IncomingMessage
  let code = 0
  let text = ''
  const response = {
    headersSent: false,
    writeHead(status: number) { code = status; this.headersSent = true },
    end(payload?: string) { text = payload ?? '' },
  } as unknown as ServerResponse
  handler(request, response)
  await new Promise(resolve => setTimeout(resolve, 0))
  return { code, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> }
}
