/**
 * U1 测试夹具：一份**照抄真机结构**的快照（字段名来自 `qianshou.node-status.v1`），
 * 以及一个只记账、不联网的传输桩。
 */
import type { NodeCommand, NodeCommandOutcome, NodePowerState, NodeStatusReadout, NodeStatusTransport } from '../../src/client/node-status/types.ts'

/** 一条正在跑的任务 + 一条已结算的任务 + 一条失败任务，覆盖四类提醒与四种标签。 */
export function onlineSnapshot(): Record<string, unknown> {
  const task = {
    shardId: 'shard-live-1', workloadId: 'wl-7f2', attempt: 1, taskType: 'word_count',
    startedAt: '2026-09-22T12:30:00.000Z', elapsedMs: 4200, progressPct: 40, progressEvents: 2,
  }
  return {
    schema: 'qianshou.node-status.v1',
    pid: 65210,
    startedAt: '2026-09-22T12:10:36.984Z',
    uptimeSeconds: 1206.879,
    connection: {
      state: 'online', reason: null, core: 'https://qianshousuanli.com',
      workerId: '0b4fc9a1-2202-56ad-bd0c-abccec2822f6', ownerId: 167, mode: 'running',
      onlineSince: '2026-09-22T12:10:37.397Z', onlineSeconds: 1206.466,
    },
    current: task,
    tasks: [task],
    counters: { offersReceived: 3, accepted: 2, succeeded: 1, failed: 1, rejected: 0, canceledByOwner: 0 },
    lastRefusal: {
      shardId: 'shard-bad', kind: 'failed', code: 'WORKLOAD_FAILED',
      reason: '输入字段缺失 primary_text', at: '2026-09-22T12:28:00.000Z',
    },
    recent: [
      {
        shardId: 'shard-done', taskType: 'word_count', outcome: 'succeeded', at: '2026-09-22T12:29:38.787Z',
        durationMs: 5, reason: null, verification: 'workload-completed-shard-observed',
      },
      {
        shardId: 'shard-bad', taskType: 'word_count', outcome: 'failed', at: '2026-09-22T12:28:00.000Z',
        durationMs: 12, reason: '输入字段缺失 primary_text', verification: 'unobservable',
      },
    ],
    earnings: {
      estimatedNodeYuan: null, basis: 'not-carried-in-dispatch-frame',
      note: '派单帧只带身份/输入/租约，不带报价；本节点不猜收益。',
    },
  }
}

/** 只记账的传输桩：按序发快照，命令原样记下来。 */
export function createStubTransport(
  reads: readonly NodeStatusReadout[],
  initialPower: NodePowerState = { running: false, managed: false, mode: null },
): NodeStatusTransport & {
  readonly commands: NodeCommand[]
  readonly powers: boolean[]
} {
  const commands: NodeCommand[] = []
  const powers: boolean[] = []
  let index = 0
  let power = initialPower
  return {
    commands,
    powers,
    read: () => Promise.resolve(reads[Math.min(index++, reads.length - 1)] ?? { kind: 'unreachable', code: 'NODE_UNREACHABLE' }),
    command: (command: NodeCommand): Promise<NodeCommandOutcome> => {
      commands.push(command)
      return Promise.resolve({ ok: true, code: 'OK' })
    },
    power: () => Promise.resolve(power),
    setPower: (on: boolean) => {
      powers.push(on)
      power = { running: on, managed: on, mode: on ? 'running' : null }
      return Promise.resolve(power)
    },
  }
}
