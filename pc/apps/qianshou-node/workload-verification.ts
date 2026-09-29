/**
 * 节点侧核验装配：把"发完就悬空"的本地发送事实接到**平台自己的读侧**上。
 *
 * 为什么需要这一层：`EdgeWorkerConnection.complete` 只能证明这一帧出了本进程；
 * 平台不发任何确认帧（C7 N6），所以节点过去永远停在 `sent-awaiting-verification`。
 * 这里用**已经审计过的** HTTP 读侧（`GET /api/v8/workloads/{id}`，即
 * `supply/edge-api.ts:queryWorkload`）去轮询平台自己的作品投影，并与**发出之前**
 * 读到的分片计数比较。
 *
 * 两条不许越过的线：
 * - 基线必须在**发出之前**读。发出之后再读的第一份读数无法区分"本来就是这样"和
 *   "因为这次回传才这样"，用它当基线等于自己造一个受理结论。
 * - 读不到基线就返回 `null`，绝不补 0；`null` 会让核验直接给出 `unobservable`
 *   （见 `polled-verification.ts:EDGE_VERIFICATION_NO_BASELINE`）。
 *
 * 命名诚实：这不是回执。平台没有确认任何东西，本层只是**轮询**，而且读侧是
 * 按工作负载聚合的，连分片归属都拿不到（详见 `EdgeResultVerification.attribution`）。
 */
import { EdgeSupplyApi, type EdgeTaskIdentity } from '@deepseek-ai/dsh-compute-core'
import { verifySubmittedResult, type EdgeResultVerification, type WorkloadStatusReader } from '@deepseek-ai/dsh-compute-core/edge-worker/polled-verification.ts'
import type { WorkloadShardCounters } from '@deepseek-ai/dsh-compute-core/edge-worker/types.ts'

/** 默认核验窗口：30 秒预算、最多 6 次读、1 秒首等、退避封顶 8 秒。 */
export const DEFAULT_NODE_VERIFICATION_WINDOW = Object.freeze({
  timeoutMs: 30_000, maxPolls: 6, initialDelayMs: 1_000, maxDelayMs: 8_000,
})

/** 装配参数；`baseUrl`/`tokenProvider` 与节点自己的 `EdgeWorkerConnection` 同源。 */
export interface NodeResultVerificationOptions {
  readonly baseUrl: string
  readonly tokenProvider: () => string | undefined
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly window?: { readonly timeoutMs: number; readonly maxPolls: number; readonly initialDelayMs: number; readonly maxDelayMs: number }
  /** 测试注入；生产不传，直接复用 `EdgeSupplyApi`。 */
  readonly reader?: WorkloadStatusReader
}

/** 节点侧核验器：先读基线，发出结果后再轮询核验。 */
export interface NodeResultVerification {
  /** 读发出前的分片计数；读不到就是 `null`，不是 0。 */
  before(identity: EdgeTaskIdentity, signal?: AbortSignal): Promise<WorkloadShardCounters | null>
  /** 轮询核验这一份已发出的结果。 */
  verify(identity: EdgeTaskIdentity, before: WorkloadShardCounters | null, signal?: AbortSignal): Promise<EdgeResultVerification>
  close(): void
}

/**
 * 用节点既有的核心地址与凭据装配核验器；构造时不起任何请求。
 * @param options - 核心地址、凭据提供者、HTTP 限制与核验窗口。
 * @returns 核验器；`close` 只关闭它自己建立的 HTTP 客户端。
 */
export function createNodeResultVerification(options: NodeResultVerificationOptions): NodeResultVerification {
  const reader = options.reader ?? new EdgeSupplyApi({ baseUrl: options.baseUrl, tokenProvider: options.tokenProvider,
    timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes })
  const window = options.window ?? DEFAULT_NODE_VERIFICATION_WINDOW
  return {
    async before(identity, signal) {
      try {
        const workload = await reader.queryWorkload(identity.workloadId, signal)
        return { completedShards: workload.completedShards, failedShards: workload.failedShards }
      } catch {
        // 看不到就是看不到：返回 null 让核验走"不可观察"分支，而不是编一个 0 基线。
        return null
      }
    },
    verify: (identity, before, signal) => verifySubmittedResult({ reader, identity, before, ...window, ...(signal === undefined ? {} : { signal }) }),
    close: () => { if (options.reader === undefined) (reader as EdgeSupplyApi).close() },
  }
}
