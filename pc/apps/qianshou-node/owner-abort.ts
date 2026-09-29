/**
 * E3 的"主人立刻中止当前任务"词表 —— 本仓唯一一份，且**为什么不是 import 来的**写在这里。
 *
 * 实测（2026-09-22 17:14，本仓 `git status --short packages/host/compute-core`）：
 * E3 在 `compute-core` 的实现**已不在源码树**——`src/edge-worker/owner-abort.ts` 不存在、
 * `src/edge-worker/connection.ts` 里 `abortByOwner` / `ownerAbort` 也不存在，只剩
 * `packages/host/compute-core/lib/types/edge-worker/owner-abort.d.ts`（构建产物，`lib/` 被
 * `.gitignore` 忽略、无 git 记录）作为它的遗留形状。同时 `compute-core` 带**他人未提交改动**，
 * 本包按边界承诺**一行不碰**，所以这里**没有**可以 import 的那个模块。
 *
 * 因此本文件承担两件事，且只承担这两件：
 * 1. 把 E3 已经定下的**词表**原样钉住（`canceled-by-owner` / `EDGE_CANCELED_BY_OWNER` /
 *    `owner-local`，逐字取自上面那份遗留 `.d.ts`），使 E9 不发明第三套说法；
 * 2. 说明两条**有意偏离**，以及为什么偏离才是诚实的（见 {@link OwnerAbortOutcome}）。
 *
 * 回归闸：`tests/owner-abort-vocabulary.spec.ts` 在 `compute-core` 重新出现 `owner-abort`
 * 源码时**变红**——那一刻唯一正确的动作是删掉本文件、改为 import，而不是让两份词表并存。
 */

/** 中止帧携带的审计码：调度方必须能分清"主人停了"与"这台机器跑不了"。 */
export const OWNER_CANCEL_CODE = 'EDGE_CANCELED_BY_OWNER' as const

/** 本地记录的状态值：中止**不是**失败，也不是完成。 */
export const OWNER_CANCEL_STATE = 'canceled-by-owner' as const

/**
 * 谁可以拉这根闸。
 *
 * 只有机主。平台与任务方一律拒绝——不是因为它们整体不可信，而是设计 §4.3 把停止权
 * 只交给机器的主人：能让任务方停掉自己任务的对手，等于多了一个结算杠杆。
 */
export type EdgeAbortSource = 'owner-local' | 'platform' | 'task-party'

/** 本条链路内唯一的来源：本地主人通道。 */
export const OWNER_LOCAL_SOURCE: EdgeAbortSource = 'owner-local'

/** 一条任务的终态。`canceled-by-owner` 与 `failed` 必须是两个值。 */
export type EdgeTaskState = 'running' | 'completed' | 'failed' | 'canceled-by-owner'

/**
 * 拒绝/中止时随帧发出的原因，形状与 `compute-core/src/edge-worker/types.ts:87-92` 的
 * `EdgeTaskFailure` **逐字相同**（那个类型没有从 `compute-core` 包根导出，所以这里按结构声明，
 * 不复制它的语义：`code` 是机器码，`message` 是一句有界的人话）。
 */
export interface NodeRefusal {
  /** 稳定的机器码，例如 `EDGE_CANCELED_BY_OWNER`。 */
  readonly code: string
  /** 一句有界的人话；永远不是令牌，也不是原始帧体。 */
  readonly message: string
}

/** 主人这根闸一次动作的结果；`aborted`/`skipped` 是本地事实，`keptArtifacts` 是"中止不销毁已有工作"。 */
export interface OwnerAbortOutcome {
  readonly state: typeof OWNER_CANCEL_STATE
  /** 主人点名的目标：`all` 或某个 `shardId`。 */
  readonly target: string
  /** 真的被停下来的分片。 */
  readonly aborted: readonly string[]
  /** 点名了但没能停的，以及为什么——不许把"没停到"报成成功。 */
  readonly skipped: readonly { readonly shardId: string; readonly why: OwnerAbortSkipReason }[]
  /** 有界原因（控制字符已剥离、已截断）。 */
  readonly reason: string
  /**
   * 是否**真的**停掉了至少一条执行。
   *
   * 有意偏离 E3 遗留形状里的字面量 `stop: true`：主人对一条已经跑完的任务拉闸时，
   * 说自己"停下来了"就是谎报。空操作 ⇒ `false`。
   */
  readonly stopped: boolean
  /** 永远不是任务失败。 */
  readonly classifiedAsFailure: false
  /** 本节点不为主人中止安排任何重试。 */
  readonly retryScheduled: false
  /** 本节点不请求退款；是否仍收部分费用是合同的事（设计 §4.3）。 */
  readonly refundRequested: false
  /** 中止之前已经产出的产物，保留。 */
  readonly keptArtifacts: readonly string[]
}

/** 没能停下来的两种原因，both 都是事实，不是推测。 */
export type OwnerAbortSkipReason =
  /** 这个 `shardId` 现在不在本节点的执行账上。 */
  | 'not-running'
  /** 拒绝帧发不出去（租约已随回传销毁、链路已断）：执行没停在这根闸上。 */
  | 'wire-refused'
  /** 来源不是本机主人。执行没有被碰。 */
  | 'unauthorized'

/** 原因的长度上限：中止原因会随拒绝帧出门，必须是有界的。 */
export const OWNER_ABORT_REASON_LIMIT = 200

/**
 * 把一段人话收成有界原因：剥控制字符、压空白、截断。
 * @param value - 主人/调用方给的原因，长度与字符集都不受信任。
 * @returns 可直接写进帧与本地账的有界原因。
 */
export function boundedAbortReason(value: string): string {
  const flattened = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return flattened.slice(0, OWNER_ABORT_REASON_LIMIT)
}
