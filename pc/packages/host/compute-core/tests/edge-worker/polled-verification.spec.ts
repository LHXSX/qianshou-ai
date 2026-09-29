/**
 * 轮询核验（N6 第 1 步 + W6 分类补钉）的边界钉死。
 *
 * 这些用例钉的是**诚实性**而不是实现细节：
 * ① 计数前进 ⇒ 才离开悬空态；404（终局不存在）与 5xx（服务端故障）分属**不同**分类；
 * ② 计数没动 ⇒ 不得标记成功（待定，不是失败）；
 * ③ 读不到 ⇒ 未知且有界（绝不当成功）；
 * ④ 反向回归闸：任何"不是亲眼看到计数前进"的结果，都不允许被当作受理、更不许让状态前进；
 * ⑤ 有界：墙钟与次数**两条独立闸**，服务端一直 500 也不许无限重试。
 */
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EdgeWorkload } from '../../src/supply/edge-api.ts'
import {
  isResultAcceptanceObserved, verifySubmittedResult,
  type EdgeResultVerification, type PolledVerificationOptions,
} from '../../src/edge-worker/polled-verification.ts'
import type { EdgeResultState, EdgeTaskIdentity, WorkloadShardCounters } from '../../src/edge-worker/types.ts'
import { SupplyHttpError } from '../../src/supply/http.ts'
import { SupplyError } from '../../src/supply/policy.ts'

/**
 * 生产侧唯一的状态推进点就在这个判据上（`node-contributor/src/resident-assembly.ts:377`：
 * `if (!isResultAcceptanceObserved(...)) applied = 'not-settleable'`）。这里把它写成测试里的
 * 判据式，于是"未知 ⇒ 状态原地不动"可以被直接断言，而不只是断言一个枚举值。
 * @param from - State the send left the result in.
 * @param verification - Any conclusion.
 * @returns The state the caller may move to: the observed outcome, or `from` unchanged.
 */
function advancedState(from: EdgeResultState, verification: Pick<EdgeResultVerification, 'outcome'>): EdgeResultState {
  return isResultAcceptanceObserved(verification) ? verification.outcome : from
}

const identity: EdgeTaskIdentity = { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 2 }

/** 平台 `GET /api/v8/workloads/{id}` 的原生投影（`supply/edge-api.ts:parseWorkload` 的形状）。 */
function projection(completed: number, failed: number): EdgeWorkload {
  return { id: 'workload-1', name: 'task', status: 'RUNNING', progress: 0, totalShards: 1,
    completedShards: completed, failedShards: failed, createdAt: '2026-09-22T00:00:00Z', completedAt: null }
}

/** 依次返回给定读数；`Error` 项表示这次读失败。 */
function readerOf(readings: readonly (readonly [number, number] | Error)[]) {
  let index = 0
  const calls: string[] = []
  const queryWorkload = vi.fn(async (id: string): Promise<EdgeWorkload> => {
    calls.push(id)
    const reading = readings[Math.min(index, readings.length - 1)]!
    index += 1
    if (reading instanceof Error) throw reading
    return projection(reading[0], reading[1])
  })
  return { reader: { queryWorkload }, calls, queryWorkload }
}

/**
 * 把时钟与退避都收进测试手里：`sleep` 推进假时钟并记下每次等待的长度，
 * 于是"有界"和"退避"都能被直接断言，而不依赖真实 setTimeout 的时序。
 */
function window(readings: readonly (readonly [number, number] | Error)[], overrides: Partial<PolledVerificationOptions> = {}) {
  const { reader, queryWorkload } = readerOf(readings)
  const waits: number[] = []
  let clock = 0
  const options: PolledVerificationOptions = {
    reader, identity, before: { completedShards: 0, failedShards: 0 } as WorkloadShardCounters,
    timeoutMs: 100, maxPolls: 3, initialDelayMs: 10, maxDelayMs: 40,
    now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms },
    ...overrides,
  }
  return { options, waits, queryWorkload, clockNow: () => clock }
}

describe('polled result verification', () => {
  it('① leaves the dangling send state only after the platform projection counts the shard', async () => {
    const { options, waits } = window([[0, 0], [1, 0]])
    const verification = await verifySubmittedResult(options)
    expect(verification.outcome).toBe('workload-completed-shard-observed')
    // 「离开悬空态」= disposition 变成唯一可结算的那一档，并且不再是 transport 的那个值。
    expect(verification.disposition).toBe('settleable')
    expect(verification.outcome).not.toBe('sent-awaiting-verification')
    expect(isResultAcceptanceObserved(verification)).toBe(true)
    // 证据必须同时带上是哪一次读、以及"只到工作负载聚合粒度"这个限制。
    expect(verification).toMatchObject({
      attribution: 'workload-aggregate-only', identity, before: { completedShards: 0, failedShards: 0 },
      after: { completedShards: 1, failedShards: 0 }, polls: 2, failedPolls: 0, code: null,
      failureClass: null, retryable: false,
    })
    expect(waits).toEqual([10, 20])
  })

  it('①-bis treats an explicit failed-shard movement as retryable, never as acceptance', async () => {
    const { options } = window([[0, 0], [0, 1]])
    const verification = await verifySubmittedResult(options)
    expect(verification.outcome).toBe('workload-failed-shard-observed')
    expect(verification.disposition).toBe('retryable')
    expect(isResultAcceptanceObserved(verification)).toBe(false)
  })

  it('①-ter classifies 404 (terminal absence) and 5xx (platform fault) as different conclusions', async () => {
    const absent = await verifySubmittedResult(window([new SupplyHttpError(404)]).options)
    const fault = await verifySubmittedResult(window([new SupplyHttpError(500)], { maxPolls: 3 }).options)
    // ① 验收判据：同一个"读不到"，两者落在**不同**的机器可读分类上。
    expect(absent.failureClass).toBe('workload-absent')
    expect(fault.failureClass).toBe('server-fault')
    expect(absent.failureClass).not.toBe(fault.failureClass)
    expect(absent).toMatchObject({
      outcome: 'unobservable', disposition: 'indeterminate', code: 'SUPPLY_HTTP_NOT_FOUND',
      retryable: false, after: null, polls: 1, failedPolls: 1,
    })
    expect(fault).toMatchObject({
      outcome: 'unobservable', disposition: 'indeterminate', code: 'SUPPLY_HTTP_FAILED',
      retryable: true, after: null, polls: 3, failedPolls: 3,
    })
    // 终局性不只是字段，也是可观察行为：404 当场停手，5xx 才把有界窗口走完。
    expect(absent.polls).toBeLessThan(fault.polls)
    expect([absent, fault].map(row => isResultAcceptanceObserved(row))).toEqual([false, false])
  })

  it('② does not report success while the platform has not counted the shard (still undecided)', async () => {
    // 三次读全部成功、计数一动不动：这是"查不到 = 待定"，不是失败，更不是成功。
    const { options, waits, clockNow } = window([[0, 0], [0, 0], [0, 0], [1, 0]])
    const verification = await verifySubmittedResult(options)
    expect(verification.outcome).toBe('no-change-within-window')
    expect(verification.disposition).toBe('retained')
    expect(isResultAcceptanceObserved(verification)).toBe(false)
    // 第二个读数是"预算用完之后的下一拍"，永远不该被读到。
    expect(verification.polls).toBe(3)
    expect(waits).toEqual([10, 20, 40])
    expect(clockNow()).toBe(70)
  })

  it('③ keeps a network-failed window bounded and unknown, and never calls it success', async () => {
    const { options, waits, queryWorkload } = window([new Error('ECONNREFUSED'), new Error('ETIMEDOUT'), new Error('TLS reset')])
    const verification = await verifySubmittedResult(options)
    expect(verification.outcome).toBe('unobservable')
    expect(verification.disposition).toBe('indeterminate')
    expect(verification.code).toBe('EDGE_VERIFICATION_UNREADABLE')
    expect(verification.after).toBeNull()
    // 有界：读次数不超上限，等待总长不超预算，退避递增且封顶。
    expect(verification.polls).toBe(3)
    expect(verification.failedPolls).toBe(3)
    expect(queryWorkload).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([10, 20, 40])
    expect(Math.max(...waits)).toBeLessThanOrEqual(options.maxDelayMs)
    expect(isResultAcceptanceObserved(verification)).toBe(false)
  })

  it('③-bis keeps the stable supply code of the last failed read and aborts on caller cancellation', async () => {
    const failing = window([new SupplyError('SUPPLY_HTTP_FAILED'), new SupplyError('SUPPLY_TIMEOUT')])
    expect((await verifySubmittedResult(failing.options)).code).toBe('SUPPLY_TIMEOUT')

    const controller = new AbortController()
    const aborted = window([[0, 0]], { signal: controller.signal })
    controller.abort()
    const verification = await verifySubmittedResult(aborted.options)
    expect(verification).toMatchObject({ outcome: 'unobservable', code: 'EDGE_VERIFICATION_ABORTED', polls: 0 })
    expect(aborted.queryWorkload).not.toHaveBeenCalled()
  })

  it('④ reverse-regression gate: nothing except an observed counter movement may count as acceptance', async () => {
    const outcomes = [
      await verifySubmittedResult(window([[0, 0], [0, 0], [0, 0]]).options),
      await verifySubmittedResult(window([[0, 0], [0, 1]]).options),
      await verifySubmittedResult(window([new Error('offline')]).options),
    ]
    expect(outcomes.map(outcome => outcome.outcome))
      .toEqual(['no-change-within-window', 'workload-failed-shard-observed', 'unobservable'])
    // 三种都**不是**可结算的，任何一条被当成成功，本用例必须变红。
    expect(outcomes.map(verification => verification.disposition)).not.toContain('settleable')
    expect(outcomes.map(row => isResultAcceptanceObserved(row))).toEqual([false, false, false])
    const states: EdgeResultState[] = outcomes.map(row => row.outcome)
    expect(states.every(state => state !== 'sent-awaiting-verification')).toBe(true)
  })

  it('④-null: a read conclusion carries no failure class, and only an unread window is retryable', async () => {
    // 读到过投影的那两条：分类必须是 null（分类只回答"为什么读不到"）。
    const counted = await verifySubmittedResult(window([[0, 0], [1, 0]]).options)
    expect(counted).toMatchObject({ failureClass: null, retryable: false })
    const failedShard = await verifySubmittedResult(window([[0, 0], [0, 1]]).options)
    expect(failedShard).toMatchObject({ failureClass: null, retryable: false })
    // 窗口内一次没动 ⇒ 待定；"再读一次可能变"是 true，但它依然不是成功。
    const retained = await verifySubmittedResult(window([[0, 0], [0, 0], [0, 0]]).options)
    expect(retained).toMatchObject({ failureClass: null, retryable: true, disposition: 'retained' })
    expect(isResultAcceptanceObserved(retained)).toBe(false)
  })

  it('④-bis refuses to invent a baseline: without a pre-send reading acceptance is impossible', async () => {
    const { options, queryWorkload } = window([[1, 0], [1, 0]], { before: null })
    const verification = await verifySubmittedResult(options)
    // 投影此刻已经是"完成 1"——若拿发出之后的读数当基线，这里就会被误判成受理。
    expect(verification).toMatchObject({
      outcome: 'unobservable', disposition: 'indeterminate', code: 'EDGE_VERIFICATION_NO_BASELINE',
      failureClass: 'no-baseline', retryable: false, before: null, after: null, polls: 0,
    })
    // ③ 基线读不到 ⇒ **零次**核验请求（这一次短路就是"一次都不发"的机器证据）。
    expect(queryWorkload).not.toHaveBeenCalled()
    expect(isResultAcceptanceObserved(verification)).toBe(false)
  })

  it('④-c stops the window at a terminal 404, not at the end of the budget', async () => {
    const { options, queryWorkload } = window([[0, 0], new SupplyHttpError(404), [1, 0]])
    const verification = await verifySubmittedResult(options)
    // 中段的 404 是终局：读完它立刻停手，第三次读（那份"计数前进"）根本不取。
    expect(verification).toMatchObject({
      outcome: 'unobservable', disposition: 'indeterminate', failureClass: 'workload-absent',
      code: 'SUPPLY_HTTP_NOT_FOUND', retryable: false, polls: 2, failedPolls: 1,
      after: { completedShards: 0, failedShards: 0 },
    })
    expect(queryWorkload).toHaveBeenCalledTimes(2)
    expect(isResultAcceptanceObserved(verification)).toBe(false)
  })

  it('④-d never classifies a 400-side answer as something to wait for', async () => {
    const rejected = await verifySubmittedResult(window([new SupplyHttpError(400)]).options)
    expect(rejected).toMatchObject({
      outcome: 'unobservable', failureClass: 'client-rejected', code: 'SUPPLY_HTTP_FAILED',
      retryable: false, polls: 1,
    })
    // 对照：同一位置上的 5xx 是**可重试**的服务端故障，窗口走完才收工。
    const fault = await verifySubmittedResult(window([new SupplyHttpError(503)], { maxPolls: 3 }).options)
    expect(fault).toMatchObject({ outcome: 'unobservable', failureClass: 'server-fault', retryable: true, polls: 3 })
    expect(rejected.retryable).not.toBe(fault.retryable)
  })

  it('④-time bounds the window by the clock even when the poll cap would allow thousands', async () => {
    const { options, waits, queryWorkload } = window([[0, 0]], { maxPolls: 10_000, timeoutMs: 90 })
    const verification = await verifySubmittedResult(options)
    // 次数闸开得极宽 ⇒ 唯一能把它停下来的就是墙钟闸（10+20+40 之后下一刻会越过 90 ms）。
    expect(verification).toMatchObject({ outcome: 'no-change-within-window', disposition: 'retained', polls: 3, failedPolls: 0 })
    expect(verification.polls).toBe(queryWorkload.mock.calls.length)
    expect(verification.elapsedMs).toBe(70)
    expect(verification.elapsedMs).toBeLessThanOrEqual(options.timeoutMs)
    expect(waits).toEqual([10, 20, 40])
    expect(isResultAcceptanceObserved(verification)).toBe(false)
  })

  it('④-count bounds the window by the poll cap even when the clock would allow more', async () => {
    const { options, waits } = window([[0, 0], [0, 0], [0, 0]], { maxPolls: 2, timeoutMs: 10_000 })
    const verification = await verifySubmittedResult(options)
    expect(verification.polls).toBe(2)
    expect(waits).toEqual([10, 20])
    expect(verification.outcome).toBe('no-change-within-window')
  })

  it('⑤ stays bounded and stays unknown when the platform answers 500 forever', async () => {
    const { options, waits, queryWorkload } = window([new SupplyHttpError(500)], { maxPolls: 4, timeoutMs: 10_000 })
    const verification = await verifySubmittedResult(options)
    expect(verification).toMatchObject({
      outcome: 'unobservable', disposition: 'indeterminate', failureClass: 'server-fault',
      code: 'SUPPLY_HTTP_FAILED', retryable: true, polls: 4, failedPolls: 4, after: null,
    })
    expect(queryWorkload).toHaveBeenCalledTimes(4)
    expect(waits).toEqual([10, 20, 40, 40])
    expect(isResultAcceptanceObserved(verification)).toBe(false)
  })

  it('⑤-b stays bounded when 500 lasts forever and only the clock can stop it', async () => {
    const { options, waits, queryWorkload } = window([new SupplyHttpError(500)],
      { maxPolls: 10_000, timeoutMs: 90, initialDelayMs: 10, maxDelayMs: 40 })
    const verification = await verifySubmittedResult(options)
    expect(verification).toMatchObject({ failureClass: 'server-fault', retryable: true, polls: 3, failedPolls: 3 })
    expect(verification.polls).toBe(queryWorkload.mock.calls.length)
    expect(verification.elapsedMs).toBeLessThanOrEqual(options.timeoutMs)
    expect(waits).toEqual([10, 20, 40])
    expect(isResultAcceptanceObserved(verification)).toBe(false)
  })

  it('② reverse gate: every "unknown" class leaves the state exactly where the send left it', async () => {
    const controller = new AbortController()
    const aborted = window([[0, 0]], { signal: controller.signal })
    controller.abort()
    const unknowns = [
      await verifySubmittedResult(window([new SupplyHttpError(404)]).options),
      await verifySubmittedResult(window([[0, 0], new SupplyHttpError(404)]).options),
      await verifySubmittedResult(window([new SupplyHttpError(400)]).options),
      await verifySubmittedResult(window([new SupplyHttpError(500)], { maxPolls: 2 }).options),
      await verifySubmittedResult(window([new SupplyHttpError(503)], { maxPolls: 2 }).options),
      await verifySubmittedResult(window([new SupplyHttpError(429)], { maxPolls: 2 }).options),
      await verifySubmittedResult(window([new SupplyHttpError(401)], { maxPolls: 2 }).options),
      await verifySubmittedResult(window([new Error('ECONNREFUSED')], { maxPolls: 2 }).options),
      await verifySubmittedResult(window([[0, 0]], { before: null }).options),
      await verifySubmittedResult(window([[1, 0]], { timeoutMs: 5, initialDelayMs: 10 }).options),
      await verifySubmittedResult(aborted.options),
    ]
    expect(new Set(unknowns.map(row => row.outcome))).toEqual(new Set(['unobservable']))
    // 每一条都必须带机器可读的原因，而且**没有一条**允许状态前进。
    expect(new Set(unknowns.map(row => row.failureClass))).toEqual(new Set([
      'workload-absent', 'client-rejected', 'server-fault', 'throttled', 'auth-required',
      'unreadable', 'no-baseline', 'aborted',
    ]))
    for (const row of unknowns) {
      expect(row.disposition).toBe('indeterminate')
      expect(isResultAcceptanceObserved(row)).toBe(false)
      expect(advancedState('sent-awaiting-verification', row)).toBe('sent-awaiting-verification')
    }
    // 正向对照：只有亲眼看到计数前进的那一条才动状态（否则上面那句可以靠"什么都不动"蒙过去）。
    const accepted = await verifySubmittedResult(window([[0, 0], [1, 0]]).options)
    expect(advancedState('sent-awaiting-verification', accepted)).toBe('workload-completed-shard-observed')
  })

  it('③-quater reports an unknown window when the budget cannot even cover the first wait', async () => {
    const { options, queryWorkload } = window([[1, 0]], { timeoutMs: 5, initialDelayMs: 10 })
    const verification = await verifySubmittedResult(options)
    // 预算比第一次等待还短 ⇒ 一次都没读到。这是"未知"，不是"未受理"，也不是成功。
    expect(verification).toMatchObject({ outcome: 'unobservable', code: 'EDGE_VERIFICATION_UNREADABLE', polls: 0, after: null })
    expect(queryWorkload).not.toHaveBeenCalled()
    expect(isResultAcceptanceObserved(verification)).toBe(false)
  })

  it('runs on the real clock and real timers when the caller injects neither', async () => {
    const { reader, queryWorkload } = readerOf([[0, 0], [1, 0]])
    // 预算刻意开得极宽（60 s）而等待只有 1 ms：这条钉的是"不注入也能跑"，不是"预算有多紧"，
    // 所以机器被压满时也不允许因为调度抖动变红。有界性由 fake clock 那几条钉。
    // Observe the real defaults without replacing either implementation. Two 1 ms
    // timer requests do not guarantee a 2 ms integer Date.now() difference.
    const clock = vi.spyOn(Date, 'now')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const verification = await verifySubmittedResult({
        reader, identity, before: { completedShards: 0, failedShards: 0 },
        timeoutMs: 60_000, maxPolls: 3, initialDelayMs: 1, maxDelayMs: 1,
      })
      const startedAt = clock.mock.results[0]
      const finishedAt = clock.mock.results.at(-1)
      if (startedAt?.type !== 'return' || finishedAt?.type !== 'return') throw new Error('real clock not observed')
      expect(verification.outcome).toBe('workload-completed-shard-observed')
      expect(verification.polls).toBe(2)
      expect(queryWorkload).toHaveBeenCalledTimes(2)
      expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([1, 1])
      expect(verification.elapsedMs).toBe(finishedAt.value - startedAt.value)
    } finally {
      timers.mockRestore()
      clock.mockRestore()
    }
  })

  it.each([
    ['timeoutMs 非整数', { timeoutMs: 0.5 }],
    ['timeoutMs 小于 1', { timeoutMs: 0 }],
    ['maxPolls 非整数', { maxPolls: 1.5 }],
    ['maxPolls 小于 1', { maxPolls: 0 }],
    ['initialDelayMs 非整数', { initialDelayMs: 0.5 }],
    ['initialDelayMs 小于 0', { initialDelayMs: -1 }],
    ['maxDelayMs 非整数', { maxDelayMs: 0.5 }],
    ['maxDelayMs 小于 initialDelayMs', { maxDelayMs: 5 }],
  ])('refuses an unbounded window before any read: %s', async (_label, override) => {
    const { options, queryWorkload } = window([[1, 0]], override)
    await expect(verifySubmittedResult(options)).rejects.toThrow('EDGE_VERIFICATION_CONFIG_INVALID')
    expect(queryWorkload).not.toHaveBeenCalled()
  })

  it('refuses a verification without a workload identity', async () => {
    const { options } = window([[1, 0]])
    await expect(verifySubmittedResult({ ...options, identity: { ...identity, workloadId: '' } }))
      .rejects.toThrow('EDGE_VERIFICATION_CONFIG_INVALID')
  })
})

/**
 * 回执语义诚实（工单 6 · 第 3 条，源码审计）。
 *
 * 本地发送回执只证明"这帧从本进程出去了"；平台不发任何确认帧，所以**任何用户可见处**
 * 都不许把它说成"平台已确认"。本组直接读源码文本：只要有人把"发出"写成"被平台确认"，
 * 这里就红。否定式说明（"平台**不**发确认帧"）是诚实的，因此按否定词放行。
 */
describe('回执语义诚实（源码审计）', () => {
  /** 仓库根：本文件在 `packages/host/compute-core/tests/edge-worker/` 下，往上五级。 */
  const root = fileURLToPath(new URL('../../../../../', import.meta.url))
  /** 用户可见面：本包的边缘执行/传输、常驻装配、以及节点守护自身的状态面。 */
  const surfaces = [
    'packages/host/compute-core/src',
    'packages/host/node-contributor/src',
    'apps/qianshou-node',
  ]
  /** 只谈"发出去了"的那一行才算回执行。 */
  const RECEIPT = /sent-awaiting-verification|local receipt|本地回执/
  /** 把"本地发出"升级成"平台已确认"的措辞。 */
  const CLAIMS = ['已确认', '平台确认', '已受理', '平台已', 'confirmed', 'acknowledg', 'accepted by']
  /** 否定式说明（"平台不发确认帧"/"never a server result acceptance"）不在此门内。 */
  const NEGATIONS = ['不', '没', '未', '无', '非', 'never', 'not ', 'no ']

  /** 每个受审文件一行；`node_modules`/构建产物不属用户可见面。 */
  function surfaceFiles(): string[] {
    return surfaces.flatMap(relative => readdirSync(join(root, relative), { recursive: true, encoding: 'utf8' })
      .map(entry => join(relative, entry))
      .filter(entry => !entry.includes('node_modules') && !entry.includes('/lib/') && !entry.includes('/dist/'))
      .filter(entry => /\.(?:ts|mts|cts|mjs|vue)$/.test(entry)))
  }

  it('never describes a local send receipt as a platform confirmation', async () => {
    const files = surfaceFiles()
    expect(files.length).toBeGreaterThan(50)
    let receiptLines = 0
    for (const relative of files) {
      const source = await readFile(join(root, relative), 'utf8')
      for (const line of source.split('\n')) {
        if (!RECEIPT.test(line)) continue
        receiptLines += 1
        if (NEGATIONS.some(word => line.includes(word))) continue
        for (const claim of CLAIMS) expect(`${relative}: ${line}`).not.toContain(claim)
      }
    }
    // 审计必须真的扫到了回执行，否则这条门是空转。
    expect(receiptLines).toBeGreaterThan(0)
  })

  it('pins the receipt type itself: one state, documented as not an acceptance', async () => {
    const types = await readFile(join(root, 'packages/host/compute-core/src/edge-worker/types.ts'), 'utf8')
    // 结构钉子：回执只有一个取值（加宽即红），且它的说明把"本地发出 ≠ 平台受理"写死。
    expect(types).toMatch(
      /\/\*\* A local send receipt, never a server result acceptance or settlement receipt\. \*\/\nexport interface EdgeResultSent \{\n {2}readonly state: 'sent-awaiting-verification'\n\}/,
    )
  })
})
