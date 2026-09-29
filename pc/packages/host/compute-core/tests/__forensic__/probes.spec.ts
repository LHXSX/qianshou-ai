/**
 * 两个针对性探针（不在三种情形里，但直接回答归因问题）：
 *   D. 半死 socket：服务器 accept 之后一个字节都不回 → 节点会不会察觉？（平台侧 session 顶替/半死的镜像）
 *   E. 重连风暴 + 旧 socket 重叠：网关长时间不可用 → 节点多久试一次？有没有开新连接却没关旧的？
 */
import { expect, it } from 'vitest'
import type { ResidentSession } from '@deepseek-ai/dsh-compute-core/resident'
import { bindInlineEdgeResident } from '../../../../host/node-contributor/src/edge-binding.ts'
import { LocalGateway, sleep, summarize, waitFor } from './harness.ts'

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
        session.onDisconnect(reason => { disconnectReasons.push(reason ?? 'unknown') })
        return session
      },
    },
    disconnectReasons,
  }
}

function makeDriver(connector: { connect: (signal?: AbortSignal) => Promise<ResidentSession> }) {
  const state = {
    session: null as ResidentSession | null,
    ticks: 0,
    tickFailures: [] as { at: number; code: string }[],
    connectAttempts: [] as { at: number; ok: boolean; code?: string }[],
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
      if (!state.session) {
        const session = await connector.connect()
        state.session = session
        session.onDisconnect(() => { state.session = null })
      }
      state.connectAttempts.push({ at, ok: true })
    } catch (error) {
      state.connectAttempts.push({ at, ok: false, code: codeOf(error) })
    }
  }
  const tick = async (): Promise<void> => {
    state.ticks += 1
    if (!state.session) { state.tickFailures.push({ at: Date.now(), code: 'COMPUTE_RESIDENT_NOT_CONNECTED' }); await reconnect(); return }
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
    started: (async () => { await reconnect(); state.timer ??= setInterval(() => { void tick() }, TICK_MS) })(),
    async stop(): Promise<void> {
      if (state.timer) clearInterval(state.timer)
      state.timer = null
      const session = state.session
      state.session = null
      await session?.close()
    },
  }
}

it('探针D：会话建立后对端变哑（服务器收帧但不回一帧）→ 节点是否察觉并重连', async () => {
  const gateway = await LocalGateway.listen(31905)
  const { connector, disconnectReasons } = makeConnector('http://127.0.0.1:31905')
  const driver = makeDriver(connector)
  const record: Record<string, unknown> = {}
  try {
    await driver.started
    // 先让协议握手正常完成（welcome/auth_ok/hb_ack 都回），再让对端变哑：
    // 这才是「平台那一行还挂着我们的会话、但帧再也到不了」的镜像。
    await waitFor(() => gateway.events.some(e => e.kind === 'auth_ok_sent'), 15_000, '握手完成')
    const muteAt = Date.now()
    gateway.blackhole = true
    const observed = await Promise.race([
      waitFor(() => gateway.connectionCount >= 2, 20_000, '节点察觉并重连').then(() => 'detected' as const),
      sleep(20_000).then(() => 'no-detection-in-20s' as const),
    ])
    record.outcome = observed
    record.detected_within_ms = Date.now() - muteAt
    record.elapsed_ms = Date.now() - muteAt
    record.connection_attempts = gateway.connectionCount
    record.tick_failures = [...new Set(driver.state.tickFailures.map(item => item.code))]
    record.disconnect_callbacks = [...disconnectReasons]
    record.gateway_summary = summarize(gateway)
  } finally {
    await driver.stop()
    await gateway.stop()
  }
  console.log('【探针D 原始观察】', JSON.stringify(record, null, 2))
  // 回归判据（2026-09-17 修复后）：对端变哑 ⇒ 节点必须在服务端声明的 hb_timeout_s 内自己察觉、
  // 关链、重连。修复前这里观察到的是「30 秒内 0 次重连、0 次判失败、35 个 hb 全部发送成功」。
  expect(record.outcome).toBe('detected')
  expect(record.detected_within_ms as number).toBeLessThan(20_000)
  expect(record.connection_attempts as number).toBeGreaterThanOrEqual(2)
}, 90_000)

it('探针E：网关长时间不可用（20 秒）→ 重连尝试速率与旧 socket 重叠情况', async () => {
  const gateway = await LocalGateway.listen(31906)
  const { connector } = makeConnector('http://127.0.0.1:31906')
  const driver = makeDriver(connector)
  const record: Record<string, unknown> = {}
  try {
    await driver.started
    await waitFor(() => gateway.connectionCount >= 1, 10_000, '首连')
    const downAt = Date.now()
    const failedBefore = driver.state.connectAttempts.filter(item => !item.ok).length
    await gateway.stop()

    await sleep(20_000)
    record.downtime_ms = Date.now() - downAt
    const failures = driver.state.connectAttempts.filter(item => !item.ok && item.at >= downAt)
    record.failed_connect_attempts = failures.length
    record.attempt_interval_ms = failures.slice(1).map((item, index) => item.at - (failures[index] as { at: number }).at)
    record.failed_before_probe = failedBefore
    record.tick_failures = [...new Set(driver.state.tickFailures.map(item => item.code))]
    record.ticks = driver.state.ticks
  } finally {
    await driver.stop()
    await gateway.stop()
  }
  console.log('【探针E 原始观察】', JSON.stringify(record, null, 2))
  expect(record.failed_connect_attempts).toBeTypeOf('number')
}, 90_000)
