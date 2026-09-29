/**
 * 接头处的证明：CEO 模式的 seam **能不能真的替换 V1 的 builtin worker**，
 * 以及"LLM 自报成功"为什么**不**等于交付。
 *
 * 这里用**真**编排器（`resident/orchestrator.ts`）与**真**校验（`resident/verification.ts`）串起来，
 * 只把模型 transport 换成假件（铁律：不打真模型网络）。四条要证明的事：
 *
 * 1. `asWorkerSeam()` 能顶编排器的 Worker 角色：产物过 E5 校验 ⇒ 交付；
 * 2. `asRunnerSeam()` 能顶 V1 `order-agent.ts:290` 的那个 `runner` 注入点（形状逐行相容）；
 * 3. **不许自证**：模型说"我做完了"而产物不过契约 ⇒ 不交付、Courier 零次；
 * 4. 无凭据 ⇒ 精确码原样留在 `trace[worker].error.code` 里，
 *    `refusalFromOrchestrationTrace` 能把它取回来（否则会被吞成"通用执行失败"）。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIsolatedInlineRunner } from '../../src/resident/isolated-inline-runner.ts'
import {
  createResidentOrchestrator,
  mayReleaseOrchestratedResult,
  type ResidentOrchestrationRequest,
  type ResidentOrchestrationResult,
  type ResidentOrchestratorCourier,
  type ResidentOrchestratorScout,
  type ResidentOrchestratorWorker,
} from '../../src/resident/orchestrator.ts'
import { wordCountResultContract } from '../../src/resident/verification.ts'
import { createCeoLlmWorker, refusalFromOrchestrationTrace, type CeoToolBinding } from '../../src/order-agent/llm-worker.ts'
import { ORDER_AGENT_DEFAULT_BUDGET, ORDER_AGENT_REFUSAL_CODES } from '../../src/order-agent/owner-config.ts'
import { fakeEnvironment, finalText, scriptedTransport, toolCall, usage } from './ceo-fakes.ts'

/** 假环境里的凭据（用例里只用来证明它不外泄）。 */
const SECRET = 'sk-test-abcdefghijklmnop'
const ENV = Object.freeze({ QIANSHOU_MODEL_API_KEY: SECRET })
/** 任务文本（一次真实的内建 word_count 输入形状）。 */
const INLINE = 'apple banana apple 苹果 香蕉'
/** 契约要求的产物名（由契约拥有，不由模型决定）。 */
const ARTIFACT = 'result.txt'

const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
/** 一个干净的 attempt 工作区。 */
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ceo-seam-wiring-'))
  paths.push(path)
  return path
}

/** 内建 runner 的**产物形状**：只作为"什么算合格产物"的 oracle，不参与被测路径。 */
async function productOracle(taskType: string, inlineInput: string): Promise<string> {
  const { text } = await createIsolatedInlineRunner()({ taskType, inlineInput, signal: new AbortController().signal })
  return text
}

/** 只出建议的 scout（本工单不碰 Scout 端口）。 */
const scout: ResidentOrchestratorScout = {
  scout: async () => Object.freeze({ canRun: true, reason: 'test scout', recommendations: Object.freeze([]) }),
}

/** 记录交付次数的 Courier（本工单一行帧代码都没有，这里只统计"有没有交给它"）。 */
function courierSpy(): ResidentOrchestratorCourier & { readonly deliveries: () => number } {
  let deliveries = 0
  return {
    deliveries: () => deliveries,
    deliver: async () => { deliveries += 1; return Object.freeze({ accepted: true, reference: 'local-ref' }) },
  }
}

/** 编排器 + 真契约 + 真校验 + 被测的 Worker seam。 */
function orchestratorWith(worker: ResidentOrchestratorWorker, courier: ResidentOrchestratorCourier) {
  return createResidentOrchestrator({
    scout,
    worker,
    courier,
    contractFor: (request: ResidentOrchestrationRequest) => (request.taskType === 'word_count' ? wordCountResultContract() : null),
  })
}

/** 造一个 CEO worker（默认：假环境有凭据）。 */
function ceoWorker(options: Readonly<Record<string, unknown>>) {
  return createCeoLlmWorker({
    config: {
      mode: 'ceo',
      account: {
        provider: 'deepseek', model: 'deepseek-chat',
        credential: { kind: 'environment', variable: 'QIANSHOU_MODEL_API_KEY' },
        maxOutputTokens: 1024,
      },
      budget: { ...ORDER_AGENT_DEFAULT_BUDGET, maxModelCalls: 3, maxTotalTokens: 100_000, maxCostMicroUsd: 100_000 },
    },
    readCredential: fakeEnvironment(ENV),
    ...options,
  })
}

/** 跑一单并把结果与产物一起交回。 */
async function runOrder(
  orchestrator: ReturnType<typeof orchestratorWith>,
  root: string,
): Promise<{ readonly result: ResidentOrchestrationResult; readonly files: readonly string[] }> {
  const result = await orchestrator.run({ taskId: 'shard-1', attempt: 1, taskType: 'word_count', workspacePath: root, payload: { inlineInput: INLINE } })
  return { result, files: await readdir(root) }
}

describe('接头：CEO 的 Worker seam 顶替编排器的 Worker 角色', () => {
  it('模型给出的产物过 E5 契约 ⇒ 交付（唯一闸门放行，Courier 收到一次）', async () => {
    const oracle = await productOracle('word_count', INLINE)
    const scripted = scriptedTransport([finalText(oracle, usage(20, 40, 3))])
    const worker = ceoWorker({ transport: scripted.transport })
    const courier = courierSpy()
    const root = await workspace()

    const { result, files } = await runOrder(orchestratorWith(worker.asWorkerSeam(), courier), root)

    expect(result.terminal).toBe('delivered')
    expect(result.delivered).toBe(true)
    expect(mayReleaseOrchestratedResult(result)).toBe(true)
    expect(result.verification?.outcome).toBe('passed')
    expect(result.verification?.code).toBe('RESIDENT_VERIFICATION_PASSED')
    expect(courier.deliveries()).toBe(1)
    expect(files).toEqual([ARTIFACT])
    expect(scripted.calls()).toBe(1)
    // 四步都在：scout → worker → verifier → courier，没有未到达的步骤。
    expect(result.unreached).toEqual([])
    expect(result.trace.map(step => step.id)).toEqual(['scout', 'worker', 'verifier', 'courier'])
  })

  it('**不许自证**：模型自报"已完成/success: true"但产物不过契约 ⇒ 不交付、Courier 零次', async () => {
    const scripted = scriptedTransport([finalText('任务已完成 ✅ success: true，word_count 统计见附件（我没有真的产出文档）')])
    const worker = ceoWorker({ transport: scripted.transport })
    const courier = courierSpy()
    const root = await workspace()

    const { result, files } = await runOrder(orchestratorWith(worker.asWorkerSeam(), courier), root)

    expect(result.delivered).toBe(false)
    expect(mayReleaseOrchestratedResult(result)).toBe(false)
    expect(result.terminal).toBe('verifier-rejected')
    expect(result.verification?.code).toBe('RESIDENT_VERIFICATION_SCHEMA_INVALID')
    expect(courier.deliveries()).toBe(0)
    // worker 那一步是 ok（它只报 claim，claim 是真的：它确实写了这份字节）。
    expect(result.trace.find(step => step.id === 'worker')?.status).toBe('ok')
    // 产物躺在工作区里没人送出去：**声明**与**交付**之间隔着独立校验。
    expect(files).toEqual([ARTIFACT])
  })

  it('无凭据启用 ceo ⇒ 终态是 worker-failed，精确码留在 trace 里、Courier 零次、零产物', async () => {
    const scripted = scriptedTransport([finalText('不该被用到')])
    const worker = createCeoLlmWorker({ config: { mode: 'ceo', account: {
      provider: 'deepseek', model: 'deepseek-chat',
      credential: { kind: 'environment', variable: 'QIANSHOU_MODEL_API_KEY' },
      maxOutputTokens: 1024,
    } }, transport: scripted.transport, readCredential: fakeEnvironment({}) })
    const courier = courierSpy()
    const root = await workspace()

    const { result, files } = await runOrder(orchestratorWith(worker.asWorkerSeam(), courier), root)

    expect(result.terminal).toBe('worker-failed')
    expect(result.delivered).toBe(false)
    expect(courier.deliveries()).toBe(0)
    expect(files).toEqual([])
    expect(scripted.calls()).toBe(0)
    // 精确原因没有被吞成"通用执行失败"：接线方能从 trace 里把它读回来。
    const recovered = refusalFromOrchestrationTrace(result.trace)
    expect(recovered?.code).toBe(ORDER_AGENT_REFUSAL_CODES.modelCredentialsMissing)
    expect(result.trace.find(step => step.id === 'worker')?.error?.code).toBe(ORDER_AGENT_REFUSAL_CODES.modelCredentialsMissing)
  })

  it('refusalFromOrchestrationTrace 只认本模块的码：正常一单读回来是 null', async () => {
    const oracle = await productOracle('word_count', INLINE)
    const worker = ceoWorker({ transport: scriptedTransport([finalText(oracle)]).transport })
    const root = await workspace()
    const { result } = await runOrder(orchestratorWith(worker.asWorkerSeam(), courierSpy()), root)
    expect(result.terminal).toBe('delivered')
    expect(refusalFromOrchestrationTrace(result.trace)).toBeNull()
    expect(refusalFromOrchestrationTrace([{ id: 'worker', error: { name: 'ComputeError', code: 'SOME_OTHER_CODE' } }])).toBeNull()
  })
})

describe('接头：runner seam 能顶 V1 的 runner 注入点', () => {
  /**
   * **照 V1 `apps/qianshou-node/order-agent.ts:290-304` 的形状复刻**的 Worker 接线点：
   * 唯一改动是把 `runner` 换成 CEO 的 `asRunnerSeam()`。
   * 它存在的意义是"形状可替换"的证明，**不是**本工单改了 V1 的文件（一行都没改）。
   */
  const v1ShapedWorkerFor = (
    runner: (input: { taskType: string; inlineInput: string; signal: AbortSignal }) => Promise<{ text: string }>,
    offer: { readonly taskType: string; readonly inlineInput: string },
    artifactName: string,
    outer: AbortSignal,
  ): ResidentOrchestratorWorker => ({
    work: async (input) => {
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

  it('把 V1 的 runner 换成 asRunnerSeam()：一单真的走完并交付（形状逐行相容）', async () => {
    const oracle = await productOracle('word_count', INLINE)
    const worker = ceoWorker({ transport: scriptedTransport([finalText(oracle)]).transport })
    const courier = courierSpy()
    const root = await workspace()
    const handoff = v1ShapedWorkerFor(worker.asRunnerSeam(), { taskType: 'word_count', inlineInput: INLINE }, ARTIFACT, new AbortController().signal)

    const { result } = await runOrder(orchestratorWith(handoff, courier), root)

    expect(result.terminal).toBe('delivered')
    expect(courier.deliveries()).toBe(1)
    expect(worker.audit().length).toBeGreaterThan(0)
  })

  it('同一条 V1 形状下无凭据 ⇒ 精确码同样能被读回来（不是被吞成通用失败）', async () => {
    const worker = createCeoLlmWorker({
      config: { mode: 'ceo', account: {
        provider: 'deepseek', model: 'deepseek-chat',
        credential: { kind: 'environment', variable: 'QIANSHOU_MODEL_API_KEY' },
        maxOutputTokens: 1024,
      } },
      transport: scriptedTransport([finalText('不该被用到')]).transport,
      readCredential: fakeEnvironment({}),
    })
    const root = await workspace()
    const handoff = v1ShapedWorkerFor(worker.asRunnerSeam(), { taskType: 'word_count', inlineInput: INLINE }, ARTIFACT, new AbortController().signal)
    const { result } = await runOrder(orchestratorWith(handoff, courierSpy()), root)
    expect(result.terminal).toBe('worker-failed')
    expect(refusalFromOrchestrationTrace(result.trace)?.code).toBe(ORDER_AGENT_REFUSAL_CODES.modelCredentialsMissing)
  })

  it('白名单外工具请求在真编排器里也拦得住：工具零执行、产物零字节落地', async () => {
    let toolCalls = 0
    const binding: CeoToolBinding = { tool: 'fs.read', invoke: async () => { toolCalls += 1; return { ok: true, text: '不该发生' } } }
    const worker = ceoWorker({
      transport: scriptedTransport([toolCall('fs.read')]).transport,
      toolBindings: [binding],
    })
    const root = await workspace()
    const { result, files } = await runOrder(orchestratorWith(worker.asWorkerSeam(), courierSpy()), root)
    expect(result.terminal).toBe('worker-failed')
    expect(toolCalls).toBe(0)
    expect(files).toEqual([])
    expect(refusalFromOrchestrationTrace(result.trace)?.code).toBe(ORDER_AGENT_REFUSAL_CODES.toolNotAuthorized)
  })
})
