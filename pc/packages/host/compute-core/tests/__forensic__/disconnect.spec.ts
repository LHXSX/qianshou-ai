/**
 * 三种断链情形的真实测量（跑生产代码路径：部署装配 + 真 socket 会话 + 插件同款驱动）。
 *
 * 判据（每条都落到可核对的数字或原文）：
 *   ① 断链 → 重连耗时（毫秒）
 *   ② 重连后是否重新注册、是否被服务器认成同一条记录（hello 带 worker_id ⇒ welcome_back）
 *   ③ 重连后能不能再收到派单（服务器发 shard_assign ⇒ 节点回 shard_result）
 *   ④ 旧 socket 是不是在开新连接之前关掉的（「一行两会话」的直接判据）
 *   ⑤ 断网期间的连接尝试速率（重连风暴判据）
 */
import { expect, it } from 'vitest'
import type { ResidentSession } from '@deepseek-ai/dsh-compute-core/resident'
import { bindInlineEdgeResident } from '../../../../host/node-contributor/src/edge-binding.ts'
import { FlakyProxy, LocalGateway, assignment, sleep, summarize, waitFor } from './harness.ts'

const OWNER_ID = 7
const NODE_ID = 'qianshou-forensic-node'
const TOKEN = 'forensic-access-token'
/** 插件同款常驻驱动周期（plugin.ts: RESIDENT_TICK_MS）。 */
const TICK_MS = 1_000
const DEADLINE_MS = 45_000

type ConnectArgs = { origin: string; token: string; ownerId: number }

/** 生产装配：`bindInlineEdgeResident`（与 plugin.ts 同一条路径），只把凭据换成验收值。 */
function makeConnector(args: ConnectArgs) {
  const offers: unknown[] = []
  const disconnectReasons: string[] = []
  const edge = bindInlineEdgeResident({
    nodeId: NODE_ID,
    agentVersion: 'forensic-build-1',
    allowedTaskTypes: ['word_count'],
    handshakeTimeoutMs: 15_000,
    maxFrameBytes: 65_536,
    maxOutputBytes: 4096,
    supply: () => 'running',
    originOf: () => args.origin,
    tokenOf: async () => args.token,
    ownerIdOf: async () => args.ownerId,
    probe: async () => ({ hardware: { platform: 'darwin', arch: 'arm64', cpuModel: 'forensic-cpu', logicalCores: 8, totalMemoryBytes: 16 * 1024 ** 3, gpus: [] }, localServices: [] }) as never,
    tools: [],
  })
  const connector = {
    connect: async (signal: AbortSignal = new AbortController().signal): Promise<ResidentSession> => {
      const session = await edge.connector.connect(signal)
      session.onOffer(offer => { offers.push(offer) })
      session.onDisconnect(reason => { disconnectReasons.push(reason ?? 'unknown') })
      return session
    },
  }
  return { edge, connector, offers, disconnectReasons }
}

/**
 * 插件同款驱动：1 秒一拍，失败只记原因并走 pause→resume 重连（plugin.ts 的 drive/reconnect 逐行对应）。
 */
function makeDriver(connector: { connect: (signal?: AbortSignal) => Promise<ResidentSession> }) {
  const state = {
    session: null as ResidentSession | null,
    lifecycle: 'IDLE' as 'IDLE' | 'RUNNING' | 'PAUSED',
    ticks: 0,
    tickFailures: [] as { at: number; code: string }[],
    reconnects: [] as { at: number; ok: boolean; code?: string }[],
    running: false,
    connectedAt: [] as number[],
    timer: null as ReturnType<typeof setInterval> | null,
  }
  const codeOf = (error: unknown): string => {
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === 'string' && code.length > 0) return code
    return error instanceof Error ? error.name : 'UNKNOWN'
  }
  const reconnect = async (): Promise<void> => {
    const at = Date.now()
    try {
      state.lifecycle = 'PAUSED'
      if (!state.session) {
        const session = await connector.connect()
        state.session = session
        state.connectedAt.push(Date.now())
        session.onDisconnect(() => { state.session = null })
      }
      state.lifecycle = 'RUNNING'
      state.reconnects.push({ at, ok: true })
    } catch (error) {
      state.reconnects.push({ at, ok: false, code: codeOf(error) })
    }
  }
  const tick = async (): Promise<void> => {
    state.ticks += 1
    if (!state.session) {
      state.tickFailures.push({ at: Date.now(), code: 'COMPUTE_RESIDENT_NOT_CONNECTED' })
      await reconnect()
      return
    }
    try {
      await state.session.sendHeartbeat({
        version: 'qianshou.node.v1', nodeId: NODE_ID as never, agentVersion: 'forensic-build-1',
        sentAt: new Date().toISOString(), capabilities: [], maxConcurrency: 1, runningTasks: 0,
      })
    } catch (error) {
      state.tickFailures.push({ at: Date.now(), code: codeOf(error) })
      await reconnect()
    }
  }
  return {
    state,
    started: (async () => {
      await reconnect()
      if (!state.timer) state.timer = setInterval(() => { void tick() }, TICK_MS)
    })(),
    async stop(): Promise<void> {
      if (state.timer) clearInterval(state.timer)
      state.timer = null
      const session = state.session
      state.session = null
      await session?.close()
    },
  }
}

const authCount = (gateway: LocalGateway): number => gateway.events.filter(event => event.kind === 'auth_ok_sent').length
const lastAuthAt = (gateway: LocalGateway): number => [...gateway.events].reverse().find(event => event.kind === 'auth_ok_sent')?.at ?? 0
const openSockets = (gateway: LocalGateway): number => gateway.connectionCount - gateway.events.filter(event => event.kind === 'close').length

it('情形a：服务器主动断链 → 节点重连并重新注册', async () => {
  const gateway = await LocalGateway.listen(31901)
  const { connector, offers, disconnectReasons } = makeConnector({ origin: `http://127.0.0.1:${gateway.port}`, token: TOKEN, ownerId: OWNER_ID })
  const driver = makeDriver(connector)
  const record: Record<string, unknown> = {}
  try {
    await driver.started
    await waitFor(() => authCount(gateway) >= 1, DEADLINE_MS, '首次认证')
    record.first_hello_worker_id = gateway.helloWorkerIds[0] ?? null
    record.first_auth_worker_id = gateway.authWorkerIds[0] ?? null

    await waitFor(() => gateway.events.some(e => e.kind === 'hb'), 5_000, '第一拍心跳')
    gateway.send(0, 'shard_assign', assignment({ shard_id: 'shard-before', workload_id: 'workload-a' }))
    record.assignment_before_drop_ms = await waitFor(
      () => gateway.events.some(e => e.kind === 'result' && e.detail?.shard_id === 'shard-before'), DEADLINE_MS, '断链前派单受理')

    const droppedConn = gateway.connectionCount - 1
    const droppedAt = Date.now()
    record.drop_accepted = gateway.dropConnection(droppedConn)
    await waitFor(() => gateway.events.some(e => e.kind === 'close' && e.connection === droppedConn), 5_000, '服务器侧连接关闭')

    await waitFor(() => authCount(gateway) >= 2, DEADLINE_MS, '重连后再次认证')
    record.reconnect_to_reauth_ms = lastAuthAt(gateway) - droppedAt
    record.second_hello_worker_id = gateway.helloWorkerIds[1] ?? null
    record.second_auth_worker_id = gateway.authWorkerIds[1] ?? null
    record.welcome_back_second = gateway.events.filter(e => e.kind === 'auth_ok_sent')[1]?.detail?.welcome_back ?? null
    record.disconnect_callbacks = [...disconnectReasons]
    record.tick_failures = driver.state.tickFailures.map(item => item.code)

    gateway.send(1, 'shard_assign', assignment({ shard_id: 'shard-after', workload_id: 'workload-b' }))
    const afterAt = await waitFor(
      () => gateway.events.some(e => e.kind === 'result' && e.detail?.shard_id === 'shard-after'), DEADLINE_MS, '重连后派单受理')
    record.assignment_after_reconnect_ms = afterAt
    record.offers_seen_by_session = offers.length
    record.open_sockets_at_end = openSockets(gateway)
    record.gateway_summary = summarize(gateway)
  } finally {
    await driver.stop()
    await gateway.stop()
  }
  console.log('【情形a 原始观察】', JSON.stringify(record, null, 2))
  expect(record.assignment_after_reconnect_ms).toBeTypeOf('number')
}, 90_000)

it('情形b：节点侧网络抖动（真 TCP 代理切断并阻断 3 秒）→ 恢复链路', async () => {
  const gateway = await LocalGateway.listen(31902)
  const proxy = await FlakyProxy.listen(31903, 31902)
  const { connector, disconnectReasons } = makeConnector({ origin: 'http://127.0.0.1:31903', token: TOKEN, ownerId: OWNER_ID })
  const driver = makeDriver(connector)
  const record: Record<string, unknown> = {}
  try {
    await driver.started
    await waitFor(() => authCount(gateway) >= 1, DEADLINE_MS, '首次认证')
    await waitFor(() => gateway.events.some(e => e.kind === 'hb'), 5_000, '第一拍心跳')
    gateway.send(0, 'shard_assign', assignment({ shard_id: 'shard-pre-jitter' }))
    await waitFor(() => gateway.events.some(e => e.kind === 'result'), DEADLINE_MS, '抖动前派单受理')

    const cutAt = Date.now()
    const attemptsAtCut = gateway.connectionCount
    proxy.cut()
    await sleep(3_000)
    record.outage_ms = Date.now() - cutAt
    record.new_connections_during_outage = gateway.connectionCount - attemptsAtCut
    record.reconnect_attempts_failed = driver.state.reconnects.filter(item => !item.ok).length
    proxy.restore()

    await waitFor(() => authCount(gateway) >= 2, DEADLINE_MS, '抖动结束后重连认证')
    record.recover_to_reauth_ms = lastAuthAt(gateway) - cutAt
    record.second_hello_worker_id = gateway.helloWorkerIds[1] ?? null
    record.welcome_back_second = gateway.events.filter(e => e.kind === 'auth_ok_sent')[1]?.detail?.welcome_back ?? null
    record.node_side_failures = [...new Set(driver.state.tickFailures.map(item => item.code))]
    record.disconnect_callbacks = [...disconnectReasons]

    gateway.send(1, 'shard_assign', assignment({ shard_id: 'shard-post-jitter', workload_id: 'workload-b' }))
    record.assignment_after_recovery_ms = await waitFor(
      () => gateway.events.some(e => e.kind === 'result' && e.detail?.shard_id === 'shard-post-jitter'), DEADLINE_MS, '抖动后派单受理')
    record.gateway_summary = summarize(gateway)
  } finally {
    await driver.stop()
    await proxy.close()
    await gateway.stop()
  }
  console.log('【情形b 原始观察】', JSON.stringify(record, null, 2))
  expect(record.assignment_after_recovery_ms).toBeTypeOf('number')
}, 90_000)

it('情形c：网关整体重启（监听关闭 → 节点重试 → 同端口新网关）→ 恢复链路', async () => {
  const first = await LocalGateway.listen(31904)
  const { connector, disconnectReasons } = makeConnector({ origin: 'http://127.0.0.1:31904', token: TOKEN, ownerId: OWNER_ID })
  const driver = makeDriver(connector)
  const record: Record<string, unknown> = {}
  let second: LocalGateway | null = null
  try {
    await driver.started
    await waitFor(() => authCount(first) >= 1, DEADLINE_MS, '首次认证')
    await waitFor(() => first.events.some(e => e.kind === 'hb'), 5_000, '第一拍心跳')
    first.send(0, 'shard_assign', assignment({ shard_id: 'shard-before-restart' }))
    await waitFor(() => first.events.some(e => e.kind === 'result'), DEADLINE_MS, '重启前派单受理')

    const stopAt = Date.now()
    await first.stop()
    await sleep(4_000)
    record.downtime_ms = Date.now() - stopAt
    record.reconnect_attempts_failed = driver.state.reconnects.filter(item => item.at > stopAt && !item.ok).length

    second = await LocalGateway.listen(31904)
    await waitFor(() => authCount(second as LocalGateway) >= 1, DEADLINE_MS, '新网关上的认证')
    record.recover_to_reauth_ms = Date.now() - stopAt
    record.first_hello_worker_id_on_new_gateway = second.helloWorkerIds[0] ?? null
    record.welcome_back_on_new_gateway = second.events.filter(e => e.kind === 'auth_ok_sent')[0]?.detail?.welcome_back ?? null
    record.disconnect_callbacks = [...disconnectReasons]

    second.send(0, 'shard_assign', assignment({ shard_id: 'shard-after-restart', workload_id: 'workload-c' }))
    record.assignment_after_restart_ms = await waitFor(
      () => (second as LocalGateway).events.some(e => e.kind === 'result' && e.detail?.shard_id === 'shard-after-restart'), DEADLINE_MS, '重启后派单受理')
    record.second_gateway_summary = summarize(second)
  } finally {
    await driver.stop()
    if (second) await second.stop()
    await first.stop()
  }
  console.log('【情形c 原始观察】', JSON.stringify(record, null, 2))
  expect(record.assignment_after_restart_ms).toBeTypeOf('number')
  expect(record.reconnect_attempts_failed as number).toBeGreaterThan(0)
}, 120_000)
