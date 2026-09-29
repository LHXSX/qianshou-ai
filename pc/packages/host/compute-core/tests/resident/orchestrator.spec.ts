import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeError } from '../../src/errors.ts'
import { createIsolatedInlineRunner } from '../../src/resident/isolated-inline-runner.ts'
import {
  wordCountResultContract,
  type ResidentArtifactBytesReader,
  type ResidentVerificationOutcome,
} from '../../src/resident/verification.ts'
import {
  createResidentOrchestrator,
  mayReleaseOrchestratedResult,
  RESIDENT_ORCHESTRATION_DEFAULT_LIMITS,
  RESIDENT_ORCHESTRATION_FAILURE_CODES,
  RESIDENT_ORCHESTRATION_REASONS,
  RESIDENT_ORCHESTRATION_STEPS,
  type ResidentOrchestrationRequest,
  type ResidentOrchestrationResult,
  type ResidentOrchestrator,
  type ResidentOrchestratorCourier,
  type ResidentOrchestratorScout,
  type ResidentOrchestratorWorker,
  type ResidentWorkReceipt,
} from '../../src/resident/orchestrator.ts'

const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })

/** One fresh attempt workspace, removed after the case. */
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'resident-orchestrator-test-'))
  paths.push(path)
  return path
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const sizeOf = (text: string): number => Buffer.byteLength(text, 'utf8')
const claimOf = (text: string): ResidentWorkReceipt =>
  ({ reportedSuccess: true, bytes: sizeOf(text), sha256: digest(text) })

/** The document the real `word_count` runner produces (`isolated-inline-runner.ts`). */
async function legalWordCount(inlineInput: string): Promise<string> {
  return (await createIsolatedInlineRunner()({
    taskType: 'word_count', inlineInput, signal: new AbortController().signal,
  })).text
}

function request(taskId: string, workspacePath: string): ResidentOrchestrationRequest {
  return { taskId, attempt: 1, taskType: 'word_count', workspacePath, payload: { inlineInput: 'alpha beta alpha' } }
}

/** Scout double that recommends nothing and always allows the run. */
function allowingScout(overrides: Partial<Awaited<ReturnType<ResidentOrchestratorScout['scout']>>> = {}): ResidentOrchestratorScout {
  return {
    scout: async () => ({ canRun: true, reason: 'local runner present', recommendations: [], ...overrides }),
  }
}

/** Courier double that records everything it was handed and accepts it. */
function recordingCourier(): ResidentOrchestratorCourier & { deliver: ReturnType<typeof vi.fn> } {
  const deliver = vi.fn(async () => ({ accepted: true, reference: 'local-send-1' }))
  return { deliver } as unknown as ResidentOrchestratorCourier & { deliver: ReturnType<typeof vi.fn> }
}

/** Build one orchestrator whose only variable is the worker. */
function orchestratorWith(
  worker: ResidentOrchestratorWorker,
  extra: Partial<Parameters<typeof createResidentOrchestrator>[0]> = {},
): ResidentOrchestrator {
  return createResidentOrchestrator({
    scout: allowingScout(),
    worker,
    courier: recordingCourier(),
    contractFor: () => wordCountResultContract(),
    ...extra,
  })
}

/** Poll a condition on the real clock; used instead of fixed sleeps. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** A promise a test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Every trace must name all four roles, in order, whatever happened. */
function expectCompleteTrace(result: ResidentOrchestrationResult): void {
  expect(result.trace.map(step => step.id)).toEqual([...RESIDENT_ORCHESTRATION_STEPS])
  expect(result.unreached).toEqual(result.trace.filter(step => step.status === 'not-run').map(step => step.id))
  // 跑过的 + 没跑的 = 四个角色，各恰好一次 —— 缺一步这条就红。
  // 注意不假设"跑过的"一定是前 k 步：契约先于执行，Verifier 的契约查找可能先于 Worker。
  const reached = result.trace.filter(step => step.status !== 'not-run').map(step => step.id)
  const covered = [...reached, ...result.unreached]
  expect(covered.length).toBe(RESIDENT_ORCHESTRATION_STEPS.length)
  expect(new Set(covered).size).toBe(covered.length)
  expect([...covered].sort()).toEqual([...RESIDENT_ORCHESTRATION_STEPS].sort())
}

describe('W4 orchestrator · ④ 合法产物：四步全跑、逐段留痕、只在 Verifier 放行后回传', () => {
  it('真实 word_count 产物走完 Scout→Worker→Verifier→Courier，且 Courier 只拿到 passed 报告', async () => {
    const root = await workspace()
    const courier = recordingCourier()
    const orchestrator = createResidentOrchestrator({
      scout: allowingScout({ recommendations: [{ capabilityId: 'text.transform', available: true, note: 'word_count 内建' }] }),
      worker: {
        work: async ({ workspacePath, artifactName }) => {
          const text = await legalWordCount('alpha beta alpha gamma beta alpha')
          await writeFile(join(workspacePath, artifactName), text, 'utf8')
          return claimOf(text)
        },
      },
      courier,
      contractFor: () => wordCountResultContract(),
    })
    const result = await orchestrator.run(request('task-ok', root))

    expect(result.terminal).toBe('delivered')
    expect(result.disposition).toBe('settled')
    expect(result.reason).toBe(RESIDENT_ORCHESTRATION_REASONS.delivered)
    expect(result.delivered).toBe(true)
    // 单一闸门：交付与否只由 Verifier 的产物判定决定。
    expect(mayReleaseOrchestratedResult(result)).toBe(true)
    expect(result.delivered).toBe(mayReleaseOrchestratedResult(result))
    expect(result.verification?.outcome).toBe('passed')
    expect(result.trace.map(step => step.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(result.unreached).toEqual([])
    expectCompleteTrace(result)

    // Verifier 的判据是它自己读出来的字节，不是 Worker 的自报。
    const artifact = result.trace[2]?.artifact
    expect(artifact?.name).toBe('result.txt')
    expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.trace[2]?.verdict).toEqual({ outcome: 'passed', code: 'RESIDENT_VERIFICATION_PASSED' })
    expect(result.trace[2]?.artifact).toEqual(result.verification?.artifact)

    // Courier 只被喂过一次，且喂进去的是 passed 报告本身。
    expect(courier.deliver).toHaveBeenCalledTimes(1)
    expect(courier.deliver.mock.calls[0]?.[0].report.outcome).toBe('passed')
    expect(result.courier).toEqual({ accepted: true, reference: 'local-send-1' })

    // Scout 只出建议，没有任何声明/开闸入口被它碰到。
    expect(result.scout?.recommendations).toEqual([{ capabilityId: 'text.transform', available: true, note: 'word_count 内建' }])
    expect(result.trace[0]?.artifact).toBeNull()
    expect(result.trace[0]?.verdict).toBeNull()
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.trace)).toBe(true)
  })
})

describe('W4 orchestrator · ① Worker 自报成功但产物不合格 ⇒ 被 Verifier 拦下、不交付', () => {
  it('自报成功 + 给了 sha256，但盘上根本没有这个文件', async () => {
    const root = await workspace()
    const courier = recordingCourier()
    const result = await orchestratorWith(
      { work: async () => ({ reportedSuccess: true, bytes: 128, sha256: digest('never written') }) },
      { courier, contractFor: () => wordCountResultContract() },
    ).run(request('task-missing', root))

    expect(result.terminal).toBe('verifier-rejected')
    expect(result.disposition).toBe('terminal')
    expect(result.reason).toBe(RESIDENT_ORCHESTRATION_REASONS.verifierRejected)
    expect(result.delivered).toBe(false)
    expect(mayReleaseOrchestratedResult(result)).toBe(false)
    expect(result.verification?.outcome).toBe('failed')
    expect(result.verification?.code).toBe('RESIDENT_VERIFICATION_ARTIFACT_MISSING')
    expect(result.verification?.executorClaim.reportedSuccess).toBe(true)
    expect(courier.deliver).not.toHaveBeenCalled()
    expect(result.courier).toBeNull()
    expect(result.trace[1]?.status).toBe('ok')
    expect(result.trace[2]?.status).toBe('blocked')
    expect(result.trace[2]?.verdict).toEqual({ outcome: 'failed', code: 'RESIDENT_VERIFICATION_ARTIFACT_MISSING' })
    expectCompleteTrace(result)
    expect(result.unreached).toEqual(['courier'])
  })

  it('产物形状错（真实 N9 的 {counts,total}）⇒ 消费侧读器读不到 ⇒ 不交付', async () => {
    const root = await workspace()
    const courier = recordingCourier()
    const wrongShape = JSON.stringify({ counts: { alpha: 3, beta: 2, gamma: 1 }, total: 6 })
    const result = await orchestratorWith(
      {
        work: async ({ workspacePath, artifactName }) => {
          await writeFile(join(workspacePath, artifactName), wrongShape, 'utf8')
          return claimOf(wrongShape)
        },
      },
      { courier, contractFor: () => wordCountResultContract({ schema: null }) },
    ).run(request('task-wrong-shape', root))

    expect(result.verification?.outcome).toBe('failed')
    expect(result.verification?.code).toBe('RESIDENT_VERIFICATION_READER_NO_DELIVERABLE')
    expect(result.delivered).toBe(false)
    expect(courier.deliver).not.toHaveBeenCalled()
  })

  it('Worker 指认另一目录里的合格产物 ⇒ 校验者只读本次工作区 ⇒ 不交付', async () => {
    const root = await workspace()
    const other = await workspace()
    const text = await legalWordCount('alpha beta alpha')
    await writeFile(join(other, 'result.txt'), text, 'utf8')
    const courier = recordingCourier()
    const result = await orchestratorWith(
      {
        // 运行期多出来的 artifactPath 是注入尝试：编排器不把它当产物位置。
        work: async () => ({ ...claimOf(text), artifactPath: join(other, 'result.txt') }) as ResidentWorkReceipt,
      },
      { courier, contractFor: () => wordCountResultContract() },
    ).run(request('task-path-injection', root))

    expect(result.verification?.code).toBe('RESIDENT_VERIFICATION_ARTIFACT_MISSING')
    expect(result.delivered).toBe(false)
    expect(courier.deliver).not.toHaveBeenCalled()
  })
})

describe('W4 orchestrator · ② undetermined 不得等价于通过（反向回归闸）', () => {
  it('拿不到发出之前的基线 ⇒ undetermined ⇒ 终态 unknown，且不交付', async () => {
    const root = await workspace()
    const courier = recordingCourier()
    const unreadable: ResidentArtifactBytesReader = { read: async () => { throw new Error('EIO: i/o error') } }
    const result = await orchestratorWith(
      { work: async () => ({ reportedSuccess: true, bytes: 64, sha256: digest('anything') }) },
      { courier, artifactReader: unreadable, contractFor: () => wordCountResultContract() },
    ).run(request('task-no-baseline', root))

    expect(result.verification?.outcome).toBe('undetermined')
    expect(result.verification?.code).toBe('RESIDENT_VERIFICATION_NO_BASELINE')
    expect(result.terminal).toBe('verifier-undetermined')
    expect(result.disposition).toBe('unknown')
    expect(result.delivered).toBe(false)
    expect(mayReleaseOrchestratedResult(result)).toBe(false)
    expect(courier.deliver).not.toHaveBeenCalled()
    expectCompleteTrace(result)
  })

  it('消费侧读器自己崩掉 ⇒ undetermined ⇒ 终态 unknown，且不交付', async () => {
    const root = await workspace()
    const courier = recordingCourier()
    const result = await orchestratorWith(
      {
        work: async ({ workspacePath, artifactName }) => {
          const text = await legalWordCount('alpha beta alpha')
          await writeFile(join(workspacePath, artifactName), text, 'utf8')
          return claimOf(text)
        },
      },
      {
        courier,
        contractFor: () => wordCountResultContract({
          reader: { id: 'crashing-reader', read: () => { throw new TypeError('reader bug') } },
        }),
      },
    ).run(request('task-reader-crash', root))

    expect(result.verification?.code).toBe('RESIDENT_VERIFICATION_READER_INDETERMINATE')
    expect(result.terminal).toBe('verifier-undetermined')
    expect(result.delivered).toBe(false)
    expect(courier.deliver).not.toHaveBeenCalled()
  })

  it('终局闸门只对 passed 放行：伪造"终态已交付 + 非 passed 报告"也必须被拦住', async () => {
    const outcomes: readonly ResidentVerificationOutcome[] = ['passed', 'failed', 'undetermined', 'needs-human']
    expect(outcomes.map(outcome =>
      mayReleaseOrchestratedResult({ terminal: 'delivered', verification: { outcome } }),
    )).toEqual([true, false, false, false])
    // 没有报告 = 没有判据 = 不放行。
    expect(mayReleaseOrchestratedResult({ terminal: 'delivered', verification: null })).toBe(false)
    // 非 delivered 终态一律不放行。
    expect(([
      'scout-refused', 'scout-failed', 'worker-failed', 'verifier-rejected',
      'verifier-undetermined', 'verifier-needs-human', 'timed-out', 'courier-failed', 'internal-error',
    ] as const).map(terminal =>
      mayReleaseOrchestratedResult({ terminal, verification: { outcome: 'passed' } }),
    )).toEqual([false, false, false, false, false, false, false, false, false])
  })
})

describe('W4 orchestrator · ③ 角色抛错 ⇒ 明确终态，主流程存活', () => {
  it('Worker 抛 ComputeError ⇒ worker-failed/retryable，Courier 一次都没被调用', async () => {
    const root = await workspace()
    const courier = recordingCourier()
    const result = await orchestratorWith(
      { work: async () => { throw new ComputeError('EDGE_EXECUTION_FAILED', 500) } },
      { courier, contractFor: () => wordCountResultContract() },
    ).run(request('task-worker-throws', root))

    expect(result.terminal).toBe('worker-failed')
    expect(result.disposition).toBe('retryable')
    expect(result.reason).toBe(RESIDENT_ORCHESTRATION_REASONS.workerFailed)
    expect(result.delivered).toBe(false)
    expect(result.verification).toBeNull()
    expect(result.trace[1]?.status).toBe('failed')
    expect(result.trace[1]?.error).toEqual({ name: 'ComputeError', code: 'EDGE_EXECUTION_FAILED' })
    expect(result.trace[2]?.status).toBe('not-run')
    expect(courier.deliver).not.toHaveBeenCalled()
    expectCompleteTrace(result)
    expect(result.unreached).toEqual(['verifier', 'courier'])
  })

  it('Worker 抛错后同一个编排器仍能跑完下一单（主流程没崩）', async () => {
    const root = await workspace()
    const orchestrator = orchestratorWith({
      work: async ({ request: incoming, workspacePath, artifactName }) => {
        if (incoming.taskId === 'task-boom') throw new Error('worker exploded')
        const text = await legalWordCount('alpha beta alpha')
        await writeFile(join(workspacePath, artifactName), text, 'utf8')
        return claimOf(text)
      },
    })
    const failed = await orchestrator.run(request('task-boom', root))
    expect(failed.terminal).toBe('worker-failed')
    expect(failed.trace[1]?.error).toEqual({ name: 'Error', code: null })
    expect(orchestrator.capacity().running).toBe(0)

    const survived = await orchestrator.run(request('task-after-boom', root))
    expect(survived.terminal).toBe('delivered')
    expect(survived.delivered).toBe(true)
  })

  it('Scout 抛错 ⇒ scout-failed/unknown（不是成功，也不是把锅甩给 Worker）', async () => {
    const root = await workspace()
    const worker = { work: vi.fn(async () => claimOf('x')) }
    const courier = recordingCourier()
    const result = await createResidentOrchestrator({
      scout: { scout: async () => { throw new Error('probe exploded') } },
      worker,
      courier,
      contractFor: () => wordCountResultContract(),
    }).run(request('task-scout-throws', root))

    expect(result.terminal).toBe('scout-failed')
    expect(result.disposition).toBe('unknown')
    expect(result.delivered).toBe(false)
    expect(worker.work).not.toHaveBeenCalled()
    expect(courier.deliver).not.toHaveBeenCalled()
    expect(result.trace[0]?.status).toBe('failed')
    expectCompleteTrace(result)
  })

  it('Courier 抛错 ⇒ courier-failed/retryable，但"已过校验"这一事实仍留痕', async () => {
    const root = await workspace()
    const result = await orchestratorWith(
      {
        work: async ({ workspacePath, artifactName }) => {
          const text = await legalWordCount('alpha beta alpha')
          await writeFile(join(workspacePath, artifactName), text, 'utf8')
          return claimOf(text)
        },
      },
      {
        courier: { deliver: async () => { throw new ComputeError('COMPUTE_TRANSPORT_LOST', 502) } },
        contractFor: () => wordCountResultContract(),
      },
    ).run(request('task-courier-throws', root))

    expect(result.terminal).toBe('courier-failed')
    expect(result.disposition).toBe('retryable')
    expect(result.delivered).toBe(false)
    // 校验确实过了，但没过终局闸门 ⇒ 仍然不许说"交付"。
    expect(result.verification?.outcome).toBe('passed')
    expect(mayReleaseOrchestratedResult(result)).toBe(false)
    expect(result.trace[3]?.status).toBe('failed')
    expect(result.trace[3]?.error?.code).toBe('COMPUTE_TRANSPORT_LOST')
    expectCompleteTrace(result)
  })

  it('Scout 判"干不了" ⇒ 早拒：Worker / Verifier / Courier 一步都不跑', async () => {
    const root = await workspace()
    const worker = { work: vi.fn(async () => claimOf('x')) }
    const courier = recordingCourier()
    const result = await createResidentOrchestrator({
      scout: allowingScout({ canRun: false, reason: 'no local runner for task type' }),
      worker,
      courier,
      contractFor: () => wordCountResultContract(),
    }).run(request('task-refused', root))

    expect(result.terminal).toBe('scout-refused')
    expect(result.disposition).toBe('terminal')
    expect(result.reason).toBe(RESIDENT_ORCHESTRATION_REASONS.scoutRefused)
    expect(result.delivered).toBe(false)
    expect(worker.work).not.toHaveBeenCalled()
    expect(courier.deliver).not.toHaveBeenCalled()
    expect(result.trace.map(step => step.status)).toEqual(['blocked', 'not-run', 'not-run', 'not-run'])
    expectCompleteTrace(result)
  })

  it('拿不出产物契约 ⇒ 不许跑 Worker、不许交付（判为 needs-human）', async () => {
    const root = await workspace()
    const worker = { work: vi.fn(async () => claimOf('x')) }
    const result = await orchestratorWith(worker, { contractFor: () => null })
      .run(request('task-no-contract', root))

    expect(result.terminal).toBe('verifier-needs-human')
    expect(result.disposition).toBe('needs-human')
    expect(result.reason).toBe(RESIDENT_ORCHESTRATION_REASONS.contractMissing)
    expect(result.delivered).toBe(false)
    // 产物名由契约拥有 ⇒ 契约缺失时 Worker 无从下手，连跑都不许跑。
    expect(worker.work).not.toHaveBeenCalled()
    expectCompleteTrace(result)
  })
})

describe('W4 orchestrator · 时限与资源上限（默认保守，超限排队或拒绝）', () => {
  it('默认限度保守：单并发 / 有墙钟上限 / 队列有限', () => {
    expect(RESIDENT_ORCHESTRATION_DEFAULT_LIMITS.maxConcurrentTasks).toBe(1)
    expect(RESIDENT_ORCHESTRATION_DEFAULT_LIMITS.taskTimeoutMs).toBe(30_000)
    expect(RESIDENT_ORCHESTRATION_DEFAULT_LIMITS.maxQueueDepth).toBe(4)
  })

  it('非法限度 ⇒ 明确拒绝，不静默取默认值', () => {
    const build = (limits: Partial<typeof RESIDENT_ORCHESTRATION_DEFAULT_LIMITS>) =>
      createResidentOrchestrator({
        scout: allowingScout(), worker: { work: async () => claimOf('x') }, courier: recordingCourier(),
        contractFor: () => wordCountResultContract(), limits,
      })
    expect(() => build({ maxConcurrentTasks: 0 })).toThrow(RESIDENT_ORCHESTRATION_FAILURE_CODES.limitsInvalid)
    expect(() => build({ taskTimeoutMs: Number.NaN })).toThrow(RESIDENT_ORCHESTRATION_FAILURE_CODES.limitsInvalid)
    expect(() => build({ maxQueueDepth: -1 })).toThrow(RESIDENT_ORCHESTRATION_FAILURE_CODES.limitsInvalid)
  })

  it('非法请求 ⇒ 明确拒绝', async () => {
    const root = await workspace()
    const orchestrator = orchestratorWith({ work: async () => claimOf('x') })
    await expect(orchestrator.run({ ...request('', root) }))
      .rejects.toThrow(RESIDENT_ORCHESTRATION_FAILURE_CODES.requestInvalid)
    await expect(orchestrator.run({ ...request('task-bad-attempt', root), attempt: 0 }))
      .rejects.toThrow(RESIDENT_ORCHESTRATION_FAILURE_CODES.requestInvalid)
  })

  it('④ 并发上限生效：同时只跑一单，其余排队，且工人的并发峰值始终是 1', async () => {
    const roots = [await workspace(), await workspace(), await workspace()]
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const started: string[] = []
    let active = 0
    let peak = 0
    const orchestrator = orchestratorWith(
      {
        work: async ({ request: incoming, workspacePath, artifactName }) => {
          const index = started.push(incoming.taskId) - 1
          active += 1
          peak = Math.max(peak, active)
          await gates[index]?.promise
          const text = await legalWordCount('alpha beta alpha')
          await writeFile(join(workspacePath, artifactName), text, 'utf8')
          active -= 1
          return claimOf(text)
        },
      },
      { limits: { maxConcurrentTasks: 1, maxQueueDepth: 4, taskTimeoutMs: 5_000 } },
    )

    const first = orchestrator.run(request('task-1', roots[0]!))
    const second = orchestrator.run(request('task-2', roots[1]!))
    const third = orchestrator.run(request('task-3', roots[2]!))
    await until(() => started.length === 1)
    expect(orchestrator.capacity()).toEqual({ running: 1, queued: 2, maxConcurrentTasks: 1, maxQueueDepth: 4 })

    gates[0]?.resolve()
    await first
    await until(() => started.length === 2)
    gates[1]?.resolve()
    await second
    await until(() => started.length === 3)
    gates[2]?.resolve()
    expect((await third).terminal).toBe('delivered')

    expect(started).toEqual(['task-1', 'task-2', 'task-3'])
    expect(peak).toBe(1)
    expect(orchestrator.capacity()).toEqual({ running: 0, queued: 0, maxConcurrentTasks: 1, maxQueueDepth: 4 })
  })

  it('④ 队列满 ⇒ 明确拒绝（不是静默丢弃），已在队的单仍照跑', async () => {
    const roots = [await workspace(), await workspace(), await workspace()]
    const gates = [deferred<void>(), deferred<void>()]
    const started: string[] = []
    const orchestrator = orchestratorWith(
      {
        work: async ({ request: incoming, workspacePath, artifactName }) => {
          const index = started.push(incoming.taskId) - 1
          await gates[index]?.promise
          const text = await legalWordCount('alpha beta alpha')
          await writeFile(join(workspacePath, artifactName), text, 'utf8')
          return claimOf(text)
        },
      },
      { limits: { maxConcurrentTasks: 1, maxQueueDepth: 1, taskTimeoutMs: 5_000 } },
    )

    const first = orchestrator.run(request('task-a', roots[0]!))
    const second = orchestrator.run(request('task-b', roots[1]!))
    await until(() => started.length === 1)
    await expect(orchestrator.run(request('task-c', roots[2]!)))
      .rejects.toThrow(RESIDENT_ORCHESTRATION_FAILURE_CODES.queueFull)

    gates[0]?.resolve()
    expect((await first).terminal).toBe('delivered')
    await until(() => started.length === 2)
    gates[1]?.resolve()
    expect((await second).terminal).toBe('delivered')
    // 被拒的第三单从没进过 Worker：拒绝是明说，不是悄悄扔进队列又消失。
    expect(started).toEqual(['task-a', 'task-b'])
    expect(orchestrator.capacity().queued).toBe(0)
  })

  it('单任务墙钟上限 ⇒ timed-out/unknown，信号被 abort，槽位归还，主流程继续', async () => {
    const root = await workspace()
    let aborted = false
    const orchestrator = orchestratorWith(
      {
        work: async ({ request: incoming, signal }) => {
          if (incoming.taskId === 'task-hang') {
            signal.addEventListener('abort', () => { aborted = true })
            return await new Promise<never>(() => { /* 永不 settle：只能靠编排层的墙钟上限收敛 */ })
          }
          const text = await legalWordCount('alpha beta alpha')
          return claimOf(text)
        },
      },
      { limits: { maxConcurrentTasks: 1, maxQueueDepth: 1, taskTimeoutMs: 40 } },
    )
    const timedOut = await orchestrator.run(request('task-hang', root))

    expect(timedOut.terminal).toBe('timed-out')
    expect(timedOut.disposition).toBe('unknown')
    expect(timedOut.delivered).toBe(false)
    expect(timedOut.trace[1]?.status).toBe('unknown')
    expect(timedOut.trace[2]?.status).toBe('not-run')
    expect(aborted).toBe(true)
    expectCompleteTrace(timedOut)
    // 槽位必须归还：一个挂死的 Worker 不许把编排层锁死。
    expect(orchestrator.capacity()).toEqual({ running: 0, queued: 0, maxConcurrentTasks: 1, maxQueueDepth: 1 })
  })
})
