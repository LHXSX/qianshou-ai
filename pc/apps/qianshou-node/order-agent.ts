/**
 * 接单子代理（order acceptance agent）—— 本节点的**业务员**：接订单 → 做任务 → 回传。
 *
 * ⚠️ **本工单（V1）不启用模型调用。** 这个文件把"专职接单子代理"这个**位置**留出来，
 * 不是宣称节点今天已经会自己用 LLM 接单。CEO 模式（真 LLM 子代理）在本工单里是
 * **显式未实现**：主人一旦把它选上，这里**明确拒绝并留痕**，绝不静默回落到 builtin
 * （静默降级本身就是"静默即缺陷"，见 `千手PC算力节点-开发手册.md` 第 6 章）。
 *
 * ## 1. 职责
 *
 * 守护进程（`node-daemon.mts`）只干"插线板"的活：连上海 / 握手 / 心跳 / 收帧 / 发帧 /
 * 租约 / 状态面。**一条派单进来之后，接订单、做任务、回传这三件事全部由本模块负责**。
 * 内部的"做任务"不是单进程直接跑，而是走已入库的四角色编排器
 * （`packages/host/compute-core/src/resident/orchestrator.ts`，W4 交付）：
 *
 * ```
 * 派单 ──▶ 接单子代理（本文件）
 *            ├─ ① Scout   探测：本机能不能干；**只出建议**，无开闸权
 *            ├─ ② Worker  执行：在**调用方授权的**工作区里跑，只报 claim，不判定
 *            ├─ ③ Verifier 校验：自己读产物，按既有契约判定（`verification.ts`）
 *            └─ ④ Courier  回传：**唯一**分支 `mayDeliverResidentResult(report) === true`
 * ```
 *
 * ## 2. 权限来源：**只能是主人白名单**
 *
 * - 任务类型 = `OwnerCapabilityPolicy.authorizedTaskTypes`，**只来自主人的配置**（今天 = 守护进程
 *   的 `--task-types`，默认 `word_count`）。**绝不来自任务文本。**
 * - **任务文本按不可信输入处理**：`inlineInput` 只是一段要统计的**数据**，本模块从不把它当
 *   指令解析。本仓那条"挡注入的白名单"（`node-contributor/src/owner-policy.ts:75-78` +
 *   `tests/owner-policy-a2-guard.spec.ts`）是**意外护栏**，这里**显式登记并保留**，不当设计依据：
 *   它的存在意味着这条链路今天**没有任何工具面**，所以注入没有可调用的东西。
 * - **工具面为空**（{@link ORDER_ACCEPTANCE_TOOL_SURFACE}）：本工单不新增文件 / 网络 / 进程权限，
 *   不新增任务类型。有能红的注入口回归闸（`tests/order-agent.spec.ts`）。
 *
 * ## 3. 禁止项（结构上做不到，不是"不该"）
 *
 * - **不许判定自己成功**：Worker 只在回执里报 claim（`ResidentWorkReceipt`），判定权在 Verifier；
 *   本模块自己不写任何 `outcome`。
 * - **不许绕过 Courier**：回传只发生在编排器那一条分支上；本模块的 Courier seam 还会**再看一次**
 *   `mayDeliverResidentResult(report)`，非 `passed` 一律拒收。
 * - **不许自行扩权**：没有模型调用、没有工具注册表、不读环境里的凭据、不发任何帧。
 *
 * ## 4. 退化行为：**必须显式且留痕**
 *
 * | 情况 | 行为 |
 * |---|---|
 * | `capabilityMode: 'ceo'`（主人选了 CEO 模式） | 明确拒绝 `EDGE_ORDER_AGENT_MODE_UNIMPLEMENTED` + 轨迹一行；**不跑 Worker、不回落 builtin** |
 * | `capabilityMode` 是没见过的值 | 明确拒绝 `EDGE_ORDER_AGENT_POLICY_INVALID`（**不猜**、不取默认值） |
 * | 任务类型不在主人白名单 | 明确拒绝 `EDGE_ORDER_AGENT_TASK_NOT_AUTHORIZED`，Worker 从未启动 |
 * | 编排器拒绝（队列满 / 请求不可编排） | 上抛的 `ComputeError.code` 原样带出，不吞 |
 * | 没有产物契约 | 编排器判 `verifier-needs-human` ⇒ 拒绝（**没有判据就不交付**） |
 * | 送到 Courier 之前产物被改动 | 拒绝 `EDGE_ORDER_AGENT_ARTIFACT_CHANGED`（校验与回传之间不许换文件） |
 *
 * ## 5. 与线上帧的关系
 *
 * **本模块从不发帧。** 它只返回结构化结果（{@link OrderAcceptanceResult}）；把结果翻成
 * `shard_result` / `ok:false` 的**只有调用方**（`execute-offer.ts` 今天那几行）。这样"对外帧
 * 一个字节都不许变"这条铁律的**唯一决策点**就留在调用方，可逐行复核。
 */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ComputeError, createIsolatedInlineRunner, hasIsolatedInlineRunner } from '@deepseek-ai/dsh-compute-core'
import {
  createResidentOrchestrator,
  mayReleaseOrchestratedResult,
  RESIDENT_ORCHESTRATION_DEFAULT_LIMITS,
  RESIDENT_ORCHESTRATION_FAILURE_CODES,
  type ResidentOrchestrationLimits,
  type ResidentOrchestrationRequest,
  type ResidentOrchestrationResult,
  type ResidentOrchestrator,
  type ResidentOrchestratorCourier,
  type ResidentOrchestratorScout,
  type ResidentOrchestratorWorker,
  type ResidentScoutReport,
} from '@deepseek-ai/dsh-compute-core/resident/orchestrator.ts'
import {
  mayDeliverResidentResult,
  nodeArtifactBytesReader,
  wordCountResultContract,
  type ResidentArtifactBytesReader,
  type ResidentVerificationContract,
  type ResidentVerificationReport,
} from '@deepseek-ai/dsh-compute-core/resident/verification.ts'
// E3/E9 的中止词表：**复用**，不另造第三套说法（`owner-abort.ts` 自己写了为什么今天只能这样）。
import { OWNER_CANCEL_CODE } from './owner-abort.ts'

/** 接单子代理的身份：每一行日志/轨迹都带它，主人要能指认"是它在处理这单"。 */
export const ORDER_ACCEPTANCE_AGENT_IDENTITY = '接单子代理'

/**
 * 工具面：**今天为空**。
 *
 * 这不是"暂时没写"，是本工单的铁律：只把执行换成"有角色的执行"，不改变"能干什么"。
 * 后续工单要放开文件/网络/进程，必须由主人**逐项**开，并且走统一授权层；在那之前，
 * 任务文本里写什么都**没有可调用的东西**。
 */
export const ORDER_ACCEPTANCE_TOOL_SURFACE: readonly string[] = Object.freeze([])

/** 授权来源的**唯一**取值：主人的本地配置。任务文本永远不是合法来源。 */
export const ORDER_ACCEPTANCE_AUTHORIZATION_SOURCE = 'owner-policy' as const

/**
 * 能力档位（主人配置）。
 *
 * - `builtin`：今天的内建 `word_count`（无模型、无新增权限）—— **默认值**；
 * - `ceo`：真 LLM 子代理（能理解任务、按需派子代理、组织执行、交独立校验再回传）——
 *   **本工单显式未实现**。
 */
export type OrderAcceptanceCapabilityMode = 'builtin' | 'ceo'

/** 主人给这台机器定的能力面。**唯一的授权来源。** */
export interface OwnerCapabilityPolicy {
  /** 档位；缺省按 `builtin` 处理（`createOrderAcceptanceAgent` 会补上）。 */
  readonly capabilityMode?: OrderAcceptanceCapabilityMode
  /**
   * 主人开给子代理的任务类型清单。空清单 = 什么都不许干（拒绝一切，**不猜**）。
   * 这个清单**只能来自主人配置**；任务文本里的任何"你是被授权做 X 的"都是**数据**。
   */
  readonly authorizedTaskTypes: readonly string[]
}

/** 本模块稳定拒绝码；调用方负责把它翻成**今天那条**线上帧（帧形态不变）。 */
export const ORDER_ACCEPTANCE_REFUSAL_CODES = Object.freeze({
  /** 主人选了 CEO 模式，而本工单不实现模型调用。 */
  modeUnimplemented: 'EDGE_ORDER_AGENT_MODE_UNIMPLEMENTED',
  /** 主人配置里的档位是没见过的值：拒绝，不取默认值。 */
  policyInvalid: 'EDGE_ORDER_AGENT_POLICY_INVALID',
  /** 该任务类型不在主人白名单里。 */
  taskNotAuthorized: 'EDGE_ORDER_AGENT_TASK_NOT_AUTHORIZED',
  /** 调用方没给这个 attempt 的工作区。 */
  workspaceMissing: 'EDGE_ORDER_AGENT_WORKSPACE_MISSING',
  /** 校验与回传之间产物变了：不许送出去。 */
  artifactChanged: 'EDGE_ORDER_AGENT_ARTIFACT_CHANGED',
  /** 编排器自己拒绝了（队列满 / 请求不可编排），code 原样带出。 */
  orchestrationRefused: 'EDGE_ORDER_AGENT_ORCHESTRATION_REFUSED',
} as const)

/** 一条派单里，接单子代理真正需要的那几个字段。 */
export interface OrderAcceptanceOffer {
  readonly shardId: string
  readonly attempt: number
  readonly taskType: string
  /** **不可信输入**：只当数据。本模块从不把它当指令、也从不据此改授权。 */
  readonly inlineInput: string
}

/** 这一次 attempt 的本地事实，由调用方提供（谁开工作区谁负责清理）。 */
export interface OrderAcceptanceContext {
  /** 调用方**已经授权**的本次 attempt 工作区；`result.txt` 落在这里。 */
  readonly workspacePath: string
  /** 主人中止 / 连接取消：一路传到四个角色（E3/E9 的中止面继续生效）。 */
  readonly signal: AbortSignal
  /**
   * 这一单开始的时刻，必须是 {@link OrderAcceptanceAgentOptions.clock} 的一次读数
   * （缺省即 `Date.now`）。`elapsedMs` 用同一次时钟相减。传入 `performance.now()` 会得到墙上时刻那么大的耗时。
   */
  readonly startedAtMs: number
}

/**
 * Courier seam：把**已经过校验**的产物送出去。
 *
 * 由**调用方**注入 —— 线上那一跳今天就是 `connection.complete(offer, {inlineOutputUtf8, elapsedMs})`，
 * 因此"帧字节不变"由调用方那一行负责，本模块一行帧代码都没有。
 */
export interface OrderAcceptanceCourier {
  deliver(input: OrderAcceptanceCourierInput): Promise<{ readonly accepted: boolean; readonly reference: string | null }>
}

/** Courier seam 的入参：只有过了校验的产物才会走到这里。 */
export interface OrderAcceptanceCourierInput {
  readonly shardId: string
  readonly attempt: number
  readonly taskType: string
  /** 一定是 `outcome: 'passed'` 的报告（编排器唯一分支保证 + 本模块再确认一次）。 */
  readonly report: ResidentVerificationReport
  /** Verifier 实际读过的那个文件的绝对路径。 */
  readonly artifactPath: string
  /** 与 `report.artifact.sha256` 逐字节一致之后才给出的文本。 */
  readonly verifiedText: string
  readonly elapsedMs: number
  readonly signal: AbortSignal
}

/** 接单子代理跑完一单的结果；**调用方据此发帧**。 */
export interface OrderAcceptanceResult {
  readonly identity: string
  /** 是否真的把产物交给了 Courier（= `mayDeliverResidentResult` 那条分支走到了）。 */
  readonly delivered: boolean
  /** 拒绝时给出的**本模块**码与细节；`delivered: true` 时为 null。 */
  readonly refusal: { readonly code: string; readonly detail: string } | null
  /** 四步轨迹（含身份前缀），主人可读。 */
  readonly trace: readonly string[]
  /** 编排器的完整结果（含四步 trace、Verifier 报告），未起步时为 null。 */
  readonly orchestration: ResidentOrchestrationResult | null
}

/** 接单子代理。 */
export interface OrderAcceptanceAgent {
  readonly identity: string
  /** 当前档位；主人可读。 */
  capabilityMode(): OrderAcceptanceCapabilityMode | 'invalid'
  /** 处理一条派单：接订单 → 做任务 → 回传。**从不抛异常**（拒绝以结果形式返回）。 */
  handleOffer(offer: OrderAcceptanceOffer, context: OrderAcceptanceContext): Promise<OrderAcceptanceResult>
}

/** 造一个接单子代理。 */
export interface OrderAcceptanceAgentOptions {
  /** 主人白名单 + 档位。**唯一**授权来源。 */
  readonly policy: OwnerCapabilityPolicy
  /** Courier seam（调用方注入；本模块不发帧）。 */
  readonly courier: OrderAcceptanceCourier
  /**
   * Worker seam 的实现。缺省 = 本进程的内建 runner（`createIsolatedInlineRunner()`，
   * 今天只认 `word_count` / `text.transform`）。
   *
   * **CEO 模式将来就换这一个 seam**（注入 `isolated-agent` 那条 agent 会话），本工单不换：
   * `capabilityMode: 'ceo'` 在任何角色启动之前就被明确拒绝，所以这里**不可能**被喂进模型路径。
   */
  readonly runner?: (input: { taskType: string; inlineInput: string; signal: AbortSignal }) => Promise<{ text: string }>
  /**
   * Scout seam 的建议来源：调用方启动时探测到的本机名字（守护进程已有 `probeLocalSupply`）。
   * 缺省 `[]` —— 见 {@link createLocalScout} 的"暂无对应端口"说明。
   */
  readonly scoutSuggestions?: readonly string[]
  /** Verifier 读产物字节的来源；缺省读真实磁盘。测试用来驱动"读不开"。 */
  readonly artifactReader?: ResidentArtifactBytesReader
  /**
   * 产物契约查找；缺省 = `word_count` → `wordCountResultContract()`。
   * 返回 null 表示**没有判据**：编排器会判 `verifier-needs-human`，**不交付**（不假设一份契约）。
   */
  readonly contractFor?: (taskType: string) => ResidentVerificationContract | null
  /** 整单资源上限；缺省取编排器的保守默认（1 并发 / 30s / 队列 4）。 */
  readonly limits?: Partial<ResidentOrchestrationLimits>
  /** 轨迹出口（守护进程接到自己的 log 上；主人中止面 E9 也可只读消费）。 */
  readonly onTrace?: (line: string) => void
  /** 可注入时钟。 */
  readonly clock?: () => number
}

/** 契约查找：产物名由契约拥有，拿不出契约就不许跑 Worker。 */
function contractForRequest(taskType: string): ResidentVerificationContract | null {
  return hasIsolatedInlineRunner(taskType) ? wordCountResultContract() : null
}

/**
 * Scout seam：**今天没有对应端口。**
 *
 * 今天"能不能干"就是一句同步判断（`hasIsolatedInlineRunner`）+ 主人白名单，本机**没有**任何
 * "探测并产出建议清单"的端口。这里**不编造**一个探测角色：它如实把这两件事转成
 * `ResidentScoutReport`，建议清单直接用**调用方已经探测到的**名字（守护进程启动时那份
 * `probeLocalSupply` 的结果），自己不做任何新探测、不写声明、不开闸。
 * 真正的 Scout 端口属工单 8（能力声明管线）。
 * @param taskType - 派单里的任务类型。
 * @param suggestions - 调用方已探测到的本机名字；没有就给空数组。
 * @returns 一份只有"能不能干 + 建议"的报告，没有任何开闸入口。
 */
export function createLocalScout(taskType: string, suggestions: readonly string[]): ResidentOrchestratorScout {
  return {
    scout: async (): Promise<ResidentScoutReport> => Object.freeze({
      canRun: hasIsolatedInlineRunner(taskType),
      reason: hasIsolatedInlineRunner(taskType)
        ? 'in-process isolation runner is present for this task type'
        : 'no in-process isolation runner for this task type',
      recommendations: Object.freeze(suggestions.map(name => Object.freeze({
        capabilityId: name,
        available: true,
        note: '建议，仅供主人参考；本模块不改声明、不开闸（暂无探测端口）',
      }))),
    }),
  }
}

/**
 * 造一个接单子代理。
 *
 * 四个 seam 里 Worker / Courier 由调用方注入，Verifier 用已入库的 `verification.ts`
 * （**不另造第二套判据**），Scout 见 {@link createLocalScout}。
 * @param options - 主人白名单、Courier seam、可选 Worker 实现与上限。
 * @returns 一个 `handleOffer` 从不抛异常的接单子代理。
 */
export function createOrderAcceptanceAgent(options: OrderAcceptanceAgentOptions): OrderAcceptanceAgent {
  const clock = options.clock ?? Date.now
  const artifactReader = options.artifactReader ?? nodeArtifactBytesReader
  const runner = options.runner ?? createIsolatedInlineRunner()
  const suggestions = Object.freeze([...(options.scoutSuggestions ?? [])])
  const declaredMode = options.policy.capabilityMode ?? 'builtin'
  const authorized = Object.freeze([...options.policy.authorizedTaskTypes])

  /** Worker seam：在**调用方授权的**工作区里跑，写出产物，然后**只报 claim**。 */
  const workerFor = (offer: OrderAcceptanceOffer, artifactName: string, outer: AbortSignal): ResidentOrchestratorWorker => ({
    work: async (input) => {
      // 主人中止（E3/E9 那条 signal）与编排器自己的墙钟一起闸住这一步：中止要**真的停**，
      // 不是只改状态。编排器只认墙钟，所以外部 signal 必须在这里合并进去。
      const scoped = AbortSignal.any([input.signal, outer])
      const { text } = await runner({ taskType: offer.taskType, inlineInput: offer.inlineInput, signal: scoped })
      const bytes = Buffer.from(text, 'utf8')
      await writeFile(join(input.workspacePath, artifactName), text, { mode: 0o600, flag: 'wx' })
      return Object.freeze({
        reportedSuccess: true,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    },
  })

  /** Courier seam：**再看一次**闸门，然后核对"送的就是校验过的那份字节"。 */
  const courierSeam = (offer: OrderAcceptanceOffer, outer: AbortSignal): ResidentOrchestratorCourier => ({
    deliver: async (input) => {
      // 唯一闸门的本地副本：走到这里的报告必须是 passed（编排器只有那一条分支，这里不信运气）。
      if (!mayDeliverResidentResult(input.report)) return Object.freeze({ accepted: false, reference: null })
      const artifactPath = join(input.workspacePath, input.report.artifact.name)
      const bytes = await artifactReader.read(artifactPath)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (input.report.artifact.sha256 === null || sha256 !== input.report.artifact.sha256) {
        // 校验与回传之间产物变了：这是"送出去的东西不等于校验过的东西"，只能拒。
        return Object.freeze({ accepted: false, reference: null })
      }
      const elapsedMs = Math.max(0, Math.round(clock() - contextOfStartedAt(input.request.taskId)))
      return await options.courier.deliver({
        shardId: offer.shardId,
        attempt: offer.attempt,
        taskType: offer.taskType,
        report: input.report,
        artifactPath,
        // `artifactReader.read` 给的是 `Uint8Array`：`Uint8Array.prototype.toString` **忽略参数**，
        // 直接 `bytes.toString('utf8')` 会得到一串逗号分隔的十进制数字（已被用例抓到）。
        verifiedText: Buffer.from(bytes).toString('utf8'),
        elapsedMs,
        // 中止之后不许再起一次发送。
        signal: AbortSignal.any([input.signal, outer]),
      })
    },
  })

  // `elapsedMs` 需要"这一单什么时候开始的"，而 seam 只拿到 request：用一张只读的旁路账记着。
  const startedAtByTask = new Map<string, number>()
  const contextOfStartedAt = (taskId: string): number => startedAtByTask.get(taskId) ?? clock()

  return {
    identity: ORDER_ACCEPTANCE_AGENT_IDENTITY,
    capabilityMode: () => (declaredMode === 'builtin' || declaredMode === 'ceo' ? declaredMode : 'invalid'),
    handleOffer: async (offer, context) => {
      const lines: string[] = []
      const trace = (step: string, detail: string): void => {
        const line = `${ORDER_ACCEPTANCE_AGENT_IDENTITY} · ${step} · ${detail}`
        lines.push(line)
        try { options.onTrace?.(line) } catch { /* 可见性不许成为可用性的单点 */ }
      }
      const refuse = (code: string, detail: string): OrderAcceptanceResult => {
        trace('拒绝', `${code} · ${detail}`)
        return Object.freeze({
          identity: ORDER_ACCEPTANCE_AGENT_IDENTITY, delivered: false,
          refusal: Object.freeze({ code, detail }), trace: Object.freeze(lines), orchestration: null,
        })
      }

      trace('接单', `shard=${offer.shardId} attempt=${offer.attempt} task_type=${offer.taskType} 档位=${String(declaredMode)} 授权来源=${ORDER_ACCEPTANCE_AUTHORIZATION_SOURCE}`)

      // ── 闸① 档位：没见过的值、或 CEO 模式（本工单未实现）⇒ 明确拒绝，**不静默回落** ──
      if (declaredMode !== 'builtin' && declaredMode !== 'ceo') {
        return refuse(ORDER_ACCEPTANCE_REFUSAL_CODES.policyInvalid,
          `capabilityMode=${JSON.stringify(options.policy.capabilityMode)} is not a known mode; refusing instead of defaulting to builtin`)
      }
      if (declaredMode === 'ceo') {
        return refuse(ORDER_ACCEPTANCE_REFUSAL_CODES.modeUnimplemented,
          'CEO mode (a real LLM subagent) is not implemented in this work order; refusing instead of silently falling back to builtin')
      }

      // ── 闸② 授权：只读 offer.taskType 与主人白名单；任务文本一个字节都不参与 ──
      if (!authorized.includes(offer.taskType)) {
        return refuse(ORDER_ACCEPTANCE_REFUSAL_CODES.taskNotAuthorized,
          `task_type=${JSON.stringify(offer.taskType)} is not in the owner's whitelist (${JSON.stringify([...authorized])})`)
      }
      if (typeof context.workspacePath !== 'string' || context.workspacePath.length === 0) {
        return refuse(ORDER_ACCEPTANCE_REFUSAL_CODES.workspaceMissing, 'no attempt workspace was authorized by the caller')
      }
      if (ORDER_ACCEPTANCE_TOOL_SURFACE.length !== 0) {
        return refuse(ORDER_ACCEPTANCE_REFUSAL_CODES.policyInvalid, 'the tool surface must stay empty in this work order')
      }
      // 主人已经叫停：一条活都不起（E3/E9 的中止能力不许被接线破坏）。
      if (context.signal.aborted) {
        return refuse(OWNER_CANCEL_CODE, 'the owner canceled this order before the agent picked it up')
      }

      // ── 做任务：走已入库的四角色编排器（不在这里另造第二套管线） ──
      const contract = contractForRequest(offer.taskType)
      const artifactName = contract === null ? 'result.txt' : contract.artifactName
      // 编排器**每单新建**：四个 seam 闭包在这一单的 offer 上，绝不跨单复用（否则第二单会跑第一单的输入）。
      const orchestrator: ResidentOrchestrator = createResidentOrchestrator({
        scout: createLocalScout(offer.taskType, suggestions),
        worker: workerFor(offer, artifactName, context.signal),
        courier: courierSeam(offer, context.signal),
        contractFor: (request: ResidentOrchestrationRequest) => (options.contractFor ?? contractForRequest)(request.taskType),
        artifactReader,
        limits: { ...RESIDENT_ORCHESTRATION_DEFAULT_LIMITS, ...(options.limits ?? {}) },
        clock,
        onStep: (step) => {
          const verdict = step.verdict === null ? '' : ` outcome=${step.verdict.outcome} code=${step.verdict.code}`
          trace(step.id, `${step.status} · ${step.detail}${verdict}`)
        },
      })
      startedAtByTask.set(offer.shardId, context.startedAtMs)

      let result: ResidentOrchestrationResult
      try {
        result = await orchestrator.run({
          taskId: offer.shardId,
          attempt: offer.attempt,
          taskType: offer.taskType,
          workspacePath: context.workspacePath,
          // 任务文本原样带过去当**数据**（Worker 只把它当输入串，没有任何工具可调）。
          payload: { inlineInput: offer.inlineInput },
        })
      } catch (error) {
        const code = error instanceof ComputeError ? error.code : error instanceof Error ? error.name : 'non-error throw'
        const detail = error instanceof Error ? error.message.split('\n')[0] ?? '' : 'non-error throw'
        return refuse(code === RESIDENT_ORCHESTRATION_FAILURE_CODES.queueFull
          ? ORDER_ACCEPTANCE_REFUSAL_CODES.orchestrationRefused : code, detail)
      } finally {
        startedAtByTask.delete(offer.shardId)
      }

      // ── 回传：交付与否**只**看编排器那个闸门（本模块不另立判据） ──
      if (!mayReleaseOrchestratedResult(result) || result.verification === null) {
        const verifierCode = result.verification?.code ?? result.reason
        // 跑的过程里主人叫停了：这一单的码必须是**中止**，不是"失败"（否则会被当成可重试失败）。
        const canceled = context.signal.aborted
        return Object.freeze({
          identity: ORDER_ACCEPTANCE_AGENT_IDENTITY, delivered: false,
          refusal: Object.freeze({
            // Verifier 的码**原样带出**（绝不被吞成"通用执行失败"）；调用方决定线上码。
            code: canceled ? OWNER_CANCEL_CODE : verifierCode,
            detail: canceled
              ? `owner canceled this order during ${result.terminal}; nothing was delivered`
              : `${result.terminal} · ${result.reason} · not delivered`,
          }),
          trace: Object.freeze(lines), orchestration: result,
        })
      }
      trace('已回传', `${offer.shardId} · 四步走完 · Courier 收下（本地回执 ≠ 平台受理）`)
      return Object.freeze({
        identity: ORDER_ACCEPTANCE_AGENT_IDENTITY, delivered: true, refusal: null,
        trace: Object.freeze(lines), orchestration: result,
      })
    },
  }
}
