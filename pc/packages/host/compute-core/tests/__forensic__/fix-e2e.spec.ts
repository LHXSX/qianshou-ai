/**
 * 端到端判据（真 gateway + 生产装配 + 插件同款驱动）：
 * 对端「变哑」（会话还在、帧不回了）→ 节点自己察觉 → 关链 → 重连并回带同一身份
 * （被服务器认成同一条记录 `welcome_back`）→ 新会话真的能接活。
 *
 * 与 `tests/edge-worker/connection.spec.ts`、`tests/transport/edge-worker-socket.spec.ts`
 * 的关系：那两个是对判据本身的**确定性**断言（假/真 socket，毫秒级）；本文件是端到端观察，
 * 时序依赖本机网关与 1 秒驱动，只作诊断与回归抽样。
 */
import { expect, it } from 'vitest'
import type { ResidentSession } from '@deepseek-ai/dsh-compute-core/resident'
import { bindInlineEdgeResident } from '../../../../host/node-contributor/src/edge-binding.ts'
import { LocalGateway, assignment, sleep, waitFor } from './harness.ts'

const NODE_ID = 'qianshou-forensic-node'
const TICK_MS = 1_000

function makeConnector(origin: string) {
  const disconnectReasons: string[] = []
  const edge = bindInlineEdgeResident({
    nodeId: NODE_ID, agentVersion: 'forensic-build-1', allowedTaskTypes: ['word_count'],
    handshakeTimeoutMs: 15_000, maxFrameBytes: 65_536, maxOutputBytes: 4096,
    supply: () => 'running', originOf: () => origin, tokenOf: async () => 'forensic-token',
    ownerIdOf: async () => 7, tools: [],
    probe: async () => ({ hardware: { platform: 'darwin', arch: 'arm64', cpuModel: 'forensic-cpu', logicalCores: 8, totalMemoryBytes: 16 * 1024 ** 3, gpus: [] }, localServices: [] }) as never,
  })
  return {
    connector: {
      connect: async (signal: AbortSignal = new AbortController().signal): Promise<ResidentSession> => {
        const session = await edge.connector.connect(signal)
        disconnectReasons.push('connected')
        session.onDisconnect(reason => { disconnectReasons.push(reason ?? 'unknown') })
        return session
      },
    },
    disconnectReasons,
  }
}

const heartbeat = () => ({
  version: 'qianshou.node.v1' as const, nodeId: NODE_ID as never, agentVersion: 'forensic-build-1',
  sentAt: new Date().toISOString(), capabilities: [], maxConcurrency: 1, runningTasks: 0,
})

function makeDriver(connector: { connect: (signal?: AbortSignal) => Promise<ResidentSession> }) {
  const state = { session: null as ResidentSession | null, failures: [] as { at: number; code: string }[], timer: null as ReturnType<typeof setInterval> | null }
  const codeOf = (error: unknown): string => {
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === 'string' && code.length > 0) return code
    return error instanceof Error ? error.name : 'UNKNOWN'
  }
  const reconnect = async (): Promise<void> => {
    try {
      if (state.session) return
      const session = await connector.connect()
      state.session = session
      session.onDisconnect(() => { state.session = null })
    } catch (error) { state.failures.push({ at: Date.now(), code: codeOf(error) }) }
  }
  return {
    state,
    /** 立刻发一拍心跳，等价于生产的一拍（探针用它把时刻钉死）。 */
    async pulse(): Promise<void> {
      if (!state.session) { await reconnect(); return }
      try { await state.session.sendHeartbeat(heartbeat()) } catch (error) {
        state.failures.push({ at: Date.now(), code: codeOf(error) })
        await reconnect()
      }
    },
    started: (async () => {
      await reconnect()
      state.timer ??= setInterval(() => { void (async () => {
        if (!state.session) { await reconnect(); return }
        try { await state.session.sendHeartbeat(heartbeat()) } catch (error) {
          state.failures.push({ at: Date.now(), code: codeOf(error) })
          await reconnect()
        }
      })() }, TICK_MS)
    })(),
    async stop(): Promise<void> {
      if (state.timer) clearInterval(state.timer)
      state.timer = null
      const session = state.session
      state.session = null
      await session?.close().catch(() => undefined)
    },
  }
}

it('对端变哑 → 节点自己察觉、重连、同身份重注册、恢复接单', async () => {
  const gateway = await LocalGateway.listen(31907)
  const { connector, disconnectReasons } = makeConnector(`http://127.0.0.1:${gateway.port}`)
  const driver = makeDriver(connector)
  const record: Record<string, unknown> = {}
  try {
    await driver.started
    await waitFor(() => gateway.events.some(e => e.kind === 'auth_ok_sent'), 15_000, '首连认证')
    await waitFor(() => gateway.events.some(e => e.kind === 'hb'), 5_000, '第一拍心跳')
    record.first_hello_worker_id = gateway.helloWorkerIds[0] ?? null
    record.server_acknowledged_worker_id = gateway.authWorkerIds[0] ?? null

    // 对端变哑；节点侧不靠内置周期，直接每 1 秒补一拍心跳（与生产同拍），时刻确定。
    const lastAckAt = Date.now()
    gateway.blackhole = true
    const pulse = setInterval(() => { void driver.pulse() }, 1_000)
    await waitFor(() => gateway.events.some(e => e.kind === 'accept' && (e.connection ?? -1) >= 1), 30_000, '节点察觉并重连')
    const reconnectAt = [...gateway.events].reverse().find(e => e.kind === 'accept' && (e.connection ?? -1) >= 1)?.at ?? Date.now()
    clearInterval(pulse)
    gateway.blackhole = false
    record.silence_to_reconnect_ms = reconnectAt - lastAckAt
    record.disconnect_reasons = [...disconnectReasons]

    // 重连后完成认证（首建连接可能被探针自己的哑窗口吞掉一次，最多再等两轮）。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const done = await waitFor(() => gateway.events.some(e => e.kind === 'auth_ok_sent' && (e.connection ?? -1) >= 1), 17_000, '重连后认证').catch(() => null)
      if (done !== null && done !== undefined) break
      gateway.blackhole = false
      await sleep(500)
    }
    const reAuth = [...gateway.events].reverse().find(e => e.kind === 'auth_ok_sent' && (e.connection ?? -1) >= 1)
    const reHello = gateway.helloWorkerIds.findIndex((id, index) => index >= 1 && id !== undefined)
    record.reconnect_connection = reAuth?.connection ?? null
    record.worker_id_carried_on_reconnect = gateway.helloWorkerIds[reHello] ?? null
    record.welcome_back_on_reconnect = reAuth?.detail?.welcome_back ?? null

    // 新会话能接活：把分片派给它，本机必须把它记成在跑的活跃租约。
    const live = reAuth?.connection ?? 1
    await waitFor(() => gateway.frames.some(f => f.connection === live && f.type === 'hb'), 10_000, '新会话上的心跳')
    await sleep(1_200)
    gateway.send(live, 'shard_assign', assignment({ shard_id: 'shard-after-mute', workload_id: 'workload-z' }))
    const accepted = await waitFor(
      () => gateway.frames.some(f => f.connection === live && f.type === 'hb' && f.payload.active_shards === 1),
      15_000, '恢复派单受理').catch(() => null)
    record.assignment_after_recovery_ms = accepted
    record.dispatch_accepted = accepted !== null
    record.open_sockets_at_accept = gateway.openSocketsAtAccept
  } catch (error) {
    record.thrown = error instanceof Error ? error.message : String(error)
    record.frames = gateway.frames.map(f => `${f.connection}:${f.type}`)
    record.events_tail = gateway.events.slice(-10)
  } finally {
    await driver.stop()
    await gateway.stop()
  }
  console.log('【修复后端到端观察】', JSON.stringify(record, null, 2))
  // 判据一：对端变哑后节点自己察觉（服务端声明 hb_timeout_s=5 ⇒ 5 s 窗口 + 一拍驱动）。
  expect(record.silence_to_reconnect_ms).toBeTypeOf('number')
  expect(record.silence_to_reconnect_ms as number).toBeLessThan(20_000)
  // 判据二：重连的 hello 回带同一身份，且被服务器认成同一条记录。
  expect(record.worker_id_carried_on_reconnect).toBe(record.server_acknowledged_worker_id)
  expect(record.welcome_back_on_reconnect).toBe(true)
  // 判据三：这条新会话真的能接活。
  expect(record.dispatch_accepted).toBe(true)
}, 120_000)
