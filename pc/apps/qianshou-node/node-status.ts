/**
 * E9 第一层：本机"正在跑什么"的唯一一份账。
 *
 * 为什么必须在这里而不是在 `compute-core`：`EdgeWorkerConnection` 的状态是**封死**的——
 * `stage`/`workerId`/`mode`/`#leases` 全是 `private`/`#`，对外只有 `connect`/`updateMode`/
 * `reportProgress`/`complete`/`reject`/`close` 六个方法（实测 `edge-worker/connection.ts:36-57,76,107,113,124,143,170`），
 * 唯一的出站汇报口是 `onEvent` 的三个事件（`types.ts:95-98`）。所以"主人看得见"不能靠读那个对象，
 * 只能靠在**真正发生事情的调用点**上记账：这正是 {@link observeNodeConnection} 做的事——
 * 它不复制执行逻辑，只是在同一次调用里把已经发出的事实抄一份到本地账上。
 *
 * 这份账里每一个数字都来自**发生过的一次调用**，没有一个是推断出来的：
 * - 派单 → 守护进程收到 `onOffer`（{@link NodeStatusTracker.offerDelivered}）
 * - 接单 → 链路上真的发出了第一帧 `shard_progress`（执行方自己的开始标记，`execute-offer.ts:54`）
 * - 成功 → 链路上真的发出了 `shard_result`（`connection.complete`）
 * - 拒绝/失败 → 链路上真的发出了拒绝帧（`connection.reject` 的 `failure.code`）
 *
 * 钱是唯一的例外，而且例外是**如实报缺**：派单帧里没有价格字段（`connection.ts:303-317` 的
 * `parseOffer` 只解身份/输入/租约/超时），所以 {@link NodeStatusSnapshot.earnings} 恒为
 * `null` + `basis`，绝不猜一个数字。
 */
import type { EdgeInlineResult, EdgeResultSent, EdgeTaskIdentity, EdgeTaskOffer } from '@deepseek-ai/dsh-compute-core'
import {
  boundedAbortReason,
  OWNER_CANCEL_CODE,
  OWNER_CANCEL_STATE,
  OWNER_LOCAL_SOURCE,
  type EdgeAbortSource,
  type NodeRefusal,
  type OwnerAbortOutcome,
  type OwnerAbortSkipReason,
} from './owner-abort.ts'

/** 快照的契约版本；字段增删要一起改这里和客户端的消费规格（报告 §6）。 */
export const NODE_STATUS_SCHEMA = 'qianshou.node-status.v1' as const

/**
 * 链路丢失时写进本地账的失败码。
 *
 * **只存在于本地**：链路已经断了，这个码永远不出门（不会有第二套线上语义）。
 */
export const LINK_LOST_CODE = 'EDGE_LINK_LOST' as const

/** `recent` 保留的最近结果条数。 */
export const NODE_STATUS_RECENT_LIMIT = 10

/** 主人中止过的分片记住多少条（只为把迟到的结果认出来，不需要无限增长）。 */
const OWNER_STOPPED_LIMIT = 256

/** 连接状态：`connecting` 含"还没握手完"与"退避重连中"，`offline` 带原因。 */
export type NodeConnectionState = 'connecting' | 'online' | 'offline'

/** 一条任务在本地账里的终局分类。 */
export type NodeTaskOutcomeKind = 'succeeded' | 'refused' | 'failed' | 'canceled-by-owner'

/** 执行方在这一帧里报告的事实：`complete` 或 `reject`，没有第三种。 */
export type NodeOfferSettlement =
  | { readonly kind: 'succeeded'; readonly elapsedMs: number }
  | { readonly kind: 'rejected'; readonly code: string; readonly reason: string }

/** 正在跑的一条任务。`progressEvents` 是**测到的**进度事件条数，`progressPct` 是最后一帧的值。 */
export interface NodeRunningTask {
  /** 接单专员此刻的步骤轨迹（面板「正在跑什么」直接显示它）。 */
  readonly trace?: readonly string[]
  readonly shardId: string
  readonly workloadId: string
  readonly attempt: number
  readonly taskType: string
  readonly startedAt: string
  /** 相对 `startedAt` 的实测耗时（毫秒），随快照实时计算。 */
  readonly elapsedMs: number
  readonly progressPct: number
  readonly progressEvents: number
}

/** 一条已结束的任务留下的一行痕迹。 */
export interface NodeTaskRecord {
  /** 接单专员（子代理）的执行轨迹：scout → worker → verifier → courier 每步一行。
   *  为什么要落账：面板上"正在跑什么"要能看出**子代理在做什么**，而不是只有一个结局。 */
  readonly trace?: readonly string[]
  readonly shardId: string
  readonly taskType: string
  readonly outcome: NodeTaskOutcomeKind
  readonly at: string
  readonly durationMs: number
  readonly reason: string | null
}

/** 最近一次拒绝帧的原文；`kind` 让"拒绝接单"与"跑失败"在中止之外也能分开。 */
export interface NodeRefusalRecord {
  readonly shardId: string
  readonly kind: 'refused' | 'failed' | 'canceled-by-owner'
  readonly code: string
  readonly reason: string
  readonly at: string
}

/** 机器可读的节点自述。客户端消费规格见报告 §6（字段 → UI 元素）。 */
export interface NodeStatusSnapshot {
  readonly schema: typeof NODE_STATUS_SCHEMA
  readonly pid: number
  readonly startedAt: string
  readonly uptimeSeconds: number
  readonly connection: {
    readonly state: NodeConnectionState
    /** 掉线原因（传输层自己的码），在线时为 `null`。 */
    readonly reason: string | null
    readonly core: string
    /** 最近一次认证得到的 worker_id；掉线后保留，因为它是**这台节点**的身份而不是链路的。 */
    readonly workerId: string | null
    readonly ownerId: number | null
    readonly mode: 'running' | 'paused' | 'unknown'
    readonly onlineSince: string | null
    readonly onlineSeconds: number | null
  }
  /** 当前正在跑的任务；并发派单时取**开始最早**的那条，`tasks` 才是全集。 */
  readonly current: NodeRunningTask | null
  readonly tasks: readonly NodeRunningTask[]
  readonly counters: {
    readonly offersReceived: number
    readonly accepted: number
    readonly succeeded: number
    readonly failed: number
    readonly rejected: number
    readonly canceledByOwner: number
  }
  readonly lastRefusal: NodeRefusalRecord | null
  readonly recent: readonly (NodeTaskRecord & { readonly verification: string | null })[]
  readonly earnings: {
    readonly estimatedNodeYuan: null
    readonly basis: 'not-carried-in-dispatch-frame'
    readonly note: string
  }
}

/** 观察者接口：{@link observeNodeConnection} 只认识这三个回调，台账由实现方负责。 */
export interface NodeStatusObserver {
  /** 执行方报告了一次进度；**第一次**出现即为"本节点接了这单"。 */
  observeProgress(identity: EdgeTaskIdentity, fraction: number): void
  /** 执行方结束了这条任务：回传成功或发出拒绝帧。 */
  observeSettled(identity: EdgeTaskIdentity, settlement: NodeOfferSettlement): void
}

/** 传输上"执行方会调的那三个方法"。结构上等于 `Pick<EdgeWorkerPort,'reportProgress'|'complete'|'reject'>`。 */
export interface NodeExecutionPort {
  reportProgress(identity: EdgeTaskIdentity, fraction: number): void
  complete(identity: EdgeTaskIdentity, result: EdgeInlineResult): EdgeResultSent
  reject(identity: EdgeTaskIdentity, failure: NodeRefusal): void
}

/** 台账 + 主人中止那一根闸（两者必须同源：一根闸只能停账上真在跑的任务）。 */
export interface NodeStatusTracker extends NodeStatusObserver {
  /** 还没认证：初始态，或一次退避重连的间隙。 */
  connectionConnecting(core: string): void
  /** `auth_ok` 之后（`connection.ts:194-195` 的 `authenticated` 事件）。 */
  connectionOnline(input: { readonly core: string; readonly workerId: string; readonly ownerId: number; readonly mode: 'running' | 'paused' }): void
  /** 链路结束；在跑的任务按"链路丢失"结账——这不是主人的决定，也不是任务失败码。 */
  connectionOffline(reason: string): void
  /**
   * 一条派单帧到了本进程，账上开一条任务。
   * @param offer - 已经过传输层帧校验的派单。
   * @param parent - 链路生命期 signal；它一断，这条任务的 signal 跟着断。
   * @returns 交给执行方的那条 signal——**就是**守护进程传给 `executeNodeOffer` 的那条。
   */
  offerDelivered(offer: EdgeTaskOffer, parent: AbortSignal): AbortSignal
  /** 轮询核验的结论（`compute-core/src/edge-worker/polled-verification.ts` 的四态原文）。 */
  recordVerification(shardId: string, outcome: string): void
  /** 记下接单专员这一单的执行轨迹（供面板展示"子代理在跑什么"）。 */
  noteTrace(shardId: string, trace: readonly string[]): void
  /** 这条任务是不是主人停的（用于区分"执行方抛出的取消异常"与"真的执行出错"）。 */
  isOwnerStopped(identity: EdgeTaskIdentity): boolean
  /**
   * 主人那根闸：停一个分片或全部。
   *
   * 顺序是有讲究的：**先发拒绝帧，再断 signal**。拒绝帧需要仍然有效的租约
   * （`connection.reject` 会 `#leases.delete`，`connection.ts:143-151`）；反过来先断 signal，
   * 帧就发不出去了，调度方只会看到分片空等。
   * @param input - 目标、原因，以及往链路上发拒绝帧的那个方法（生产环境传被观察的 `reject`）。
   * @returns 停了什么、没停什么、以及为什么。
   */
  stopOwnerTasks(input: {
    readonly target: 'all' | string
    readonly reason: string
    readonly source?: EdgeAbortSource
    readonly reject: (identity: EdgeTaskIdentity, failure: NodeRefusal) => void
  }): OwnerAbortOutcome
  /** 当前时刻的机器可读快照。 */
  snapshot(): NodeStatusSnapshot
}

/** 台账构造参数。 */
export interface NodeStatusTrackerOptions {
  /** 可注入时钟，使"已经跑了多久"可被断言而不是靠睡眠。 */
  readonly clock?: () => number
  /** 可注入 pid，测试里不依赖真实进程号。 */
  readonly pid?: number
}

interface RunningEntry {
  readonly identity: EdgeTaskIdentity
  readonly taskType: string
  readonly startedAt: number
  progressPct: number
  progressEvents: number
  readonly controller: AbortController
}

interface TaskRecordEntry {
  readonly shardId: string
  readonly taskType: string
  readonly outcome: NodeTaskOutcomeKind
  readonly at: number
  readonly durationMs: number
  readonly reason: string | null
}

/**
 * 把传输连接包成"会记账的同一条连接"。
 *
 * 关键性质：包装没有新增、没有改写任何一帧——`reportProgress`/`complete`/`reject` 原样透传，
 * 记账只是同一次调用的旁观。因此台账里的每个数字都对应链路上真实发生过的一帧。
 * @param connection - 真实连接（或测试替身）。
 * @param observer - 记账方；生产环境就是 {@link createNodeStatusTracker} 的返回值。
 * @returns 与 `connection` 行为一致、但会记账的端口；可直接交给 `executeNodeOffer`。
 */
export function observeNodeConnection(connection: NodeExecutionPort, observer: NodeStatusObserver): NodeExecutionPort {
  return {
    reportProgress(identity, fraction) {
      connection.reportProgress(identity, fraction)
      observer.observeProgress(identity, fraction)
    },
    complete(identity, result) {
      const sent = connection.complete(identity, result)
      observer.observeSettled(identity, { kind: 'succeeded', elapsedMs: result.elapsedMs })
      return sent
    },
    reject(identity, failure) {
      connection.reject(identity, failure)
      observer.observeSettled(identity, { kind: 'rejected', code: failure.code, reason: failure.message })
    },
  }
}

/**
 * 建一份本进程的节点账。
 * @param options - 时钟与 pid（都为可注入，便于断言）。
 * @returns 台账与本机中止闸。
 */
export function createNodeStatusTracker(options: NodeStatusTrackerOptions = {}): NodeStatusTracker {
  const clock = options.clock ?? (() => Date.now())
  const pid = options.pid ?? process.pid
  const startedAt = clock()
  const running = new Map<string, RunningEntry>()
  const records: TaskRecordEntry[] = []
  const verification = new Map<string, string>()
  // 每个分片的执行轨迹（专员四步）—— 任务结束也留着，供「最近一次执行」展示。
  const traces = new Map<string, readonly string[]>()
  const ownerStopped = new Set<string>()
  const counters = { offersReceived: 0, accepted: 0, succeeded: 0, failed: 0, rejected: 0, canceledByOwner: 0 }
  let connection: NodeStatusSnapshot['connection'] = {
    state: 'connecting', reason: null, core: '', workerId: null, ownerId: null, mode: 'unknown', onlineSince: null, onlineSeconds: null,
  }
  let lastRefusal: NodeRefusalRecord | null = null

  const iso = (instant: number) => new Date(instant).toISOString()
  const runningTask = (entry: RunningEntry): NodeRunningTask => ({
    shardId: entry.identity.shardId, workloadId: entry.identity.workloadId, attempt: entry.identity.attempt,
    taskType: entry.taskType, startedAt: iso(entry.startedAt), elapsedMs: Math.max(0, Math.round(clock() - entry.startedAt)),
    progressPct: entry.progressPct, progressEvents: entry.progressEvents,
    trace: traces.get(entry.identity.shardId),
  })
  const record = (entry: RunningEntry, outcome: NodeTaskOutcomeKind, reason: string | null, durationMs: number) => {
    records.push({ shardId: entry.identity.shardId, taskType: entry.taskType, outcome, at: clock(), durationMs, reason, trace: traces.get(entry.identity.shardId) })
    if (records.length > NODE_STATUS_RECENT_LIMIT) records.shift()
  }

  return {
    connectionConnecting(core) {
      connection = { state: 'connecting', reason: null, core, workerId: connection.workerId, ownerId: connection.ownerId, mode: 'unknown', onlineSince: null, onlineSeconds: null }
    },
    connectionOnline(input) {
      connection = {
        state: 'online', reason: null, core: input.core, workerId: input.workerId, ownerId: input.ownerId,
        mode: input.mode, onlineSince: iso(clock()), onlineSeconds: 0,
      }
    },
    connectionOffline(reason) {
      connection = { ...connection, state: 'offline', reason, onlineSince: null, onlineSeconds: null }
      // 掉线会连带停掉在跑的活（链路的 lifetime abort 就是这么做的）。这些活的结局是
      // "链路丢失"，不是 "canceled-by-owner"：主人的决定与网络的意外必须分得开。
      for (const [shardId, entry] of [...running]) {
        if (!entry.controller.signal.aborted) entry.controller.abort(new Error(LINK_LOST_CODE))
        counters.failed += 1
        record(entry, 'failed', `link lost: ${reason}`, Math.max(0, Math.round(clock() - entry.startedAt)))
        lastRefusal = { shardId, kind: 'failed', code: LINK_LOST_CODE, reason: `link lost: ${reason}`, at: iso(clock()) }
        running.delete(shardId)
      }
    },
    offerDelivered(offer, parent) {
      counters.offersReceived += 1
      const controller = new AbortController()
      if (parent.aborted) controller.abort(parent.reason)
      else parent.addEventListener('abort', () => controller.abort(parent.reason), { once: true })
      running.set(offer.shardId, { identity: offer, taskType: offer.taskType, startedAt: clock(), progressPct: 0, progressEvents: 0, controller })
      return controller.signal
    },
    observeProgress(identity, fraction) {
      const entry = running.get(identity.shardId)
      if (entry === undefined) return
      const next = Number.isFinite(fraction) ? Math.round(Math.max(0, Math.min(1, fraction)) * 100) : entry.progressPct
      if (next < entry.progressPct) return
      if (entry.progressEvents === 0) counters.accepted += 1
      entry.progressEvents += 1
      entry.progressPct = next
    },
    observeSettled(identity, settlement) {
      const entry = running.get(identity.shardId)
      // 账上没有这条任务 ⇒ 迟到或重复的帧。**一个字段都不改**：中止过的那条任务不允许被
      // 随后到达的 `shard_result` 改写（主人已经做了决定，迟到的成功不是新事实）。
      if (entry === undefined) return
      const durationMs = Math.max(0, Math.round(clock() - entry.startedAt))
      running.delete(identity.shardId)
      if (settlement.kind === 'succeeded') {
        counters.succeeded += 1
        record(entry, 'succeeded', null, settlement.elapsedMs)
        return
      }
      const ownerCancel = settlement.code === OWNER_CANCEL_CODE
      // 已经发出过开始帧 ⇒ 这活接过手了，之后的拒绝是"跑失败"；没发过 ⇒ 是准入阶段的"不接"。
      const kind: NodeRefusalRecord['kind'] = ownerCancel ? 'canceled-by-owner' : entry.progressEvents > 0 ? 'failed' : 'refused'
      if (ownerCancel) counters.canceledByOwner += 1
      else if (kind === 'failed') counters.failed += 1
      else counters.rejected += 1
      record(entry, kind, settlement.reason === '' ? null : settlement.reason, durationMs)
      lastRefusal = { shardId: identity.shardId, kind, code: settlement.code, reason: settlement.reason, at: iso(clock()) }
    },
    noteTrace(shardId, trace) {
      traces.set(shardId, trace)
    },
    recordVerification(shardId, outcome) {
      verification.set(shardId, outcome)
    },
    isOwnerStopped(identity) {
      return ownerStopped.has(identity.shardId)
    },
    stopOwnerTasks(input) {
      const source = input.source ?? OWNER_LOCAL_SOURCE
      const reason = boundedAbortReason(input.reason)
      if (source !== OWNER_LOCAL_SOURCE) {
        const listed = input.target === 'all' ? [...running.keys()] : [input.target]
        return {
          state: OWNER_CANCEL_STATE, target: input.target, aborted: [],
          skipped: listed.map(shardId => ({ shardId, why: 'unauthorized' as const })),
          reason: reason === '' ? OWNER_CANCEL_CODE : reason,
          stopped: false, classifiedAsFailure: false, retryScheduled: false, refundRequested: false, keptArtifacts: [],
        }
      }
      const bounded = reason === '' ? OWNER_CANCEL_CODE : reason
      const targets = input.target === 'all' ? [...running.keys()] : [...running.keys()].filter(shardId => shardId === input.target)
      const aborted: string[] = []
      const skipped: { shardId: string; why: OwnerAbortSkipReason }[] = []
      for (const shardId of targets) {
        const entry = running.get(shardId)
        if (entry === undefined) { skipped.push({ shardId, why: 'not-running' }); continue }
        const controller = entry.controller
        try {
          input.reject(entry.identity, { code: OWNER_CANCEL_CODE, message: bounded })
        } catch {
          // 帧发不出去（租约已随回传销毁、或链路已断）⇒ 执行没停在这根闸上，如实登记。
          skipped.push({ shardId, why: 'wire-refused' })
          continue
        }
        ownerStopped.add(shardId)
        while (ownerStopped.size > OWNER_STOPPED_LIMIT) ownerStopped.delete(ownerStopped.values().next().value as string)
        if (!controller.signal.aborted) controller.abort(new Error(OWNER_CANCEL_CODE))
        aborted.push(shardId)
      }
      if (input.target !== 'all' && targets.length === 0) skipped.push({ shardId: input.target, why: 'not-running' })
      return {
        state: OWNER_CANCEL_STATE, target: input.target, aborted, skipped, reason: bounded,
        stopped: aborted.length > 0, classifiedAsFailure: false, retryScheduled: false, refundRequested: false, keptArtifacts: [],
      }
    },
    snapshot() {
      const now = clock()
      const tasks = [...running.values()].map(runningTask)
      return {
        schema: NODE_STATUS_SCHEMA,
        pid,
        startedAt: iso(startedAt),
        uptimeSeconds: (now - startedAt) / 1000,
        connection: {
          ...connection,
          onlineSeconds: connection.onlineSince === null ? null : (now - Date.parse(connection.onlineSince)) / 1000,
        },
        current: tasks[0] ?? null,
        tasks,
        counters: { ...counters },
        lastRefusal,
        recent: records.map(entry => ({ ...entry, at: iso(entry.at), verification: verification.get(entry.shardId) ?? null })),
        earnings: {
          estimatedNodeYuan: null,
          basis: 'not-carried-in-dispatch-frame',
          note: '派单帧只带身份/输入/租约，不带报价；本节点不猜收益（设计 §4.2 的报价卡仍被上游阻塞）。',
        },
      }
    },
  }
}
