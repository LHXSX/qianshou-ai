/**
 * U1 事件驱动的一次性视觉提醒：新单 / 开始执行 / 完成 / 失败拒绝四类。
 * 「闪」在这份工单里是缺陷：提醒出现一次、短暂停留后自稳，**不许每次轮询都重放**。
 */
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import { parseNodeStatus, type NodeStatusSnapshot } from '../src/client/node-status/types.ts'
import { createStubTransport, onlineSnapshot } from './fixtures/node-status.fixture.ts'

const at = (iso: string): number => Date.parse(iso)

function snapshot(): NodeStatusSnapshot {
  const parsed = parseNodeStatus(onlineSnapshot())
  if (parsed === null) throw new Error('Invalid node status fixture')
  return parsed
}

function idleSnapshot(counters: Partial<NodeStatusSnapshot['counters']> = {}): NodeStatusSnapshot {
  const base = snapshot()
  return { ...base, current: null, tasks: [], counters: { ...base.counters, ...counters } }
}

function controllerWith(reads: Parameters<typeof createStubTransport>[0], options = {}) {
  const transport = createStubTransport(reads)
  const controller = new NodeStatusController({ transport, intervalMs: 60_000, alertMs: 6000, ...options })
  return { transport, controller }
}

describe('U1 节点事件提醒', () => {
  it('第一次读到快照只建基线，不为历史事件补放提醒', async () => {
    const { controller } = controllerWith([{ kind: 'snapshot', snapshot: snapshot() }])
    await controller.poll()
    expect(controller.state().alert).toBeNull()
  })

  it('新单到达触发一次提醒，且同一批数据反复轮询不会重放', async () => {
    vi.useFakeTimers()
    try {
      const idle = idleSnapshot({ offersReceived: 1 })
      const offered = snapshot()
      const { controller } = controllerWith([{ kind: 'snapshot', snapshot: idle }])
      await controller.poll()
      const seen: string[] = []
      let showing: string | undefined
      controller.subscribe(state => {
        const key = state.alert?.key
        if (key !== undefined && key !== showing) seen.push(key)
        showing = key
      })
      controller.accept({ kind: 'snapshot', snapshot: offered })
      expect(seen).toEqual(['offer:shard-live-1'])
      // 同一批数据连续轮询 20 次：提醒次数不增长。
      for (let index = 0; index < 20; index += 1) controller.accept({ kind: 'snapshot', snapshot: offered })
      expect(seen).toEqual(['offer:shard-live-1'])
      // 提醒停留时间过后自稳；此后同一件事再冒出来就是"每轮重放"，必须被抓住。
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(controller.state().alert).toBeNull()
      for (let index = 0; index < 5; index += 1) controller.accept({ kind: 'snapshot', snapshot: offered })
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(seen).toEqual(['offer:shard-live-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('开始执行 / 完成 / 失败拒绝各自触发一次，且互不冒充', async () => {
    const idle = idleSnapshot()
    const started = snapshot()
    const finishedBase = idleSnapshot({ succeeded: 2 })
    const finished = {
      ...finishedBase,
      recent: [{
        shardId: 'shard-live-1', taskType: 'word_count', outcome: 'succeeded',
        at: '2026-09-22T12:30:30.000Z', durationMs: 9, reason: null,
        verification: 'workload-completed-shard-observed',
      }, ...finishedBase.recent],
    } satisfies NodeStatusSnapshot
    const failedBase = idleSnapshot({ failed: 2 })
    const failed = {
      ...failedBase,
      lastRefusal: {
        shardId: 'shard-live-1', kind: 'failed', code: 'WORKLOAD_FAILED',
        reason: '输入字段缺失 primary_text', at: '2026-09-22T12:30:40.000Z',
      },
    } satisfies NodeStatusSnapshot
    const { controller } = controllerWith([{ kind: 'snapshot', snapshot: idle }])
    await controller.poll()
    const kinds: string[] = []
    controller.subscribe(state => { if (state.alert !== null) kinds.push(state.alert.kind) })
    controller.accept({ kind: 'snapshot', snapshot: started })
    controller.accept({ kind: 'snapshot', snapshot: finished })
    controller.accept({ kind: 'snapshot', snapshot: failed })
    expect(kinds).toEqual(['started', 'finished', 'failed'])
  })

  it('核验态不可结算的完成不发"已完成"提醒，绝不把未知当成功', async () => {
    const idle = idleSnapshot({ succeeded: 1 })
    const unverifiedBase = idleSnapshot({ succeeded: 2 })
    const unverified = {
      ...unverifiedBase,
      recent: [{
        shardId: 'shard-live-1', taskType: 'word_count', outcome: 'succeeded',
        at: '2026-09-22T12:30:30.000Z', durationMs: 9, reason: null, verification: 'unobservable',
      }, ...unverifiedBase.recent],
    } satisfies NodeStatusSnapshot
    const { controller } = controllerWith([{ kind: 'snapshot', snapshot: idle }])
    await controller.poll()
    const kinds: string[] = []
    controller.subscribe(state => { if (state.alert !== null) kinds.push(state.alert.kind) })
    controller.accept({ kind: 'snapshot', snapshot: unverified })
    expect(kinds).toEqual(['finished-unverified'])
  })

  it('关掉提醒后不再打扰，且选择被记住（下次起来仍然是关的）', async () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) }
    const idle = idleSnapshot()
    const offered = snapshot()
    const first = controllerWith([{ kind: 'snapshot', snapshot: idle }], { storage })
    await first.controller.poll()
    first.controller.accept({ kind: 'snapshot', snapshot: offered })
    expect(first.controller.state().alert).not.toBeNull()
    first.controller.dismissAlerts()
    expect(first.controller.state().alert).toBeNull()
    expect(first.controller.state().alertsEnabled).toBe(false)
    first.controller.accept({ kind: 'snapshot', snapshot: idle })
    first.controller.accept({ kind: 'snapshot', snapshot: offered })
    expect(first.controller.state().alert).toBeNull()

    const second = controllerWith([{ kind: 'snapshot', snapshot: idle }], { storage })
    expect(second.controller.state().alertsEnabled).toBe(false)
    await second.controller.poll()
    second.controller.accept({ kind: 'snapshot', snapshot: offered })
    expect(second.controller.state().alert).toBeNull()
  })

  it('提醒自己会停：停留时间到点后自动消失，不留持续动画', async () => {
    vi.useFakeTimers()
    try {
      const idle = idleSnapshot()
      const { controller } = controllerWith([{ kind: 'snapshot', snapshot: idle }])
      await controller.poll()
      controller.accept({ kind: 'snapshot', snapshot: snapshot() })
      expect(controller.state().alert).not.toBeNull()
      vi.advanceTimersByTime(6001)
      expect(controller.state().alert).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('提示的机器时刻只来自快照，不用本地时钟编时间', async () => {
    const idle = idleSnapshot()
    const { controller } = controllerWith([{ kind: 'snapshot', snapshot: idle }], { now: () => at('2026-09-22T12:31:00.000Z') })
    await controller.poll()
    controller.accept({ kind: 'snapshot', snapshot: snapshot() })
    expect(controller.state().alert?.shardId).toBe('shard-live-1')
    expect(controller.state().alert?.at).toBe(at('2026-09-22T12:30:00.000Z'))
  })
})
