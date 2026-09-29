import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { canonicalFileMetadata } from '@deepseek-ai/dsh-compute-core/edge-worker/file-task-contract'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId, HOST_SUPPLY_TOOLS, ISOLATED_INLINE_SESSION_DIGEST, ISOLATED_INLINE_SESSION_VERSION } from '@deepseek-ai/dsh-compute-core'
import { isResultAcceptanceObserved } from '@deepseek-ai/dsh-compute-core/edge-worker/polled-verification'
import { providedCapabilityAdsForIds } from '@deepseek-ai/dsh-compute-core/node-capability'
import type { NodeTaskOfferMessage } from '@deepseek-ai/dsh-compute-core/node-protocol'
import {
  bindInlineEdgeResident,
  DEFAULT_HELLO_TOOLS,
  defaultVerificationReader,
  helloToolsOf,
  type EdgeVerificationSession,
  type ResidentResultVerification,
  type ResidentVerificationWindow,
  type VerifiedTaskAdapterClaim,
} from '../src/edge-binding.ts'
import { FixtureWebSocketServer, type FixtureFrame, type FixtureServerContext } from '../../compute-core/tests/transport/fixture-ws-server.ts'

function binding(extra: Partial<Parameters<typeof bindInlineEdgeResident>[0]> = {}) {
  return bindInlineEdgeResident({
    nodeId: 'node-edge-1',
    agentVersion: 'agent-0.1.0',
    allowedTaskTypes: ['word_count'],
    handshakeTimeoutMs: 2000,
    maxFrameBytes: 65_536,
    maxOutputBytes: 4096,
    supply: () => 'running',
    originOf: () => null,
    tokenOf: async () => undefined,
    ownerIdOf: async () => undefined,
    ...extra,
  })
}

function auditedScript(frame: FixtureFrame, context: FixtureServerContext): void {
  if (frame.type === 'hello') context.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-17T04:00:00.000Z' })
  if (frame.type === 'auth') context.reply('auth_ok', { worker_id: 'worker-edge-1', owner_id: 7, reconnect: false })
  if (frame.type === 'hb') context.reply('hb_ack', {})
}

const servers: FixtureWebSocketServer[] = []
const roots: string[] = []
const readSides: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const server of readSides.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('announces a file runtime only through its dedicated current provider and withdraws it on recheck', async () => {
  const server = await FixtureWebSocketServer.start({ script: auditedScript })
  servers.push(server)
  const claim: VerifiedTaskAdapterClaim = { task_type: 'bounded_file_copy_v1', capability_id: 'files.copy',
    input_kinds: ['inline'], output_kind: 'artifact_ref', contract_version: 'v1',
    artifact_digest: `sha256:${'a'.repeat(64)}`, package_digest: `sha256:${'b'.repeat(64)}`,
    installation_state: 'installed', health: 'verified', self_test: 'passed' }
  const unsigned = { schema: 'qianshou.file-attachment-bindings.v1' as const, account_id: 42,
    task_type: claim.task_type, contract_sha256: `sha256:${'c'.repeat(64)}`, file_schema_sha256: 'd'.repeat(64), attachments: {} }
  const fileContract = { ...unsigned, bindings_sha256: 'sha256:' + createHash('sha256').update(canonicalFileMetadata(unsigned)).digest('hex') }
  let installed = true
  const edge = binding({ originOf: () => server.origin, tokenOf: async () => 'fixture-account', ownerIdOf: async () => 7,
    verification: false, probe: async () => { throw new Error('isolated measurement') },
    purchasedFileTaskAdapters: async () => installed ? [claim] : [],
    fileOrderRun: async () => { throw new Error('test never executes a task') } })
  const first = await edge.connector.connect(new AbortController().signal)
  await expect.poll(() => server.frames.filter(frame => frame.type === 'hello').length).toBe(1)
  const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
  expect(hello.verified_task_adapters).toEqual([claim])
  expect(hello.provided_capabilities).toContainEqual({ name: 'files.copy', version: '1.0.0', health: 'ok' })
  const offer = { workerId: 'worker-edge-1', workloadId: 'file-work', shardId: 'file-shard', attempt: 1,
    taskType: claim.task_type, runtime: 'quickjs-wasm', inputKind: 'inline', inlineInput: '{"text":"copy"}',
    inputRef: '', inputRefs: [], codeUrl: '', codeSha256: '', timeoutSeconds: 60,
    verificationPolicy: 'semantic' as const, executionModel: '', capability: '', capabilityVersion: '' }
  const context = { workerId: 'worker-edge-1', receivedAt: new Date().toISOString() }
  expect(edge.binding.bridge.toNodeOffer(offer, context)).toEqual({ refuse: 'FILE_CONTRACT_MISSING' })
  expect(edge.binding.bridge.toNodeOffer({ ...offer, fileContract }, context)).toMatchObject({ envelope: {
    capabilityId: 'files.copy', maxOutputBytes: 16384, parameters: { fileContract } } })
  await first.close()
  installed = false
  const second = await edge.connector.connect(new AbortController().signal)
  await expect.poll(() => server.frames.filter(frame => frame.type === 'hello').length).toBe(2)
  const next = server.frames.find(frame => frame.type === 'hello' && frame.connection === 1)?.payload.capabilities as Record<string, unknown>
  expect(next.verified_task_adapters).toEqual([])
  expect(edge.capabilities().some(item => item.capabilityId === 'files.copy')).toBe(false)
  expect(edge.binding.bridge.toNodeOffer({ ...offer, fileContract }, context)).toEqual({ refuse: 'TASK_TYPE_DENIED' })
  await second.close()
})

it.each(['ordinary', 'missing-runner', 'failed-check'] as const)(
  'does not announce file capability from %s alone', async kind => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    const claim: VerifiedTaskAdapterClaim = { task_type: 'bounded_file_copy_v1', capability_id: 'files.copy',
      input_kinds: ['inline'], output_kind: 'artifact_ref', contract_version: 'v1',
      artifact_digest: `sha256:${'a'.repeat(64)}`, package_digest: `sha256:${'b'.repeat(64)}`,
      installation_state: 'installed', health: 'verified', self_test: 'passed' }
    const edge = binding({ originOf: () => server.origin, tokenOf: async () => 'fixture-account', ownerIdOf: async () => 7,
      probe: async () => { throw new Error('isolated measurement') },
      ...(kind === 'ordinary' ? { purchasedTaskAdapters: async () => [claim] } : {
        purchasedFileTaskAdapters: async () => { if (kind === 'failed-check') throw new Error('revoked'); return [claim] },
      }), ...(kind === 'failed-check' ? { fileOrderRun: async () => { throw new Error('test never runs') } } : {}) })
    const session = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.filter(frame => frame.type === 'hello').length).toBe(1)
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
    expect(hello.verified_task_adapters).toEqual([])
    expect(edge.capabilities().some(item => item.capabilityId === 'files.copy')).toBe(false)
    await session.close()
  })

/**
 * E7 · 常驻路径"发出之后发生什么"。
 *
 * 这一组钉的是 `transport/edge-worker-session.ts:298` 丢弃 `complete()` 返回值留下的盲区：
 * 常驻路径过去连"自己是悬空的"都不知道。这里的断言里**没有** receipt/ack/confirmed ——
 * 平台不发确认帧，节点唯一能诚实观察到的只有平台**自己的**工作负载投影。
 */
/**
 * E7 · 常驻路径"发出之后发生什么"。
 *
 * 这一组钉的是 `transport/edge-worker-session.ts:298` 丢弃 `complete()` 返回值留下的盲区：
 * 常驻路径过去连"自己是悬空的"都不知道。断言里**没有** receipt / ack / confirmed —— 平台不发
 * 确认帧，节点唯一能诚实观察到的只有平台**自己的**工作负载投影（C25 已定的四态与映射表）。
 */
describe('resident path: 发出之后的轮询核验', () => {
  const TASK_ID = 'workload-1.shard-1'
  const ATTEMPT = 1

  /** 平台派给本节点的分片；`attempt: 0` ⇒ 常驻 seam 收下后的 node attempt 是 1。 */
  const ASSIGNMENT = {
    workload_id: 'workload-1', shard_id: 'shard-1', attempt: 0, task_type: 'word_count', runtime: 'node',
    input_kind: 'inline', inline_input: 'one two three', input_ref: '', input_refs: [],
    code_url: '', code_sha256: '', timeout_s: 60, verification_policy: 'semantic', execution_model: 'native',
    capability: 'word_count', capability_version: '1.0.0', lease_token: 'lease-token-1',
  }

  /** 心跳：运行时/会话发的第一拍把 supply 拨到 running，第二拍才派单，否则分片会撞上 `EDGE_SUPPLY_WITHDRAWN`。 */
  function assignmentScript(): (frame: FixtureFrame, context: FixtureServerContext) => void {
    let heartbeats = 0
    return (frame, context) => {
      if (frame.type === 'hello') context.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-22T00:00:00.000Z' })
      if (frame.type === 'auth') context.reply('auth_ok', { worker_id: 'worker-edge-1', owner_id: 7, reconnect: false })
      if (frame.type !== 'hb') return
      context.reply('hb_ack', {})
      heartbeats += 1
      if (heartbeats === 2) context.reply('shard_assign', ASSIGNMENT)
    }
  }

  const heartbeat = {
    version: 'qianshou.node.v1' as const, nodeId: 'node-edge-1' as never, agentVersion: 'agent-0.1.0',
    sentAt: '2026-09-22T00:00:00.000Z', capabilities: [], maxConcurrency: 1, runningTasks: 0,
  }

  /** 平台详情投影的原生形状（`supply/edge-api.ts:parseWorkload` 认的那一份）。 */
  function projection(completed: number, failed: number) {
    return {
      id: 'workload-1', name: 'task', status: 'RUNNING', progress: 0, total_shards: 1,
      completed_shards: completed, failed_shards: failed,
      created_at: '2026-09-22T00:00:00.000Z', completed_at: null,
    }
  }

  /** 一个真 HTTP 读侧。`onRead` 拿到"第几次读"和"此刻 socket 已发出的结果帧数"，让顺序断言不靠时间。 */
  async function readSide(
    readings: readonly Record<string, unknown>[],
    options: {
      status?: number
      /** Index from which reads start failing; lets the baseline succeed and the window fail. */
      failFrom?: number
      onRead?: (index: number, framesSent: number) => void
      framesSent?: () => number
    } = {},
  ) {
    const seen: string[] = []
    let index = 0
    const server = createServer((request, response) => {
      seen.push(String(request.url))
      options.onRead?.(index, options.framesSent?.() ?? 0)
      const failing = options.failFrom !== undefined && index >= options.failFrom
      const body = readings[Math.min(index, readings.length - 1)] ?? {}
      index += 1
      response.writeHead(failing ? 500 : options.status ?? 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    readSides.push(server)
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
  }

  /**
   * 连真 socket、收真分片、真发一条结果，然后等核验结论。
   *
   * 读侧默认用 `defaultVerificationReader`（真实 `EdgeSupplyApi`，生产用的就是它）指向真 HTTP 服务；
   * `readerOrigin` 可以把它指到一个不可达端口上。
   */
  async function sendOneResult(options: {
    readings: readonly Record<string, unknown>[]
    status?: number
    failFrom?: number
    onRead?: (index: number, framesSent: number) => void
    readerOrigin?: string
    window?: ResidentVerificationWindow
  }) {
    const socket = await FixtureWebSocketServer.start({ script: assignmentScript() })
    servers.push(socket)
    const framesSent = () => socket.frames.filter(frame => frame.type === 'shard_result').length
    const side = await readSide(options.readings, {
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.failFrom === undefined ? {} : { failFrom: options.failFrom }),
      ...(options.onRead === undefined ? {} : { onRead: options.onRead }),
      framesSent,
    })
    const edge = binding({
      originOf: () => socket.origin,
      tokenOf: async () => 'fixture-token',
      ownerIdOf: async () => 7,
      verification: {
        reader: defaultVerificationReader(options.readerOrigin ?? side.origin, 'fixture-token'),
        ...(options.window === undefined ? {} : { window: options.window }),
      },
    })
    const records: ResidentResultVerification[] = []
    const session = await edge.connector.connect(new AbortController().signal) as EdgeVerificationSession
    session.onResultVerification((record) => { records.push(record) })
    // 同步点用会话真正交给运行时的那个 offer：`shard_assign` 是服务器→客户端的帧，不会出现在
    // fixture 的客户端帧日志里，等它等于等一个永远不会发生的事件。
    let assigned: NodeTaskOfferMessage | null = null
    session.onOffer((offer) => { assigned = offer })
    await session.sendHeartbeat(heartbeat)
    await expect.poll(() => assigned?.envelope.taskId ?? null, { timeout: 5_000 }).toBe(TASK_ID)
    // 结果字节必须先被记住，`toEdgeResult` 才认得这条 taskId。
    edge.binding.rememberResult(TASK_ID, 'one\ttwo\tthree', 12)
    await session.sendReturn({ type: 'task.return', taskId: TASK_ID, attempt: ATTEMPT, outputs: [] })
    const verification = await session.resultVerification(TASK_ID, ATTEMPT)
    /** The frame itself is written asynchronously; wait for the socket to actually carry it. */
    const resultFrames = async (): Promise<number> => {
      await expect.poll(() => socket.frames.filter(frame => frame.type === 'shard_result').length, { timeout: 5_000 })
        .toBe(1)
      return socket.frames.filter(frame => frame.type === 'shard_result').length
    }
    return { session, socket, side, records, verification, resultFrames }
  }

  it('默认就带核验读侧，只有显式关掉才没有；转发不丢具体会话自己的成员', async () => {
    const socket = await FixtureWebSocketServer.start({ script: assignmentScript() })
    servers.push(socket)
    const on = binding({
      originOf: () => socket.origin, tokenOf: async () => 'fixture-token', ownerIdOf: async () => 7,
      verification: { reader: defaultVerificationReader('http://127.0.0.1:1', 'fixture-token') },
    })
    const session = await on.connector.connect(new AbortController().signal) as EdgeVerificationSession
    expect(typeof session.onResultVerification).toBe('function')
    expect(typeof session.resultVerification).toBe('function')
    // 代理没有吃掉具体会话的成员：连接器靠 `workerId` 避免重连注册幽灵节点，诊断靠 `state`/`failure`。
    expect(await session.resultVerification('nothing-was-sent', 1)).toBeNull()
    await session.close()

    const off = binding({
      originOf: () => socket.origin, tokenOf: async () => 'fixture-token', ownerIdOf: async () => 7,
      verification: false,
    })
    const plain = await off.connector.connect(new AbortController().signal)
    expect('onResultVerification' in plain).toBe(false)
    expect('resultVerification' in plain).toBe(false)
    // 关掉核验不影响结果本身：帧照样发得出去。
    expect(typeof plain.sendReturn).toBe('function')
    await plain.close()

    const acknowledged = binding({
      originOf: () => socket.origin, tokenOf: async () => 'fixture-token', ownerIdOf: async () => 7,
    })
    const wrapped = await acknowledged.connector.connect(new AbortController().signal)
    expect((wrapped as unknown as { workerId?: string }).workerId).toBe('worker-edge-1')
    expect(typeof (wrapped as unknown as { state?: unknown }).state).toBe('function')
    expect(typeof (wrapped as unknown as { failure?: unknown }).failure).toBe('function')
    await wrapped.close()
  })

  it('默认读侧就是平台自己的工作量详情端点，字段原生解析', async () => {
    const side = await readSide([projection(7, 2)])
    const reader = defaultVerificationReader(side.origin, 'fixture-token')
    const workload = await reader.queryWorkload('workload-1')
    expect(side.seen).toEqual(['/api/v8/workloads/workload-1'])
    expect(workload.completedShards).toBe(7)
    expect(workload.failedShards).toBe(2)
  })

  it('① 发出前读基线、发出后轮询：只有计数前进才是 observed，且帧确实出去了', { timeout: 30_000 }, async () => {
    const framesAtEachRead: number[] = []
    const out = await sendOneResult({
      readings: [projection(0, 0), projection(1, 0)],
      onRead: (_index, framesSent) => { framesAtEachRead.push(framesSent) },
    })
    // 第一次读（基线）时，socket 上还没有任何结果帧 ⇒ 基线来自"发出之前"，不是事后补的。
    expect(framesAtEachRead[0]).toBe(0)
    expect(framesAtEachRead.at(-1)).toBe(1)
    expect(out.side.seen.length).toBeGreaterThanOrEqual(2)
    expect(out.side.seen.every(url => url === '/api/v8/workloads/workload-1')).toBe(true)
    expect(await out.resultFrames()).toBe(1)
    expect(out.verification).toMatchObject({
      outcome: 'workload-completed-shard-observed',
      disposition: 'settleable',
      attribution: 'workload-aggregate-only',
      before: { completedShards: 0, failedShards: 0 },
      identity: { workerId: 'worker-edge-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0 },
    })
    expect(isResultAcceptanceObserved(out.verification!)).toBe(true)
    // 记录里带着**过去被丢弃**的那个传输事实（`edge-worker-session.ts:298`）。
    expect(out.records).toHaveLength(1)
    expect(out.records[0]).toMatchObject({
      taskId: TASK_ID, attempt: ATTEMPT, sent: 'sent-awaiting-verification',
      verification: { outcome: 'workload-completed-shard-observed' },
    })
    await out.session.close()
  })

  it('② 反向回归闸：计数不动的窗口是"待定"，既不是成功也不可结算', { timeout: 30_000 }, async () => {
    const out = await sendOneResult({
      readings: [projection(3, 0)],
      window: { timeoutMs: 60_000, maxPolls: 2, initialDelayMs: 1, maxDelayMs: 2 },
    })
    expect(out.verification).toMatchObject({ outcome: 'no-change-within-window', disposition: 'retained', polls: 2 })
    expect(isResultAcceptanceObserved(out.verification!)).toBe(false)
    // 反闸也走会话这一面：记录里的结论同样不是成功。
    expect(out.records[0]?.verification.disposition).toBe('retained')
    await out.session.close()
  })

  it('③ 基线读不到 ⇒ 核验一次请求都不发；结果帧照发', { timeout: 30_000 }, async () => {
    const out = await sendOneResult({
      readings: [projection(1, 0)],
      status: 403,
      // 这一条判的是"短路"，不是窗口长度：把等待压到毫秒，形状不变。
      window: { timeoutMs: 60_000, maxPolls: 2, initialDelayMs: 1, maxDelayMs: 2 },
    })
    // 唯一那次请求是失败的基线读，之后一次核验请求都没有发出去。
    expect(out.side.seen).toHaveLength(1)
    expect(out.verification).toMatchObject({
      outcome: 'unobservable', disposition: 'indeterminate', code: 'EDGE_VERIFICATION_NO_BASELINE',
      polls: 0, after: null, before: null,
    })
    expect(isResultAcceptanceObserved(out.verification!)).toBe(false)
    // 读不到不等于不发：产物该发还得发，核验只是不许编。
    expect(await out.resultFrames()).toBe(1)
    await out.session.close()
  })

  it('④ 有界：读次数到顶就停（maxPolls 是硬上限，不是建议）', { timeout: 30_000 }, async () => {
    const out = await sendOneResult({
      readings: [projection(0, 0)],
      window: { timeoutMs: 60_000, maxPolls: 2, initialDelayMs: 1, maxDelayMs: 2 },
    })
    expect(out.verification).toMatchObject({ polls: 2, outcome: 'no-change-within-window' })
    // 恰好 2 次核验读 + 1 次基线读：多一次都算越界。
    expect(out.side.seen).toHaveLength(3)
    await out.session.close()
  })

  it('④-bis 有界：墙钟预算到点就停（预算短于首等 ⇒ 一次都不读）', { timeout: 30_000 }, async () => {
    const out = await sendOneResult({
      readings: [projection(0, 0)],
      window: { timeoutMs: 1, maxPolls: 6, initialDelayMs: 5, maxDelayMs: 8 },
    })
    expect(out.verification).toMatchObject({ outcome: 'unobservable', polls: 0, after: null })
    expect(out.side.seen).toHaveLength(1)
    await out.session.close()
  })

  it('②-bis 读侧不可达 ⇒ 连基线都没有 ⇒ 是有界的"未知"，且一次核验读都不发', { timeout: 30_000 }, async () => {
    const out = await sendOneResult({
      readings: [projection(0, 0)],
      readerOrigin: 'http://127.0.0.1:1',
      window: { timeoutMs: 60_000, maxPolls: 2, initialDelayMs: 1, maxDelayMs: 2 },
    })
    expect(out.verification).toMatchObject({
      outcome: 'unobservable', disposition: 'indeterminate', polls: 0, after: null, before: null,
      code: 'EDGE_VERIFICATION_NO_BASELINE',
    })
    expect(isResultAcceptanceObserved(out.verification!)).toBe(false)
    // 注入的读侧压根没被碰到过（那是另一个 origin），结论仍然只是"未知"。
    expect(out.side.seen).toEqual([])
    await out.session.close()
  })

  it('②-ter 窗口内每次读都失败 ⇒ failedPolls 是非零的"未知"，不是成功', { timeout: 30_000 }, async () => {
    const out = await sendOneResult({
      readings: [projection(0, 0)],
      // 基线读成功（第 0 次），窗口内的两次读全失败。
      failFrom: 1,
      window: { timeoutMs: 60_000, maxPolls: 2, initialDelayMs: 1, maxDelayMs: 2 },
    })
    expect(out.verification).toMatchObject({
      outcome: 'unobservable', disposition: 'indeterminate', polls: 2, failedPolls: 2, after: null,
      before: { completedShards: 0, failedShards: 0 },
    })
    expect(out.verification?.code).not.toBeNull()
    expect(isResultAcceptanceObserved(out.verification!)).toBe(false)
    // 1 次基线 + 2 次失败的核验读：有界，且失败没有被折算成任何结论。
    expect(out.side.seen).toHaveLength(3)
    await out.session.close()
  })
})

describe('inline Edge resident binding', () => {
  it('advertises only the listed inline types and refuses connect without origin, token or owner', async () => {
    const edge = binding()
    expect(edge.transport).toBe('edge-worker')
    expect(edge.workerId()).toBeNull()
    expect(edge.capabilities()).toEqual([{
      capabilityId: 'text.transform',
      version: ISOLATED_INLINE_SESSION_VERSION,
      pluginDigest: edge.binding.digest,
      dataScope: 'none',
      maxInputBytes: 0,
      maxOutputBytes: 4096,
      available: true,
    }])
    await expect(edge.connector.connect(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSPORT_NOT_CONFIGURED',
    })
    await expect(binding({ originOf: () => 'http://127.0.0.1:18941' }).connector.connect(new AbortController().signal))
      .rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
    await expect(binding({
      originOf: () => '',
      tokenOf: async () => 'token',
      ownerIdOf: async () => 7,
    }).connector.connect(new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSPORT_NOT_CONFIGURED' })
    await expect(binding({
      originOf: () => 'http://127.0.0.1:18941',
      tokenOf: async () => '',
      ownerIdOf: async () => 7,
    }).connector.connect(new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
    await expect(binding({
      originOf: () => 'http://127.0.0.1:18941',
      tokenOf: async () => 'token',
      ownerIdOf: async () => 0,
    }).connector.connect(new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
    await expect(binding({
      originOf: () => 'http://127.0.0.1:18941',
      tokenOf: async () => 'token',
      ownerIdOf: async () => 1.5,
    }).connector.connect(new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSPORT_AUTH_FAILED' })
    await expect(binding({
      originOf: () => 'https://127.0.0.1:1',
      tokenOf: async () => 'token',
      ownerIdOf: async () => 7,
    }).connector.connect(new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSPORT_NETWORK_FAILED' })
  })

  it('advertises a registered landing as its semantic capability id', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/edge-binding.ts', import.meta.url)), 'utf8')
    expect(source).toContain('capabilityIdIfRegistered(taskType)')
    expect(source).not.toContain('capabilityId: taskType,')
    expect(source).toContain('runnerOwnedCapabilityIds')
    expect(source).toContain('mergeProvidedCapabilityAds')
  })

  it('opens a real Edge socket when origin, token and owner id are present', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    const edge = binding({
      originOf: () => server.origin,
      tokenOf: async () => 'socket-fixture-token',
      ownerIdOf: async () => 7,
    })
    const session = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.map(frame => frame.type), { timeout: 5_000 })
      .toEqual(['hello', 'auth', 'hb'])
    await session.close()
  })

  it('advertises the shared host catalogue, ffmpeg and ffprobe included', () => {
    // Regression: this file's binding kept its own `node, git, python3` literal while the host supply
    // page probed `node, git, ffmpeg`, under a comment asserting the two were the same list. They were
    // not, so `hello` reported `software: ["node","git","python3"]` and every task type requiring
    // ffmpeg was unmatchable on a machine that had ffmpeg installed. Identity, not deep equality: a
    // second literal that happens to agree today is precisely the bug being pinned down.
    expect(DEFAULT_HELLO_TOOLS).toBe(HOST_SUPPLY_TOOLS)
    expect(helloToolsOf()).toBe(HOST_SUPPLY_TOOLS)
    expect(helloToolsOf().map(tool => tool.id)).toEqual(['node', 'git', 'python3', 'ffmpeg', 'ffprobe'])
    // A caller-injected list still wins; the fix removes a divergence, not a seam.
    const injected = [{ id: 'ffmpeg', name: 'FFmpeg', command: '/custom/ffmpeg', args: ['-version'] }]
    expect(helloToolsOf({ tools: injected })).toBe(injected)
  })

  it('marks types without a local runner unavailable', () => {
    const edge = binding({ allowedTaskTypes: ['ocr_image'] })
    expect(edge.capabilities()).toEqual([{
      capabilityId: 'ocr_image',
      version: ISOLATED_INLINE_SESSION_VERSION,
      pluginDigest: edge.binding.digest,
      dataScope: 'none',
      maxInputBytes: 0,
      maxOutputBytes: 4096,
      available: false,
    }])
    const agent = binding({ allowedTaskTypes: ['ocr_image'], agentTaskTypes: ['ocr_image'] })
    expect(agent.capabilities()[0]?.available).toBe(true)
  })

  it('advertises a measured machine profile and reuses the acknowledged worker id on reconnect', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    const edge = binding({
      originOf: () => server.origin,
      tokenOf: async () => 'socket-fixture-token',
      ownerIdOf: async () => 7,
      // Deterministic measured facts: the real probe shells out, and this case is about the hello.
      probe: async () => ({
        hardware: {
          platform: 'linux', arch: 'x64', cpuModel: 'fixture-cpu', logicalCores: 4,
          totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3, gpus: [], probeErrors: [],
        },
        localServices: [{
          id: 'python3', kind: 'tool' as const, name: 'Python 3', version: '3.12.0',
          verification: 'verified' as const, reason: null,
        }],
        activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null },
      }),
    })
    const first = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.map(frame => frame.type), { timeout: 5_000 })
      .toEqual(['hello', 'auth', 'hb'])
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
    // The platform's dispatcher reads `runtimes`, and its machine-identity dedupe reads
    // `hostname`/`os`/`arch`; a hello carrying neither is a machine that can run nothing, and a
    // reconnect that registers a second ghost node.
    expect(hello.runtimes).toEqual(['python3'])
    expect(hello.provided_capabilities).toEqual(providedCapabilityAdsForIds(['text.transform']))
    expect(JSON.stringify(hello.provided_capabilities)).not.toContain('word_count')
    expect(hello.software).toEqual(['python3'])
    expect(typeof hello.hostname).toBe('string')
    expect(typeof hello.os).toBe('string')
    expect(typeof hello.arch).toBe('string')
    expect(edge.workerId()).toBe('worker-edge-1')
    await first.close()

    const second = await edge.connector.connect(new AbortController().signal)
    await expect.poll(
      () => server.frames.filter(frame => frame.connection === 1).map(frame => frame.type),
      { timeout: 5_000 },
    ).toEqual(['hello', 'auth', 'hb'])
    const rehello = server.frames.find(frame => frame.type === 'hello' && frame.connection === 1)?.payload
    expect(rehello?.worker_id).toBe('worker-edge-1')
    await second.close()
  })

  it('does not advertise an unregistered or unrunnable type as a capability', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    const python3 = {
      hardware: {
        platform: 'linux', arch: 'x64', cpuModel: 'fixture-cpu', logicalCores: 4,
        totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3, gpus: [], probeErrors: [],
      },
      localServices: [{
        id: 'python3', kind: 'tool' as const, name: 'Python 3', version: '3.12.0',
        verification: 'verified' as const, reason: null,
      }],
      activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null },
    }
    const unavailable = binding({
      allowedTaskTypes: ['ocr_image'],
      originOf: () => server.origin,
      tokenOf: async () => 'socket-fixture-token',
      ownerIdOf: async () => 7,
      probe: async () => python3,
    })
    const session = await unavailable.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.map(frame => frame.type), { timeout: 5_000 })
      .toEqual(['hello', 'auth', 'hb'])
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
    expect(hello.provided_capabilities).toEqual([])
    await session.close()
  })

  it('reads market declarations on every hello and does not advertise one this node cannot run', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    let reads = 0
    const ids = ['image.generate']
    const edge = binding({
      originOf: () => server.origin,
      tokenOf: async () => 'socket-fixture-token',
      ownerIdOf: async () => 7,
      probe: async () => ({
        hardware: {
          platform: 'linux', arch: 'x64', cpuModel: 'fixture-cpu', logicalCores: 4,
          totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3, gpus: [], probeErrors: [],
        },
        localServices: [],
        activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null },
      }),
      marketCapabilityIds: () => { reads += 1; return ids },
    })
    const first = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.map(frame => frame.type), { timeout: 5_000 }).toEqual(['hello', 'auth', 'hb'])
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
    expect(hello.provided_capabilities).toEqual(providedCapabilityAdsForIds(['text.transform']))
    expect(JSON.stringify(hello.provided_capabilities)).not.toContain('image.generate')
    await first.close()
    ids.splice(0, ids.length, 'text.transform', 'image.generate')
    const second = await edge.connector.connect(new AbortController().signal)
    await expect.poll(
      () => server.frames.filter(frame => frame.connection === 1).map(frame => frame.type),
      { timeout: 5_000 },
    ).toEqual(['hello', 'auth', 'hb'])
    const again = server.frames.find(frame => frame.type === 'hello' && frame.connection === 1)?.payload.capabilities as Record<string, unknown>
    expect(again.provided_capabilities).toEqual(providedCapabilityAdsForIds(['text.transform']))
    expect(JSON.stringify(again.provided_capabilities)).not.toContain('image.generate')
    expect(reads).toBe(2)
    await second.close()
  })

  it('still advertises runner-owned capabilities when the probe throws', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    const edge = binding({
      originOf: () => server.origin,
      tokenOf: async () => 'socket-fixture-token',
      ownerIdOf: async () => 7,
      probe: async () => {
        throw new Error('probe failed')
      },
    })
    const session = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.map(frame => frame.type), { timeout: 5_000 })
      .toEqual(['hello', 'auth', 'hb'])
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
    expect(hello.provided_capabilities).toEqual(providedCapabilityAdsForIds(['text.transform']))
    expect(hello.runtimes).toBeUndefined()
    await session.close()
  })

  it('declares only self-tested exact inline adapters and updates the declaration on reconnect', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    const valid: VerifiedTaskAdapterClaim = {
      task_type: 'word_count', capability_id: 'text.transform', input_kinds: ['inline'],
      output_kind: 'inline_json', contract_version: 'v1',
      artifact_digest: `sha256:${ISOLATED_INLINE_SESSION_DIGEST}`,
      installation_state: 'builtin', health: 'verified', self_test: 'passed',
    }
    let available = true
    const edge = binding({
      originOf: () => server.origin,
      tokenOf: async () => 'socket-fixture-token',
      ownerIdOf: async () => 7,
      probe: async () => { throw new Error('machine probe unavailable') },
      taskAdapters: async () => available ? [
        valid,
        { ...valid, task_type: 'video_generate', capability_id: 'video.generate' },
        { ...valid, input_kinds: ['single_file'] },
        { ...valid, output_kind: 'artifact_ref' },
        { ...valid, health: 'unverified' as never },
      ] : [],
    })
    const first = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.map(frame => frame.type), { timeout: 5_000 }).toEqual(['hello', 'auth', 'hb'])
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload
    expect(hello?.protocol_capabilities).toEqual(['assignment-token.v1', 'task-adapters.v1'])
    expect((hello?.capabilities as Record<string, unknown>).verified_task_adapters).toEqual([valid])
    await first.close()

    available = false
    const second = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.filter(frame => frame.connection === 1).map(frame => frame.type),
      { timeout: 5_000 }).toEqual(['hello', 'auth', 'hb'])
    const next = server.frames.find(frame => frame.type === 'hello' && frame.connection === 1)?.payload
    expect(next?.protocol_capabilities).toEqual(['assignment-token.v1', 'task-adapters.v1'])
    expect((next?.capabilities as Record<string, unknown>).verified_task_adapters).toEqual([])
    await second.close()
  })

  it('includes a newly verified installed inline adapter in its first hello', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    let selfTestPassed = false
    const textSort: VerifiedTaskAdapterClaim = {
      task_type: 'text_sort', capability_id: 'text.transform', input_kinds: ['inline'],
      output_kind: 'inline_json', contract_version: 'v1', artifact_digest: `sha256:${'a'.repeat(64)}`,
      installation_state: 'installed', health: 'verified', self_test: 'passed',
    }
    const edge = binding({
      allowedTaskTypes: ['word_count', 'text_sort'],
      originOf: () => server.origin, tokenOf: async () => 'socket-fixture-token', ownerIdOf: async () => 7,
      probe: async () => { throw new Error('machine probe unavailable') },
      localTaskTypes: () => selfTestPassed ? ['text_sort'] : [],
      taskAdapters: async () => { selfTestPassed = true; return [textSort] },
    })
    const session = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.map(frame => frame.type), { timeout: 5_000 }).toEqual(['hello', 'auth', 'hb'])
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload
    expect((hello?.capabilities as Record<string, unknown>).verified_task_adapters).toEqual([textSort])
    await session.close()
  })

  it('advertises an independently installed v5 buyer runtime with its own capability, then withdraws it', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    const purchased: VerifiedTaskAdapterClaim = {
      task_type: 'legal_term_scan_v1', capability_id: 'legal.term_scan',
      input_kinds: ['inline'], output_kind: 'inline_json', contract_version: 'v1',
      artifact_digest: `sha256:${'a'.repeat(64)}`, package_digest: `sha256:${'b'.repeat(64)}`,
      installation_state: 'installed', health: 'verified', self_test: 'passed',
    }
    let loaded = true
    const edge = binding({
      originOf: () => server.origin, tokenOf: async () => 'socket-fixture-token',
      ownerIdOf: async () => 7,
      probe: async () => { throw new Error('machine probe unavailable') },
      purchasedTaskAdapters: async () => loaded ? [purchased] : [],
    })
    const first = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.filter(frame => frame.type === 'hello').length).toBe(1)
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
    expect(hello.verified_task_adapters).toContainEqual(purchased)
    expect(hello.provided_capabilities).toContainEqual({ name: 'legal.term_scan', version: '1.0.0', health: 'ok' })
    expect(edge.capabilities()).toContainEqual(expect.objectContaining({
      capabilityId: 'legal.term_scan', available: true,
    }))
    const offer = {
      workerId: 'worker-edge-1', workloadId: 'work-legal', shardId: 'shard-1', attempt: 0,
      taskType: 'legal_term_scan_v1', runtime: 'node', inputKind: 'inline',
      inlineInput: '{"text":"合同"}', inputRef: '', inputRefs: [], codeUrl: '', codeSha256: '',
      timeoutSeconds: 60, verificationPolicy: 'semantic' as const, executionModel: 'native',
      capability: 'legal.term_scan', capabilityVersion: '1.0.0',
    }
    const mapped = edge.binding.bridge.toNodeOffer(offer, {
      receivedAt: '2026-09-26T00:00:00.000Z', workerId: 'worker-edge-1',
    })
    expect('refuse' in mapped).toBe(false)
    if ('envelope' in mapped) expect(mapped.envelope.capabilityId).toBe('legal.term_scan')
    await first.close()

    loaded = false
    const second = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.filter(frame => frame.type === 'hello').length).toBe(2)
    const next = server.frames.find(frame => frame.type === 'hello' && frame.connection === 1)?.payload
    expect((next?.capabilities as Record<string, unknown>).verified_task_adapters).toEqual([])
    expect(edge.capabilities().some(item => item.capabilityId === 'legal.term_scan')).toBe(false)
    expect(edge.binding.bridge.toNodeOffer(offer, {
      receivedAt: '2026-09-26T00:00:00.000Z', workerId: 'worker-edge-1',
    })).toEqual({ refuse: 'TASK_TYPE_DENIED' })
    await second.close()
  })

  it('withdraws video.render when installed runtime changes without a source change', async () => {
    const server = await FixtureWebSocketServer.start({ script: auditedScript })
    servers.push(server)
    const digest = `sha256:${'d'.repeat(64)}`
    const packageDigest = `sha256:${'e'.repeat(64)}`
    let installedPackageDigest = packageDigest
    const edge = binding({
      allowedTaskTypes: ['word_count', 'bar_chart_svg_v1'],
      originOf: () => server.origin, tokenOf: async () => 'socket-fixture-token', ownerIdOf: async () => 7,
      probe: async () => { throw new Error('machine probe unavailable') },
      artifactOrder: {
        taskType: 'bar_chart_svg_v1',
        loadAndSelfTest: async () => ({
          taskType: 'bar_chart_svg_v1', inputKind: 'inline', outputKind: 'artifact_ref',
          contractVersion: 'v1', artifactDigest: digest, packageDigest: installedPackageDigest,
          outputFormats: ['gif', 'mp4'],
          run: async () => { throw new Error('not used') },
        }),
        publicationReady: async (candidateDigest, candidatePackageDigest) =>
          candidateDigest === digest && candidatePackageDigest === packageDigest,
      },
    })
    expect(edge.capabilities().map(item => item.capabilityId)).toEqual(['text.transform'])
    const first = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.map(frame => frame.type), { timeout: 5_000 }).toEqual(['hello', 'auth', 'hb'])
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
    expect(hello.verified_task_adapters).toEqual([{
      task_type: 'bar_chart_svg_v1', capability_id: 'video.render', input_kinds: ['inline'],
      output_kind: 'artifact_ref', contract_version: 'v1', artifact_digest: digest,
      package_digest: packageDigest,
      installation_state: 'installed', health: 'verified', self_test: 'passed',
    }])
    expect(hello.provided_capabilities).toContainEqual({ name: 'video.render', version: '1.0.0', health: 'ok' })
    expect(edge.artifactReady()).toBe(true)
    expect(edge.capabilities().find(item => item.capabilityId === 'video.render')?.available).toBe(true)
    await first.close()
    expect(edge.artifactReady()).toBe(false)

    installedPackageDigest = `sha256:${'f'.repeat(64)}`
    const second = await edge.connector.connect(new AbortController().signal)
    await expect.poll(() => server.frames.filter(frame => frame.connection === 1).map(frame => frame.type),
      { timeout: 5_000 }).toEqual(['hello', 'auth', 'hb'])
    const next = server.frames.find(frame => frame.type === 'hello' && frame.connection === 1)?.payload.capabilities as Record<string, unknown>
    expect(next.verified_task_adapters).toEqual([])
    expect(next.provided_capabilities).not.toContainEqual(expect.objectContaining({ name: 'video.render' }))
    expect(edge.artifactReady()).toBe(false)
    await second.close()
  })

  it('runs word_count locally and remembers UTF-8 bytes for the Edge result', async () => {
    const path = await mkdtemp(join(tmpdir(), 'qianshou-edge-word-count-'))
    roots.push(path)
    const edge = binding()
    const receipt = await edge.resultConsumer.consume({
      execution: {
        task: {
          version: 'qianshou.task.v1',
          taskId: ComputeTaskId('workload-1.shard-1'),
          capabilityId: ComputeCapabilityId('word_count'),
          capabilityVersion: '1.0.0',
          inputRefs: [],
          parameters: { taskType: 'word_count', inlineInput: 'one two three', runtime: 'node' },
          deadlineAt: '2026-09-17T04:01:00.000Z',
          maxOutputBytes: 4096,
          idempotencyKey: 'a'.repeat(64),
        },
        attempt: {
          taskId: 'workload-1.shard-1',
          attempt: 1,
          leaseId: 'lease-1',
          leaseExpiresAt: '2026-09-17T04:01:00.000Z',
          idempotencyKey: 'a'.repeat(64),
          envelopeFingerprint: 'b'.repeat(64),
          capabilityId: 'word_count',
          capabilityVersion: '1.0.0',
          capabilityPluginDigest: 'c'.repeat(64),
        },
        signal: new AbortController().signal,
        reportProgress: async () => undefined,
        source: { open: async () => new ReadableStream() },
        dataSource: {},
      },
      workspace: { path, outputs: Object.freeze([]), close: async () => undefined },
      signal: new AbortController().signal,
    })
    // `word_count` 回的是平台自己的执行器形状（`GET /api/v8/scripts/word_count.py/source`），
    // 不再是裸数字：平台按 `result_lines` 合并，裸数字会被合并成 0 行、交付物为空。
    const resultText = await readFile(join(path, 'result.txt'), 'utf8')
    expect(JSON.parse(resultText)).toMatchObject({
      status: 'ok', task_type: 'word_count',
      summary: { input_bytes: 13, total_tokens: 3, unique_tokens: 3, top_n_returned: 3, jieba_enabled: false },
      result_lines: ['one\t1', 'two\t1', 'three\t1'],
    })
    expect(receipt.outputs[0]?.name).toBe('result.txt')
    expect(edge.binding.bridge.toEdgeResult({
      type: 'task.return',
      taskId: 'workload-1.shard-1',
      attempt: 1,
      outputs: receipt.outputs,
    })).toMatchObject({ inlineOutputUtf8: resultText })
  })
})
