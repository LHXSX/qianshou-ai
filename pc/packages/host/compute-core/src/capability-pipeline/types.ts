/**
 * 工单 8 的**注入端口与判定类型**：宿主（节点进程）实现 {@link CapabilityProbePort}，
 * 管线产出 {@link CapabilityHealthObservation}。
 *
 * 为什么把端口单独放一个文件：这是本工单里唯一需要**真实执行外部进程/模型**的缝，
 * 把它与判定逻辑分开，测试才能在不跑 ffmpeg 的前提下钉住"判定规则本身"，
 * 而真机验证只需要替换这一个端口。
 */

/** 健康判定的三态。只有 `ok` 能进候选池；`degraded` 与 `missing` 都不进。 */
export type CapabilityHealth = 'ok' | 'degraded' | 'missing'

/** 管线自己产出的失败原因码（端口也可以给出自己的原因码，如 `EXECUTOR_EXIT_NONZERO`）。 */
export const CAPABILITY_HEALTH_FAILURE_REASONS = Object.freeze({
  /** 端口没有真的调用这项能力（例如只检查了文件存在）。 */
  NOT_AN_INVOCATION: 'PROBE_NOT_AN_INVOCATION',
  /** 端口自己抛错。 */
  THREW: 'PROBE_THREW',
  /** 能跑但结果打折（不进候选池）。 */
  DEGRADED: 'PROBE_REPORTED_DEGRADED',
  /** 端口说失败却没说原因。 */
  NO_REASON_GIVEN: 'PROBE_FAILED_WITHOUT_REASON',
} as const)

/** 失败原因码：管线自产的四个，或端口自报的任意原因码。 */
export type CapabilityHealthFailureReason = string

/** 一次最小真实调用的结果。`invoked` 为 `false` 时**不论 `ok` 是什么都不算通过**。 */
export interface CapabilityProbeOutcome {
  /** 本项被真的调用过一次；"文件在 / 命令在 PATH 里 / 版本号可读"一律不算。 */
  readonly invoked: boolean
  /** 调用是否按预期完成。 */
  readonly ok: boolean
  /** 能跑但打折（如量化后的模型）时为 true；这种情况同样不进候选池。 */
  readonly degraded?: boolean
  /** 失败原因码；成功时可以省略。 */
  readonly reason?: string | null
  /** 主人可读的细节（命令、退出码、错误行）。 */
  readonly detail?: string
}

/** 宿主提供的探测端口：对本能力做一次最小真实调用。抛错也会被记成失败。 */
export interface CapabilityProbePort {
  readonly invoke: (capability: string, signal?: AbortSignal) => Promise<CapabilityProbeOutcome>
}

/** 一项能力的一次健康判定。 */
export interface CapabilityHealthObservation {
  readonly capability: string
  readonly health: CapabilityHealth
  /** 是否真的调用过：这是"真实化"与"假健康"之间唯一的分界线。 */
  readonly invoked: boolean
  readonly reason: CapabilityHealthFailureReason | null
  readonly detail: string
}

/** 一项能力没进候选池的原因（主人追问"为什么没有它"的唯一出口）。 */
export interface CapabilityHealthRefusal {
  readonly capability: string
  readonly reason: CapabilityHealthFailureReason
  readonly detail: string
}
