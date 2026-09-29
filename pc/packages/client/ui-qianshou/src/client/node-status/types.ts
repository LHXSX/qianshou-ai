import { parseH3VideoStatus, type NodeH3VideoStatus } from './h3-status.ts'

/**
 * U1 显示面的消费契约：字段名照抄上游 `qianshou.node-status.v1`（E9，另一个仓库已入库），
 * 这里只做**读**——不复制上游语义、不造第二套核验态。
 *
 * 钱是唯一的例外，而且例外是**如实报缺**：`earnings.estimatedNodeYuan` 恒为 `null`，
 * 因为派单帧里根本没有价格字段。任何"估算"都是编的，{@link earningsNumber} 永远返回 null。
 */
/** 上游快照的契约版本。 */
export const NODE_STATUS_SCHEMA = 'qianshou.node-status.v1'

/** 同源中继前缀：桌面外壳把 `dsh-app://app/*` 的其它路径转给自有宿主，因此这是渲染进程唯一能读的通道。 */
export const NODE_STATUS_ROUTE = 'qianshou-node'

/** 上游端点的默认端口（可用 `--status-port` 改）。 */
export const NODE_STATUS_PORT_DEFAULT = 47615

/** 连接状态。`connecting` 含"还没握手完"与"退避重连中"。 */
export type NodeConnectionState = 'connecting' | 'online' | 'offline'

/** 一条任务在本地账里的终局分类（上游原文）。 */
export type NodeOutcomeKind = 'succeeded' | 'refused' | 'failed' | 'canceled-by-owner'

/** 正在跑的一条任务。 */
export interface NodeRunningTask {
  readonly shardId: string
  readonly workloadId: string
  readonly attempt: number
  readonly taskType: string
  readonly startedAt: string
  readonly elapsedMs: number
  readonly progressPct: number
  readonly progressEvents: number
  /** `started` is the opening frame. `working` is a later liveness frame still at an unfinished fraction. */
  readonly phase?: 'started' | 'working' | 'done'
}

/** 一条已结束的任务留下的痕迹；`verification` 是轮询核验结论原文（可能是 `null` = 还没核验过）。 */
export interface NodeTaskRecord {
  readonly shardId: string
  readonly taskType: string
  readonly outcome: NodeOutcomeKind
  readonly at: string
  readonly durationMs: number
  readonly reason: string | null
  readonly verification: string | null
}

/** 最近一次拒绝帧的原文。 */
export interface NodeRefusalRecord {
  readonly shardId: string
  readonly kind: 'refused' | 'failed' | 'canceled-by-owner'
  readonly code: string
  readonly reason: string
  readonly at: string
}

/** 累计计数：每一项都来自发生过的一次调用。 */
export interface NodeCounters {
  readonly offersReceived: number
  readonly accepted: number
  readonly succeeded: number
  readonly failed: number
  readonly rejected: number
  readonly canceledByOwner: number
}

/** 机器可读的节点自述。 */
export interface NodeStatusSnapshot {
  readonly schema: typeof NODE_STATUS_SCHEMA
  readonly pid: number
  readonly startedAt: string
  readonly uptimeSeconds: number
  /** Optional local preflight evidence; it does not establish platform review or intake authority. */
  readonly h3Video?: NodeH3VideoStatus
  /** Reasons reported by the local owner admission, not platform dispatch receipts. */
  readonly intakeReason?: string | null
  readonly intakeReasons?: readonly string[]
  readonly connection: {
    readonly state: NodeConnectionState
    readonly reason: string | null
    readonly core: string
    readonly workerId: string | null
    readonly ownerId: number | null
    readonly mode: 'running' | 'paused' | 'unknown'
    readonly onlineSince: string | null
    readonly onlineSeconds: number | null
  }
  readonly current: NodeRunningTask | null
  readonly tasks: readonly NodeRunningTask[]
  readonly counters: NodeCounters
  readonly lastRefusal: NodeRefusalRecord | null
  readonly recent: readonly NodeTaskRecord[]
  readonly earnings: {
    readonly estimatedNodeYuan: null
    readonly basis: string
    readonly note: string
  }
}

/** 一次读取的结论：读到快照，或明确说出"为什么没读到"。 */
export type NodeStatusReadout =
  | { readonly kind: 'snapshot'; readonly snapshot: NodeStatusSnapshot }
  | { readonly kind: 'unreachable'; readonly code: NodeUnreachableCode; readonly message?: string }

/** 读不到的原因。中继没接线与节点没运行**不能混成一句话**。 */
export type NodeUnreachableCode = 'NODE_UNREACHABLE' | 'RELAY_MISSING' | 'RELAY_REFUSED' | 'BAD_PAYLOAD'

/** 端点命令：**照抄上游契约**（`abort` 的目标字段是 `target`，不是 `shardId`）。 */
export type NodeCommand =
  | { readonly command: 'tasks' }
  | { readonly command: 'abort'; readonly target: string; readonly reason?: string }

/** 命令结果。 */
export type NodeCommandOutcome =
  | { readonly ok: true; readonly code: string; readonly detail?: unknown }
  | { readonly ok: false; readonly code: string; readonly message?: string }

/** 面板开关看到的电源状态。不含 pid，不含凭据。 */
export interface NodePowerState {
  readonly running: boolean
  readonly managed: boolean
  readonly mode: 'paused' | 'running' | null
  readonly code?: string
}

/** 显示面唯一的取数口：测试注入桩，生产注入同源中继。 */
export interface NodeStatusTransport {
  read(options?: { readonly signal?: AbortSignal }): Promise<NodeStatusReadout>
  command(command: NodeCommand, options?: { readonly signal?: AbortSignal }): Promise<NodeCommandOutcome>
  /** 读窗口自带节点的开关位置。 */
  power(options?: { readonly signal?: AbortSignal }): Promise<NodePowerState>
  /**
   * 拨开关。
   * @param on - `true` 启动节点进程，`false` 停掉它。
   * @returns 动作之后的电源状态。
   */
  setPower(on: boolean, options?: { readonly signal?: AbortSignal }): Promise<NodePowerState>
}

/** 节点级状态标签：**五态必须互不相同**，不许全压成一句话。 */
export type NodePhase = 'never-started' | 'offline' | 'not-wired' | 'running' | 'standby' | 'connecting' | 'link-failed'

/** 核验四态的归类（上游 `polled-verification.ts` 原文 → 结论）。 */
export type NodeVerificationKey = 'settleable' | 'retryable' | 'retained' | 'indeterminate' | 'unpolled'

/**
 * 结构闸：只接受本契约的快照。
 * @param value - 待检值。
 * @returns 通过闸的快照，否则 `null`（调用方必须当成"读不到"，不许当空快照）。
 */
export function parseNodeStatus(value: unknown): NodeStatusSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.schema !== NODE_STATUS_SCHEMA) return null
  const connection = record.connection
  if (typeof connection !== 'object' || connection === null) return null
  const state = (connection as Record<string, unknown>).state
  if (state !== 'online' && state !== 'connecting' && state !== 'offline') return null
  const counters = record.counters
  if (typeof counters !== 'object' || counters === null) return null
  if (typeof (counters as Record<string, unknown>).offersReceived !== 'number') return null
  if (typeof record.earnings !== 'object' || record.earnings === null) return null
  if (record.intakeReason !== undefined && record.intakeReason !== null && typeof record.intakeReason !== 'string') return null
  if (record.intakeReasons !== undefined && (!Array.isArray(record.intakeReasons)
    || !record.intakeReasons.every(reason => typeof reason === 'string'))) return null
  const snapshot = value as NodeStatusSnapshot
  if (record.h3Video === undefined) return snapshot
  const h3Video = parseH3VideoStatus(record.h3Video)
  const { h3Video: _untrustedH3, ...rest } = snapshot
  return h3Video === null ? rest : { ...rest, h3Video }
}

/**
 * 核验态归类。
 * @param value - 轮询核验结论原文，或 `null`（还没核验过）。
 * @returns 四态之一；读不到一律是 `indeterminate`，**绝不当成功**。
 */
export function verificationKey(value: string | null): NodeVerificationKey {
  switch (value) {
    case 'workload-completed-shard-observed': return 'settleable'
    case 'workload-failed-shard-observed': return 'retryable'
    case 'no-change-within-window': return 'retained'
    case 'unobservable': return 'indeterminate'
    default: return 'unpolled'
  }
}

/**
 * 这一条结果能不能结算。
 * @param value - 轮询核验结论原文。
 * @returns 只有计数前进这一种能结算。
 */
export function verificationSettleable(value: string | null): boolean {
  return verificationKey(value) === 'settleable'
}

/**
 * 节点级状态标签。
 * @param readout - 最近一次读取结论，`null` 表示本次客户端生命周期里**一次都没读到过**。
 * @returns 七态之一，`never-started` 与 `offline` 必须分开。
 */
export function nodePhase(readout: NodeStatusReadout | null): NodePhase {
  if (readout === null) return 'never-started'
  if (readout.kind === 'unreachable') {
    return readout.code === 'RELAY_MISSING' || readout.code === 'RELAY_REFUSED' ? 'not-wired' : 'offline'
  }
  const { connection, current } = readout.snapshot
  if (connection.state === 'connecting') return 'connecting'
  if (connection.state === 'offline') return 'link-failed'
  if (connection.mode === 'paused') return 'standby'
  return current === null ? 'standby' : 'running'
}

/**
 * 收益数字。
 * @param snapshot - 快照，或 `null`。
 * @returns **永远 `null`**：派单帧不带报价，本节点不猜收益。
 */
export function earningsNumber(snapshot: NodeStatusSnapshot | null): null {
  void snapshot
  return null
}

/**
 * `HH:MM:SS`（小时不封顶）。
 * @param totalSeconds - 秒数，负数按 0 处理。
 * @returns 定宽时长文本。
 */
export function formatDuration(totalSeconds: number): string {
  const total = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/**
 * 墙上时刻（本地时区，`HH:MM:SS`）。
 * @param iso - ISO 时间串。
 * @returns 时刻文本；解析不了就返回原文，不编一个时间。
 */
export function formatClock(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return iso
  const date = new Date(parsed)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 从快照里认出"主人最该被打扰的那一条"的机器时刻。
 * @param iso - 快照里的 ISO 时间串。
 * @param fallback - 解析失败时的兜底时刻。
 * @returns 毫秒时刻。
 */
export function eventTime(iso: string | null | undefined, fallback: number): number {
  const parsed = iso === null || iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isNaN(parsed) ? fallback : parsed
}
