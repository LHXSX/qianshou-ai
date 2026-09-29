import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyResidentFailure } from '../../src/resident/failure.ts'
import { createInlineSessionConsumer } from '../../src/resident/inline-session-consumer.ts'
import { createIsolatedInlineRunner } from '../../src/resident/isolated-inline-runner.ts'
import type { ComputeResidentAttemptExecution, ComputeResidentWorkspace } from '../../src/resident/types.ts'
import {
  captureResidentVerificationBaseline,
  createVerifiedResultConsumer,
  mayDeliverResidentResult,
  RESIDENT_VERIFICATION_FAILURE_CODES,
  verifyResidentArtifact,
  wordCountResultContract,
  type ResidentArtifactBytesReader,
  type ResidentVerificationBaseline,
  type ResidentVerificationReport,
} from '../../src/resident/verification.ts'

const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
/** One fresh attempt workspace. */
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'resident-verification-test-'))
  paths.push(path)
  return path
}
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const claim = (text: string) => ({ reportedSuccess: true, bytes: Buffer.byteLength(text), sha256: digest(text) })
const referenceOf = (root: string) => ({ workspacePath: root, name: 'result.txt' })

/**
 * 取证流程：**先在产物出现之前采基线**，再把产物写进工作区。
 * 反过来做就只能验到 BASELINE_UNCHANGED，验不到后面的判据。
 */
async function stage(root: string, text: string): Promise<ResidentVerificationBaseline | null> {
  const baseline = await captureResidentVerificationBaseline({ reference: referenceOf(root) })
  await writeFile(join(root, 'result.txt'), text, 'utf8')
  return baseline
}

/** 取证：执行者真正会产出的合法文档（`isolated-inline-runner.ts` 的 `runWordCount`）。 */
async function legalWordCount(inlineInput: string): Promise<string> {
  return (await createIsolatedInlineRunner()({
    taskType: 'word_count', inlineInput, signal: new AbortController().signal,
  })).text
}

/** Minimal attempt execution; the verifier only reads the task identity, parameters and output ceiling. */
function attempt(workspacePath: string): {
  execution: ComputeResidentAttemptExecution
  workspace: ComputeResidentWorkspace
  signal: AbortSignal
} {
  return {
    execution: {
      task: { taskId: 'task-1', parameters: { taskType: 'word_count', inlineInput: 'alpha beta alpha' }, maxOutputBytes: 1 << 20 },
      attempt: { taskId: 'task-1', attempt: 1 },
      signal: new AbortController().signal,
      reportProgress: async () => {},
      source: { open: async () => { throw new Error('no input in this test') } },
      dataSource: null,
    } as unknown as ComputeResidentAttemptExecution,
    workspace: { path: workspacePath, outputs: [], close: async () => {} },
    signal: new AbortController().signal,
  }
}

describe('E5 verifier · ① 产物形状错必须被拦下', () => {
  it('拦下把 {counts,total} 当 result_lines 交付的产物（真实消费侧读器读不到）', async () => {
    const root = await workspace()
    // 这正是 N9 的两份实现之一：形状不同，读者拿到的是 null。
    const wrongShape = JSON.stringify({ counts: { alpha: 3, beta: 2, gamma: 1 }, total: 6 })
    const baseline = await stage(root, wrongShape)
    // 契约里故意不钉 schema：能拦下它的只能是"真实消费侧读器"这一条判据。
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract({ schema: null }),
      baseline,
      claim: claim(wrongShape),
    })
    expect(report.outcome).toBe('failed')
    expect(report.code).toBe('RESIDENT_VERIFICATION_READER_NO_DELIVERABLE')
    expect(mayDeliverResidentResult(report)).toBe(false)
  })

  it('契约钉了 schema 时按 schema 拦下，而不是靠读器兜底', async () => {
    const root = await workspace()
    const wrongShape = JSON.stringify({ counts: { alpha: 3 }, total: 3 })
    const baseline = await stage(root, wrongShape)
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract(),
      baseline,
      claim: claim(wrongShape),
    })
    expect(report.outcome).toBe('failed')
    expect(report.code).toBe('RESIDENT_VERIFICATION_SCHEMA_INVALID')
    expect(mayDeliverResidentResult(report)).toBe(false)
  })

  it('拦下形状合规但消费侧读不出交付物的产物（空 result_lines）', async () => {
    const root = await workspace()
    // 平台脚本对空输入就是 `result_lines: []`，而 `linesOf` 把空数组当"没有交付物"。
    const empty = await legalWordCount('   ')
    const baseline = await stage(root, empty)
    expect(JSON.parse(empty)).toMatchObject({ result_lines: [] })
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract({ schema: null }),
      baseline,
      claim: claim(empty),
    })
    expect(report.outcome).toBe('failed')
    expect(report.code).toBe('RESIDENT_VERIFICATION_READER_NO_DELIVERABLE')
  })
})

describe('E5 verifier · ② 执行者自报成功但产物不可读必须被拦下', () => {
  it('拦下"声称成功 + 给了 sha256，但盘上根本没有这个文件"', async () => {
    const root = await workspace()
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract(),
      baseline: await captureResidentVerificationBaseline({ reference: referenceOf(root) }),
      claim: { reportedSuccess: true, bytes: 128, sha256: digest('never written') },
    })
    expect(report.outcome).toBe('failed')
    expect(report.code).toBe('RESIDENT_VERIFICATION_ARTIFACT_MISSING')
    expect(report.artifact.sha256).toBeNull()
    expect(mayDeliverResidentResult(report)).toBe(false)
  })

  it('拦下声称的哈希与盘上实际字节不一致的产物', async () => {
    const root = await workspace()
    const text = await legalWordCount('alpha beta alpha')
    const baseline = await stage(root, text)
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract(),
      baseline,
      claim: { reportedSuccess: true, bytes: Buffer.byteLength(text), sha256: digest('something else') },
    })
    expect(report.outcome).toBe('failed')
    expect(report.code).toBe('RESIDENT_VERIFICATION_DIGEST_MISMATCH')
  })

  it('拦下"产物在尝试开始前就存在"的交付（拿旧文件冒充本次产物）', async () => {
    const root = await workspace()
    const text = await legalWordCount('alpha beta alpha')
    await writeFile(join(root, 'result.txt'), text, 'utf8')
    // 基线在产物已存在时采集：本次尝试并没有生产它。
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract(),
      baseline: await captureResidentVerificationBaseline({ reference: referenceOf(root) }),
      claim: claim(text),
    })
    expect(report.outcome).toBe('failed')
    expect(report.code).toBe('RESIDENT_VERIFICATION_BASELINE_UNCHANGED')
  })

  it('拦下执行者自报"没成功"却端出完美产物的回执', async () => {
    const root = await workspace()
    const text = await legalWordCount('alpha beta alpha')
    const baseline = await stage(root, text)
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract(),
      baseline,
      claim: { ...claim(text), reportedSuccess: false },
    })
    expect(report.outcome).toBe('failed')
    expect(report.code).toBe('RESIDENT_VERIFICATION_PRODUCER_REPORTED_FAILURE')
  })

  it('装饰器把"拦下"变成一次失败记录，而不是一次静默空交付', async () => {
    const root = await workspace()
    const onReport = vi.fn<(report: ResidentVerificationReport) => void>()
    const consumer = createVerifiedResultConsumer({
      contractFor: () => wordCountResultContract({ schema: null }),
      onReport,
      inner: {
        // 执行者只跑得出一份形状错的文档，却照着"成功"回签收。
        consume: async () => {
          const wrongShape = JSON.stringify({ counts: { alpha: 3 }, total: 3 })
          await writeFile(join(root, 'result.txt'), wrongShape, 'utf8')
          return { outputs: [{ name: 'result.txt', bytes: Buffer.byteLength(wrongShape), sha256: digest(wrongShape) }] }
        },
      },
    })
    const error = await consumer.consume(attempt(root)).then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(Error)
    expect((error as { code?: string }).code).toBe(RESIDENT_VERIFICATION_FAILURE_CODES.failed)
    expect(onReport).toHaveBeenCalledTimes(1)
    expect(onReport.mock.calls[0]?.[0].outcome).toBe('failed')
    expect(onReport.mock.calls[0]?.[0].code).toBe('RESIDENT_VERIFICATION_READER_NO_DELIVERABLE')
    // 关键：这条失败码走既有分类器时被记为 OUTPUT_INVALID/TERMINAL，不会被读成完成。
    expect(classifyResidentFailure(error, { transportLost: false, started: true })).toEqual({
      code: 'OUTPUT_INVALID', disposition: 'TERMINAL',
    })
  })

  it('装饰器拒绝"零产物"的成功回执', async () => {
    const root = await workspace()
    const consumer = createVerifiedResultConsumer({
      contractFor: () => wordCountResultContract(),
      inner: { consume: async () => ({ outputs: [] }) },
    })
    await expect(consumer.consume(attempt(root))).rejects.toThrow('COMPUTE_OUTPUT_VERIFICATION_NO_OUTPUT')
  })

  it('装饰器拒绝"没有契约"的回执（拿不出判据就不许交付）', async () => {
    const root = await workspace()
    const consumer = createVerifiedResultConsumer({
      contractFor: () => null,
      inner: { consume: async () => ({ outputs: [{ name: 'result.txt', bytes: 1, sha256: digest('x') }] }) },
    })
    await expect(consumer.consume(attempt(root))).rejects.toThrow('COMPUTE_OUTPUT_VERIFICATION_CONTRACT_MISSING')
  })
})

describe('E5 verifier · ③ 无法判定 ≠ 通过（反向回归闸）', () => {
  it('没有发出之前的基线时判为 undetermined，且不许交付', async () => {
    const root = await workspace()
    const text = await legalWordCount('alpha beta alpha')
    await writeFile(join(root, 'result.txt'), text, 'utf8')
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract(),
      baseline: null,
      claim: claim(text),
    })
    expect(report.outcome).toBe('undetermined')
    expect(report.code).toBe('RESIDENT_VERIFICATION_NO_BASELINE')
    // 反向回归闸：没有任何"读到了就算过"的检查被记成通过，且没跑的检查被逐条点名。
    expect(report.checks).toEqual([
      { id: 'reference', passed: true, detail: expect.any(String) },
      { id: 'contract', passed: true, detail: expect.any(String) },
      { id: 'producer-claim', passed: true, detail: expect.any(String) },
      { id: 'baseline', passed: false, detail: expect.any(String) },
    ])
    expect(report.unreached).toEqual(['readable', 'non-empty', 'digest', 'schema', 'consumer-reader'])
    expect(report.artifact.sha256).toBeNull()
    expect(mayDeliverResidentResult(report)).toBe(false)
  })

  it('产物读不开时判为 undetermined，不许被当成通过', async () => {
    const root = await workspace()
    const unreadable: ResidentArtifactBytesReader = {
      read: async () => { throw new Error('EACCES: permission denied') },
    }
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract(),
      baseline: { present: false, observedAt: new Date(0).toISOString() },
      claim: { reportedSuccess: true, bytes: 64, sha256: digest('anything') },
      artifactReader: unreadable,
    })
    expect(report.outcome).toBe('undetermined')
    expect(report.code).toBe('RESIDENT_VERIFICATION_ARTIFACT_UNREADABLE')
    expect(mayDeliverResidentResult(report)).toBe(false)
  })

  it('消费侧读器自己崩掉时判为 undetermined，不许被当成通过', async () => {
    const root = await workspace()
    const text = await legalWordCount('alpha beta alpha')
    const baseline = await stage(root, text)
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract({
        reader: { id: 'crashing-reader', read: () => { throw new TypeError('reader bug') } },
      }),
      baseline,
      claim: claim(text),
    })
    expect(report.outcome).toBe('undetermined')
    expect(report.code).toBe('RESIDENT_VERIFICATION_READER_INDETERMINATE')
    expect(mayDeliverResidentResult(report)).toBe(false)
  })

  it('没有登记消费侧读器时判为 needs-human，而不是放过', async () => {
    const root = await workspace()
    const text = await legalWordCount('alpha beta alpha')
    const baseline = await stage(root, text)
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract({ reader: null }),
      baseline,
      claim: claim(text),
    })
    expect(report.outcome).toBe('needs-human')
    expect(report.code).toBe('RESIDENT_VERIFICATION_READER_UNAVAILABLE')
    expect(mayDeliverResidentResult(report)).toBe(false)
  })

  it('闸门只对 passed 放行：其余三态一律 false', async () => {
    const text = await legalWordCount('alpha beta alpha')
    /** One case in its own workspace: baseline before the artifact, then the verdict. */
    const oneCase = async (
      contract = wordCountResultContract(),
      baselineMode: 'before' | 'none' | 'after' = 'before',
    ): Promise<ResidentVerificationReport> => {
      const root = await workspace()
      const reference = referenceOf(root)
      const baseline = baselineMode === 'none'
        ? null
        : baselineMode === 'after'
          ? (await writeFile(join(root, 'result.txt'), text, 'utf8'),
            await captureResidentVerificationBaseline({ reference }))
          : await stage(root, text)
      return verifyResidentArtifact({ reference, contract, baseline, claim: claim(text) })
    }
    const cases: readonly ResidentVerificationReport[] = [
      // 合法产物
      await oneCase(),
      // 产物在尝试前就存在（拿旧文件冒充）
      await oneCase(wordCountResultContract(), 'after'),
      // 没有发出之前的基线
      await oneCase(wordCountResultContract(), 'none'),
      // 没有登记消费侧读器
      await oneCase(wordCountResultContract({ reader: null })),
      // 契约本身不可评估：连判据都没有，交给人
      await oneCase(wordCountResultContract({ minBytes: 0 })),
    ]
    expect(cases.map(report => report.outcome))
      .toEqual(['passed', 'failed', 'undetermined', 'needs-human', 'needs-human'])
    expect(cases.filter(report => mayDeliverResidentResult(report)).length).toBe(1)
    // 终局判据：四态里只有 passed 能过闸。
    expect((['failed', 'undetermined', 'needs-human'] as const).map(outcome => mayDeliverResidentResult({ outcome })))
      .toEqual([false, false, false])
    expect(mayDeliverResidentResult({ outcome: 'passed' })).toBe(true)
  })
})

describe('E5 verifier · ④ 合法产物放行', () => {
  it('执行器自己产出的 word_count 文档通过，并被真实消费侧读器读成预期字段', async () => {
    const root = await workspace()
    const reference = referenceOf(root)
    // 基线必须在产物出现之前采集（发出之前的读数）。
    const baseline = await captureResidentVerificationBaseline({ reference })
    expect(baseline).toEqual({ present: false, observedAt: expect.any(String) })
    const text = await legalWordCount('alpha beta alpha gamma beta alpha')
    await writeFile(join(root, 'result.txt'), text, 'utf8')
    const report = await verifyResidentArtifact({
      reference,
      contract: wordCountResultContract(),
      baseline,
      // 执行者的"自报成功"只作证据，不作判据。
      claim: claim(text),
    })
    expect(report.outcome).toBe('passed')
    expect(report.code).toBe('RESIDENT_VERIFICATION_PASSED')
    expect(mayDeliverResidentResult(report)).toBe(true)
    expect(report.checks.every(check => check.passed)).toBe(true)
    expect(report.unreached).toEqual([])
    expect(report.artifact.sha256).toBe(digest(text))
    expect(report.artifact.bytes).toBe(Buffer.byteLength(text))
    expect(report.executorClaim).toEqual({ reportedSuccess: true, bytes: Buffer.byteLength(text), sha256: digest(text) })
    expect(report.consumer.readerId).toBe('developer-task-result')
    // 读器给出的交付物就是平台会逐行合并的那几行。
    expect(report.consumer.deliverable).toBe('alpha\t3\nbeta\t2\ngamma\t1')
    expect(report.consumer.fields).toContain('inlineOutput')
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.checks)).toBe(true)
  })

  it('真实 InlineSessionConsumer + 真实运行器整条路放行，且摘要由校验器自己算', async () => {
    const root = await workspace()
    const consumer = createVerifiedResultConsumer({
      contractFor: () => wordCountResultContract(),
      inner: createInlineSessionConsumer({
        run: createIsolatedInlineRunner(),
        rememberResult: () => { /* 本测试只关心产物本身 */ },
      }),
    })
    // 装饰器自己在 inner 运行前采基线；这里独立复采一次，作为同一结论的第二判据。
    const baseline = await captureResidentVerificationBaseline({ reference: referenceOf(root) })
    const receipt = await consumer.consume(attempt(root))
    expect(receipt.outputs).toEqual([
      { name: 'result.txt', bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    ])
    const report = await verifyResidentArtifact({
      reference: referenceOf(root),
      contract: wordCountResultContract(),
      baseline,
      claim: { reportedSuccess: true, bytes: receipt.outputs[0]?.bytes ?? null, sha256: receipt.outputs[0]?.sha256 ?? null },
    })
    expect(report.outcome).toBe('passed')
    expect(report.artifact.sha256).toBe(receipt.outputs[0]?.sha256)
    expect(report.consumer.deliverable).toBe('alpha\t2\nbeta\t1')
  })
})
