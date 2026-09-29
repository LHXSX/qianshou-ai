import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assignmentFingerprint,
  ComputeCapabilityId,
  ComputeTaskId,
  ComputeTaskStore,
} from '@deepseek-ai/dsh-compute-core'
import type { NodeTaskOfferMessage } from '@deepseek-ai/dsh-compute-core/node-protocol'
import { isResultAcceptanceObserved } from '@deepseek-ai/dsh-compute-core/edge-worker/polled-verification'
import { MemoryResidentConnector, MemoryResidentSession } from '@deepseek-ai/dsh-compute-core/transport/memory-session'
import type { ResidentSession, ResidentSessionConnector } from '@deepseek-ai/dsh-compute-core/resident'
import type { ResidentResultVerification } from '../src/edge-binding.ts'
import {
  createResidentAssembly,
  measuredFreeBytes,
  NODE_CONTRIBUTOR_FAILURES,
  productionGaps,
  type ResidentAssembly,
} from '../src/resident-assembly.ts'
import { resolvePolicy } from '../src/plugin.ts'

const DIGEST = 'd'.repeat(64)
const SECRET = 'assembly-test-secret'
const NODE_ID = 'node-assembly-1'
const AGENT_VERSION = 'agent-0.1.0'
const CAPABILITY_ID = 'word_count'
const receivedAt = '2026-09-17T04:00:00.000Z'
const expiresAt = '2026-09-17T04:10:00.000Z'
const issuedAt = '2026-09-17T04:00:00.000Z'
const deadlineAt = '2026-09-17T04:30:00.000Z'

const roots: string[] = []
const assemblies: ResidentAssembly[] = []

afterEach(async () => {
  await Promise.all(assemblies.splice(0).map(async (item) => {
    await item.runtime.stop('case teardown').catch(() => undefined)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function sign(fingerprint: string): string {
  return createHmac('sha256', SECRET).update(fingerprint).digest('base64')
}

function capability(available: boolean) {
  return Object.freeze({
    capabilityId: CAPABILITY_ID,
    version: '1.0.0',
    pluginDigest: DIGEST,
    dataScope: 'none' as const,
    maxInputBytes: 0,
    maxOutputBytes: 4096,
    available,
  })
}

function offer(taskId: string): NodeTaskOfferMessage {
  const envelope = {
    version: 'qianshou.task.v1' as const,
    taskId: ComputeTaskId(taskId),
    capabilityId: ComputeCapabilityId(CAPABILITY_ID),
    capabilityVersion: '1.0.0',
    inputRefs: [],
    parameters: { taskType: CAPABILITY_ID, inlineInput: 'hello', runtime: 'node' },
    deadlineAt,
    maxOutputBytes: 4096,
    idempotencyKey: `idem-${taskId}`,
  }
  const assignment = {
    envelope,
    attempt: 1,
    capabilityPluginDigest: DIGEST,
    leaseExpiresAt: expiresAt,
    receivedAt,
  }
  return {
    type: 'task.offer',
    envelope,
    attempt: 1,
    leaseExpiresAt: expiresAt,
    receivedAt,
    signature: sign(assignmentFingerprint(assignment)),
  }
}

function leaseOf(taskId: string, attempt: number, expires: string) {
  return {
    version: 'qianshou.node.lease.v1',
    leaseId: `lease-${taskId}-${attempt}`,
    taskId,
    attempt,
    ownerNodeId: NODE_ID,
    issuedAt,
    expiresAt: expires,
    idempotencyKey: `idem-${taskId}`,
    capabilityPluginDigest: DIGEST,
  }
}

/** 会发布核验结论的内存会话：真传输靠轮询，这里由用例显式驱动。 */
class ReportingSession extends MemoryResidentSession {
  private readonly handlers = new Set<(record: ResidentResultVerification) => void>()
  /** 下一条发出的结果对应的结论；真传输是自己轮询出来的。 */
  planned: ResidentResultVerification['verification'] | null = null
  onResultVerification(handler: (record: ResidentResultVerification) => void): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }
  /** 发布一条结论；真实传输在窗口关闭时调用它。 */
  report(recorded: ResidentResultVerification): void {
    for (const handler of [...this.handlers]) handler(recorded)
  }
  /** 订阅者数量；装配在 `connect` 时就会订阅，为 0 说明接线断了。 */
  get subscribers(): number { return this.handlers.size }
  override async sendReturn(message: Parameters<MemoryResidentSession['sendReturn']>[0]): Promise<void> {
    await super.sendReturn(message)
    const planned = this.planned
    if (planned === null) return
    this.planned = null
    // 形状与 `edge-binding.ts` 发布的记录一致；这里不借用 describe 里的 fixture 构造器。
    this.report({
      taskId: message.taskId, attempt: message.attempt, sent: 'sent-awaiting-verification',
      identity: planned.identity, verification: planned,
    })
  }
}

/** 只造会发布结论的会话；其余行为与内存一致性替身一致。 */
class ReportingConnector implements ResidentSessionConnector {
  readonly sessions: ReportingSession[] = []
  async connect(signal: AbortSignal): Promise<ResidentSession> {
    if (signal.aborted) throw new Error('aborted')
    const session = new ReportingSession()
    this.sessions.push(session)
    return session
  }
  latest(): ReportingSession {
    const session = this.sessions.at(-1)
    if (session === undefined) throw new Error('no reporting session was opened')
    return session
  }
}

async function assembly(options: {
  workspaceRoot?: string
  minDiskFreeBytes?: number
  maxConcurrency?: number
  allowWhileUserActive?: boolean
  hostActivity?: Parameters<typeof createResidentAssembly>[0]['hostActivity']
  voiceActivity?: Parameters<typeof createResidentAssembly>[0]['voiceActivity']
  resultConsumer?: Parameters<typeof createResidentAssembly>[0]['resultConsumer']
  inputSource?: Parameters<typeof createResidentAssembly>[0]['inputSource']
  capabilities?: Parameters<typeof createResidentAssembly>[0]['capabilities']
  /** Transport under test; defaults to the in-memory conformance double. */
  connector?: MemoryResidentConnector | ReportingConnector
} = {}): Promise<{ built: ResidentAssembly; connector: MemoryResidentConnector; store: ComputeTaskStore; root: string }> {
  const root = await scratch('qianshou-assembly-')
  const connector = options.connector ?? new MemoryResidentConnector()
  const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 8, maxBytes: 65_536 })
  const built = createResidentAssembly({
    nodeId: NODE_ID,
    agentVersion: AGENT_VERSION,
    policy: resolvePolicy({
      mode: 'BACKGROUND_ONLY',
      maxConcurrency: options.maxConcurrency ?? 1,
      minDiskFreeBytes: options.minDiskFreeBytes ?? 1_000,
      ...(options.allowWhileUserActive === undefined ? {} : { allowWhileUserActive: options.allowWhileUserActive }),
    }),
    store,
    verifySignature: async (fingerprint, signature) => signature === sign(fingerprint),
    leaseOf,
    connector,
    transport: 'memory',
    ...(options.hostActivity === undefined ? {} : { hostActivity: options.hostActivity }),
    ...(options.voiceActivity === undefined ? {} : { voiceActivity: options.voiceActivity }),
    capabilities: options.capabilities ?? (() => [
      capability(true),
      Object.freeze({ ...capability(false), capabilityId: 'offline_type', available: false }),
    ]),
    clock: () => Date.parse(receivedAt),
    stopTimeoutMs: 1_000,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    ...(options.resultConsumer === undefined ? {} : { resultConsumer: options.resultConsumer }),
    ...(options.inputSource === undefined ? {} : { inputSource: options.inputSource }),
  })
  assemblies.push(built)
  return { built, connector: connector as MemoryResidentConnector, store, root }
}

describe('resident assembly production seams', () => {
  it('sends one heartbeat capability when multiple reviewed adapters implement the same version', async () => {
    const { built, connector } = await assembly({
      capabilities: () => [capability(true), { ...capability(true), pluginDigest: 'b'.repeat(64) }],
    })
    await built.runtime.start()
    await built.tick()
    const frames = (connector.latest() as MemoryResidentSession).heartbeatFrames()
    expect(frames.at(-1)?.capabilities).toEqual([{
      capabilityId: ComputeCapabilityId(CAPABILITY_ID),
      version: '1.0.0',
      pluginDigest: DIGEST,
    }])
  })

  it('uses tightened runtime concurrency in heartbeat and admission while existing work drains', { timeout: 30_000 }, async () => {
    let release!: () => void
    const running = new Promise<void>((resolve) => { release = resolve })
    const root = await scratch('qianshou-owner-concurrency-')
    const { built, connector } = await assembly({
      workspaceRoot: join(root, 'attempts'), maxConcurrency: 4,
      resultConsumer: { consume: async () => { await running; return { outputs: [] } } },
    })
    try {
      built.runtime.setPolicy({ ...built.runtime.policy(), maxConcurrency: 2 })
      await built.runtime.start()
      const session = connector.latest() as MemoryResidentSession
      await built.tick()
      expect(session.heartbeatFrames().at(-1)?.maxConcurrency).toBe(2)
      await session.push(offer('owner-concurrency-one'))
      await session.push(offer('owner-concurrency-two'))
      await session.push(offer('owner-concurrency-three'))
      const tick = await built.tick()
      expect(tick.outcomes.filter(outcome => outcome.accepted)).toHaveLength(2)
      expect(built.runtime.inFlightCount()).toBe(2)
      built.runtime.setPolicy({ ...built.runtime.policy(), mode: 'OFF', maxConcurrency: 1 })
      await session.push(offer('owner-concurrency-after-lowering'))
      const lowered = await built.tick()
      expect(lowered.outcomes.every(outcome => !outcome.accepted)).toBe(true)
      expect(session.heartbeatFrames().at(-1)?.maxConcurrency).toBe(2)
      expect(session.heartbeatFrames().at(-1)?.capabilities).toEqual([])
      expect(built.runtime.inFlightCount()).toBe(2)
    } finally { release() }
    await expect.poll(() => built.runtime.inFlightCount()).toBe(0)
    await built.tick()
    expect((connector.latest() as MemoryResidentSession).heartbeatFrames().at(-1)?.maxConcurrency).toBe(1)
  })

  it('names every missing deployment seam in a stable order', () => {
    expect(productionGaps({})).toEqual([
      'workspaceRoot', 'transport', 'dispatchVerifier', 'dispatchLeaseSource', 'resultTransfer',
    ])
    expect(productionGaps({
      workspaceRoot: '/tmp/attempts',
      connector: new MemoryResidentConnector(),
      dispatchBound: true,
      resultBound: true,
    })).toEqual([])
    expect(measuredFreeBytes(10, 4_096)).toBe(40_960)
    expect(measuredFreeBytes(Number.MAX_SAFE_INTEGER, 4_096)).toBe(0)
    expect(measuredFreeBytes(-1, 4_096)).toBe(0)
  })

  it('rejects a relative or NUL workspace root and an invalid input ceiling', async () => {
    const root = await scratch('qianshou-assembly-invalid-')
    const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 8, maxBytes: 65_536 })
    const base = {
      nodeId: NODE_ID,
      agentVersion: AGENT_VERSION,
      policy: resolvePolicy({ mode: 'OFF' }),
      store,
      verifySignature: async () => false,
      leaseOf: () => { throw new Error('unused') },
    }
    expect(() => createResidentAssembly({ ...base, workspaceRoot: 'relative' }))
      .toThrow('COMPUTE_WORKSPACE_CONFIG_INVALID')
    expect(() => createResidentAssembly({ ...base, workspaceRoot: `${root}\0x` }))
      .toThrow('COMPUTE_WORKSPACE_CONFIG_INVALID')
    expect(() => createResidentAssembly({ ...base, workspaceRoot: root, maxInputBytes: -1 }))
      .toThrow('COMPUTE_WORKSPACE_CONFIG_INVALID')
  })

  it('advertises only available capabilities on a heartbeat and refuses work without a workspace', { timeout: 60_000 }, async () => {
    const { built, connector } = await assembly({ minDiskFreeBytes: 0 })
    await built.runtime.start()
    const tick = await built.tick()
    expect(tick.sentHeartbeat).toBe(true)
    const session = connector.latest() as MemoryResidentSession
    const heartbeat = session.heartbeatFrames().at(-1)
    expect(heartbeat?.capabilities).toEqual([{
      capabilityId: ComputeCapabilityId(CAPABILITY_ID),
      version: '1.0.0',
      pluginDigest: DIGEST,
    }])
    await session.push(offer('task-no-workspace'))
    const admitted = await built.tick()
    expect(admitted.outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => built.status().inFlight, { timeout: 5_000 }).toBe(0)
    expect(built.status().lastOutcome?.outcomes[0]?.accepted).toBe(true)
  })

  it('stages an empty-input workspace then refuses transfer when no consumer is bound', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-assembly-workspace-')
    const attempts = join(root, 'attempts')
    const { built, connector } = await assembly({ workspaceRoot: attempts })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest() as MemoryResidentSession
    await session.push(offer('task-no-transfer'))
    const admitted = await built.tick()
    expect(admitted.outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => built.status().inFlight, { timeout: 5_000 }).toBe(0)
    expect(NODE_CONTRIBUTOR_FAILURES.resultTransferUnavailable).toBe('COMPUTE_NODE_CONTRIBUTOR_RESULT_TRANSFER_UNAVAILABLE')
    expect(NODE_CONTRIBUTOR_FAILURES.workspaceUnavailable).toBe('COMPUTE_NODE_CONTRIBUTOR_WORKSPACE_UNAVAILABLE')
  })

  it('writes remembered outputs when a result consumer is supplied', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-assembly-result-')
    const { built, connector } = await assembly({
      workspaceRoot: join(root, 'attempts'),
      resultConsumer: {
        consume: async () => ({
          outputs: Object.freeze([{ name: 'result.txt', bytes: 5, sha256: 'a'.repeat(64) }]),
        }),
      },
    })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest() as MemoryResidentSession
    await session.push(offer('task-with-result'))
    const admitted = await built.tick()
    expect(admitted.outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => session.returnFrames().length, { timeout: 5_000 }).toBe(1)
    expect(session.returnFrames()[0]?.outputs[0]?.name).toBe('result.txt')
  })

  it('stages an exact file input through the injected Host reader before the result consumer', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-assembly-input-')
    const bytes = Buffer.from('versioned-first-frame')
    const input = { name: 'first_frame', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }
    const ordinary = offer('task-with-input')
    const envelope = { ...ordinary.envelope, inputRefs: [input] }
    const fileOffer: NodeTaskOfferMessage = { ...ordinary, envelope,
      signature: sign(assignmentFingerprint({ envelope, attempt: 1,
        capabilityPluginDigest: DIGEST, leaseExpiresAt: expiresAt, receivedAt })) }
    const opened: string[] = []
    const { built, connector } = await assembly({ workspaceRoot: join(root, 'attempts'),
      capabilities: () => [{ ...capability(true), dataScope: 'task-inputs', maxInputBytes: 1024 }],
      inputSource: { open: async (execution, task, requested) => {
        expect(execution.attempt.taskId).toBe(ordinary.envelope.taskId)
        expect(task.inputRefs).toEqual([input])
        expect(requested).toEqual(input)
        opened.push(requested.name)
        return new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(bytes); controller.close()
        } })
      } },
      resultConsumer: { consume: async ({ workspace }) => {
        expect(await readFile(join(workspace.path, 'input-0'))).toEqual(bytes)
        return { outputs: [{ name: 'result.txt', bytes: 1, sha256: 'a'.repeat(64) }] }
      } },
    })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest() as MemoryResidentSession
    await session.push(fileOffer)
    const admitted = await built.tick()
    expect(admitted.outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => session.returnFrames().length, { timeout: 5_000 }).toBe(1)
    expect(opened).toEqual(['first_frame'])
  })
})

/**
 * AT-10：`allowWhileUserActive` 以前判在两个常量 `false` 上，`USER_ACTIVE` 分支永不可达。
 * 这三条钉住"真实读数生效 / 未知不假装 / 未知要看得见"。
 */
describe('host activity drives admission and is reported honestly', () => {
  const activePort = { read: async () => ({ userActive: true, idleSeconds: 3, unavailable: null }) }
  const idlePort = { read: async () => ({ userActive: false, idleSeconds: 3_600, unavailable: null }) }
  const unknownPort = { read: async () => ({ userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_UNSUPPORTED' }) }

  it('refuses work while the owner is active unless the policy allows it', async () => {
    const strict = await assembly({ minDiskFreeBytes: 0, allowWhileUserActive: false, hostActivity: activePort })
    await strict.built.runtime.start()
    await strict.built.tick()
    await (strict.connector.latest() as MemoryResidentSession).push(offer('task-user-active'))
    const refused = await strict.built.tick()
    // 具体拒绝码在 `refusal` 上（`reason` 是粗分类）。
    expect(refused.outcomes[0]).toMatchObject({ accepted: false, refusal: 'USER_ACTIVE' })
    expect(strict.built.status().hostActivity).toMatchObject({ userActive: true, measured: true, policyEnforceable: true })

    // 同一情形、只把策略打开 ⇒ 判定必须不同（"策略生效"的可观察证据）。
    const relaxed = await assembly({ minDiskFreeBytes: 0, allowWhileUserActive: true, hostActivity: activePort })
    await relaxed.built.runtime.start()
    await relaxed.built.tick()
    await (relaxed.connector.latest() as MemoryResidentSession).push(offer('task-user-active-allowed'))
    const admitted = await relaxed.built.tick()
    expect(admitted.outcomes[0]).toMatchObject({ accepted: true })
  })

  it('treats an idle owner as available', async () => {
    const built = await assembly({ minDiskFreeBytes: 0, allowWhileUserActive: false, hostActivity: idlePort })
    await built.built.runtime.start()
    await built.built.tick()
    await (built.connector.latest() as MemoryResidentSession).push(offer('task-idle'))
    expect((await built.built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    expect(built.built.status().hostActivity).toMatchObject({ userActive: false, idleSeconds: 3_600 })
  })

  it('lets work through when activity cannot be measured, and says so instead of staying silent', async () => {
    const built = await assembly({ minDiskFreeBytes: 0, allowWhileUserActive: false, hostActivity: unknownPort })
    await built.built.runtime.start()
    await built.built.tick()
    await (built.connector.latest() as MemoryResidentSession).push(offer('task-unknown-activity'))
    // 未知 ⇒ 放行（CEO 决定：不给"测不到活动的平台"关门）。
    expect((await built.built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    // 但必须不静默：状态里如实写着"测不到"，并标明策略在本机没有依据。
    expect(built.built.status().hostActivity).toEqual({
      userActive: null, idleSeconds: null, voiceActive: null, measured: true,
      unavailable: 'IDLE_PROBE_UNSUPPORTED', policyEnforceable: false,
    })
  })

  it('reports an unbound activity port as a gap rather than as an idle machine', async () => {
    const built = await assembly({ minDiskFreeBytes: 0, allowWhileUserActive: false })
    await built.built.runtime.start()
    await built.built.tick()
    await (built.connector.latest() as MemoryResidentSession).push(offer('task-no-activity-port'))
    expect((await built.built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    expect(built.built.status().hostActivity).toMatchObject({
      userActive: null, measured: false, unavailable: 'ACTIVITY_PORT_UNBOUND', policyEnforceable: false,
    })
  })
})

/**
 * N5（C7 断点）·回传产物：`resident-assembly.ts` 的 workspace `outputs` 恒为 `[]`。
 *
 * 审计结论写进测试而不是只写进报告，因为"把它改成非空"是最容易被顺手做错的修法：
 * 该 seam 在 `createWorkspace(execution)` 时**执行还没开始**（`runtime.ts:461` 早于 `:465`
 * 的 `consume`），所以任何非空值都只能是编造的。下面三条把真实事实钉住：
 *
 * - 产物确实存在，而且**确实**被送上了 `task.return`（走 receipt，不经过 `workspace.outputs`）；
 * - `workspace.outputs` 在这个装配形态下恒为 `[]`，且**没有任何生产读者**；
 * - 没有产物时不允许出现任何伪造条目；没有传输时连帧都不许发。
 */
describe('N5 return-side artifacts: the receipt carries them, workspace.outputs does not', () => {
  /** One attempt's observed artifact facts, captured inside the consumer. */
  interface ArtifactProbe {
    path: string
    onDisk: string
    workspaceOutputs: readonly { name: string; path: string; bytes: number; sha256: string }[]
  }

  it('delivers a real output on task.return while workspace.outputs stays empty', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-n5-artifacts-')
    const probes: ArtifactProbe[] = []
    const { built, connector } = await assembly({
      workspaceRoot: join(root, 'attempts'),
      minDiskFreeBytes: 0,
      resultConsumer: {
        consume: async ({ workspace }) => {
          // 与 Edge inline 消费者同形：产物由消费侧写进 workspace.path。
          await writeFile(join(workspace.path, 'result.txt'), 'hello', 'utf8')
          // `workspace.close()` 在 consume 返回后立刻删目录（runtime.ts:467-469），
          // 所以这里当场把落盘事实读回来。
          probes.push({
            path: workspace.path,
            onDisk: await readFile(join(workspace.path, 'result.txt'), 'utf8'),
            workspaceOutputs: workspace.outputs,
          })
          return { outputs: Object.freeze([{ name: 'result.txt', bytes: 5, sha256: sha256('hello') }]) }
        },
      },
    })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest() as MemoryResidentSession
    await session.push(offer('task-n5-delivers'))
    expect((await built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)

    // ① 产物真的产出了：消费侧拿到的是一个真实、可读写的目录。
    expect(probes).toHaveLength(1)
    expect(probes[0]!.onDisk).toBe('hello')
    expect(probes[0]!.path.startsWith(await realpath(join(root, 'attempts')))).toBe(true)

    // ② "有产物时 outputs 非空且可被消费侧读出"：读的是回传帧的 outputs，不是 workspace.outputs。
    expect(session.returnFrames()[0]?.outputs).toEqual([{ name: 'result.txt', bytes: 5, sha256: sha256('hello') }])

    // ③ 断点事实本身：workspace.outputs 恒为 [] —— 本装配把执行放在 result consumer 里，
    //    而该字段只在 `createWorkspace` 阶段产生，此时还没有产物。钉住它，防止有人
    //    为了"消灭 []"而在此处编造条目（那会让节点声称上报了它并没有的东西）。
    expect(probes[0]!.workspaceOutputs).toHaveLength(0)
  })

  it('never invents an output entry when the attempt produced none', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-n5-empty-')
    const { built, connector } = await assembly({
      workspaceRoot: join(root, 'attempts'),
      minDiskFreeBytes: 0,
      // 诚实消费侧：什么也没写，就报"零产物"。
      resultConsumer: { consume: async () => ({ outputs: Object.freeze([]) }) },
    })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest() as MemoryResidentSession
    await session.push(offer('task-n5-empty'))
    expect((await built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)

    // 报的是**空的**，而不是从 workspace 或磁盘上"补"一个条目出来。
    expect(session.returnFrames()[0]?.outputs).toEqual([])
  })

  it('sends no return frame at all when no result consumer is bound', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-n5-noframe-')
    const { built, connector } = await assembly({ workspaceRoot: join(root, 'attempts'), minDiskFreeBytes: 0 })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest() as MemoryResidentSession
    await session.push(offer('task-n5-no-frame'))
    expect((await built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => built.status().inFlight, { timeout: 10_000 }).toBe(0)

    // 缺传输就必须一个字都不回：不允许出现 outputs 为空或伪造的 task.return。
    expect(session.returnFrames()).toEqual([])
  })

  /**
   * 误用陷阱本身也要可见（对应 `ComputeResidentWorkspaceOutputs` 的 doc）。
   *
   * `ComputeResidentWorkspace.outputs` 在类型上已标记为 **NOT WIRED / 无生产读者**。
   * 这条测试把"误用会长什么样"钉成可执行事实：把 harness 那种直通消费者
   * （`{ outputs: workspace.outputs }`）绑到**本装配**上，回传帧只会带零产物 ——
   * 因为本装配的 workspace provider 不拥有执行，而执行在 result consumer 里。
   *
   * 若将来该字段被删掉、或被赋予真正的线上通道，这条测试**必须**随之改写：
   * 它记录的是"当前形态下这个陷阱存在且有据可查"，不是期望行为。
   */
  it('exposes the pass-through-consumer trap as a documented empty delivery', { timeout: 60_000 }, async () => {
    const root = await scratch('qianshou-n5-passthrough-')
    const { built, connector } = await assembly({
      workspaceRoot: join(root, 'attempts'),
      minDiskFreeBytes: 0,
      // 把 harness 的写法照搬到生产装配上：这就是文档里点名的误用。
      resultConsumer: { consume: async ({ workspace }) => ({ outputs: workspace.outputs }) },
    })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest() as MemoryResidentSession
    await session.push(offer('task-n5-passthrough'))
    expect((await built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)

    expect(session.returnFrames()[0]?.outputs).toEqual([])
  })
})

/**
 * E7 · 常驻路径的核验结论必须落进**既有的任务状态**，而不是只打一行日志。
 *
 * 为什么这一组必须存在：`transport/edge-worker-session.ts:298` 丢掉 `complete()` 的返回值，
 * 常驻路径过去连"自己悬空"都不知道；而 `apps/qianshou-node` 那条独立守护虽然已经轮询，却只
 * `log` 一行。这里钉两件事：**结论变成状态**，以及**未知绝不变成成功**。
 *
 * 四态与唯一映射表来自 C25（`edge-worker/polled-verification.ts`）；本文件只**消费**它，
 * 并断言自己的 fixture 与那张表一致（见 {@link conclusion}）。
 */
describe('resident result verification lands in the attempt state', () => {
  /** One conclusion fixture; `isResultAcceptanceObserved` is asserted against it so it cannot drift. */
  function conclusion(
    outcome: 'workload-completed-shard-observed' | 'workload-failed-shard-observed'
      | 'no-change-within-window' | 'unobservable',
  ): ResidentResultVerification['verification'] {
    const disposition = outcome === 'workload-completed-shard-observed' ? 'settleable'
      : outcome === 'workload-failed-shard-observed' ? 'retryable'
        : outcome === 'no-change-within-window' ? 'retained' : 'indeterminate'
    // 与引擎的映射表对齐：fixture 与 `isResultAcceptanceObserved` 不一致时立刻红。
    expect(isResultAcceptanceObserved({ outcome })).toBe(disposition === 'settleable')
    return {
      outcome,
      disposition,
      attribution: 'workload-aggregate-only',
      identity: { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0 },
      before: { completedShards: 0, failedShards: 0 },
      after: outcome === 'unobservable' ? null : { completedShards: 1, failedShards: 0 },
      polls: 2,
      failedPolls: outcome === 'unobservable' ? 2 : 0,
      elapsedMs: 3,
      code: outcome === 'unobservable' ? 'EDGE_VERIFICATION_UNREADABLE' : null,
      failureClass: outcome === 'unobservable' ? 'unreadable' : null,
      retryable: outcome === 'unobservable' || outcome === 'no-change-within-window',
    }
  }

  /** 结论记录：真实传输在窗口关闭后发布的就是这个形状（`edge-binding.ts`）。 */
  function record(taskId: string, attempt: number, verification: ResidentResultVerification['verification']): ResidentResultVerification {
    return { taskId, attempt, sent: 'sent-awaiting-verification', identity: verification.identity, verification }
  }

  /** 跑一次真实尝试：真 workspace、真回传帧，然后等这次尝试自己变成 RETURNED。 */
  async function attemptWith(options: {
    outcome: Parameters<typeof conclusion>[0]
    /** 在 `consume` 里就发布结论：此刻尝试还停在 RETURNED 之前。 */
    reportDuringConsume?: boolean
  }) {
    const root = await scratch('qianshou-e7-verify-')
    const connector = new ReportingConnector()
    const taskId = `task-e7-${Math.abs(options.outcome.length)}-${options.reportDuringConsume === true ? 'early' : 'late'}`
    let session: ReportingSession | null = null
    const { built, store } = await assembly({
      connector,
      workspaceRoot: join(root, 'attempts'),
      minDiskFreeBytes: 0,
      resultConsumer: {
        consume: async () => {
          if (options.reportDuringConsume === true && session !== null) {
            session.report(record(taskId, 1, conclusion(options.outcome)))
          }
          return { outputs: Object.freeze([{ name: 'result.txt', bytes: 5, sha256: 'a'.repeat(64) }]) }
        },
      },
    })
    await built.runtime.start()
    await built.tick()
    session = connector.latest()
    expect(session.subscribers).toBe(1)
    session.planned = conclusion(options.outcome)
    await session.push(offer(taskId))
    expect((await built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    return { built, store, connector, taskId, sessionRef: () => session }
  }

  it('① 发出后能观察到核验结论：只有在平台计数前进时才把 RETURNED 推进到 SETTLED', async () => {
    const { built, store, taskId, sessionRef } = await attemptWith({ outcome: 'workload-completed-shard-observed' })
    const session = sessionRef()
    await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => (await store.get(taskId, 1))?.status, { timeout: 10_000 }).toBe('RETURNED')
    // 结论已经到装配手里（还没应用，因为还没 tick）。
    await built.tick()
    expect((await store.get(taskId, 1))?.status).toBe('SETTLED')
    expect(built.status().resultVerification).toMatchObject({
      observed: 1, settled: 1, dropped: 0, pending: 0,
      recent: [{
        taskId, attempt: 1, workloadId: 'workload-1', sent: 'sent-awaiting-verification',
        outcome: 'workload-completed-shard-observed', disposition: 'settleable', applied: 'settled',
      }],
    })
  })

  it('② 反向回归闸：未知不得被记为成功（状态停在 RETURNED，永不 SETTLED）', async () => {
    const { built, store, taskId, sessionRef } = await attemptWith({ outcome: 'unobservable' })
    const session = sessionRef()
    await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => (await store.get(taskId, 1))?.status, { timeout: 10_000 }).toBe('RETURNED')
    await built.tick()
    await built.tick()
    // 既没有结算，也没有任何"成功"的痕迹：结论照原样记着。
    expect((await store.get(taskId, 1))?.status).toBe('RETURNED')
    expect(built.status().resultVerification).toMatchObject({
      observed: 1, settled: 0, dropped: 0, pending: 0,
      recent: [{ outcome: 'unobservable', disposition: 'indeterminate', applied: 'not-settleable', code: 'EDGE_VERIFICATION_UNREADABLE' }],
    })
  })

  it('②-bis 待定（计数不动）与可重试（失败分片前进）同样不许结算', async () => {
    for (const outcome of ['no-change-within-window', 'workload-failed-shard-observed'] as const) {
      const { built, store, taskId, sessionRef } = await attemptWith({ outcome })
      const session = sessionRef()
      await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)
      await expect.poll(async () => (await store.get(taskId, 1))?.status, { timeout: 10_000 }).toBe('RETURNED')
      await built.tick()
      expect((await store.get(taskId, 1))?.status).toBe('RETURNED')
      expect(built.status().resultVerification).toMatchObject({
        settled: 0,
        recent: [{ outcome, applied: 'not-settleable' }],
      })
    }
  })

  it('③ 结论早于尝试自己的 RETURNED 到达 ⇒ 先留着，下一拍再落成 SETTLED', async () => {
    const { built, store, taskId, sessionRef } = await attemptWith({
      outcome: 'workload-completed-shard-observed',
      reportDuringConsume: true,
    })
    const session = sessionRef()
    await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)
    // 这一拍很可能还在 RETURNED 之前：结论被留住，不猜、不丢。
    await built.tick()
    const afterFirst = built.status().resultVerification
    if (afterFirst.settled === 0) {
      expect(afterFirst.recent[0]).toMatchObject({ applied: 'awaiting-returned-attempt' })
      expect(afterFirst.pending).toBe(1)
    }
    // 等尝试自己走到 RETURNED，再拍一次 ⇒ 结论落进既有状态。
    await expect.poll(async () => (await store.get(taskId, 1))?.status, { timeout: 10_000 }).not.toBe('EXECUTING')
    await expect.poll(async () => { await built.tick(); return built.status().resultVerification.settled }, { timeout: 10_000 }).toBe(1)
    expect((await store.get(taskId, 1))?.status).toBe('SETTLED')
    expect(built.status().resultVerification.pending).toBe(0)
  })

  it('③-bis 已经终结的尝试不会被第二条结论再改一次（幂等，且不重复结算）', async () => {
    const { built, store, taskId, sessionRef } = await attemptWith({ outcome: 'workload-completed-shard-observed' })
    const session = sessionRef()
    await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => (await store.get(taskId, 1))?.status, { timeout: 10_000 }).toBe('RETURNED')
    await built.tick()
    expect((await store.get(taskId, 1))?.status).toBe('SETTLED')
    // 重连后传输再报一条同样的结论：状态已经是终态，不许再被推进一次。
    session.report(record(taskId, 1, conclusion('workload-completed-shard-observed')))
    await built.tick()
    expect((await store.get(taskId, 1))?.status).toBe('SETTLED')
    expect(built.status().resultVerification).toMatchObject({ observed: 2, settled: 1 })
    expect(built.status().resultVerification.recent.at(-1)).toMatchObject({ applied: 'attempt-not-returned' })
  })

  it('④ 有界：没有任何东西来收时，队列到顶就丢并如实计数', async () => {
    const root = await scratch('qianshou-e7-bound-')
    const connector = new ReportingConnector()
    const { built } = await assembly({ connector, workspaceRoot: join(root, 'attempts'), minDiskFreeBytes: 0 })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest()
    for (let index = 0; index < 70; index += 1) {
      session.report(record(`unknown-task-${index}`, 1, conclusion('workload-completed-shard-observed')))
    }
    await built.tick()
    // 70 条里只有 64 条进得了队列；丢掉的 6 条被计数，不是静默消失。
    expect(built.status().resultVerification).toMatchObject({ observed: 70, dropped: 6, pending: 0, settled: 0 })
    expect(built.status().resultVerification.recent).toHaveLength(16)
    expect(built.status().resultVerification.recent.every(entry => entry.applied === 'attempt-not-found')).toBe(true)
    expect(built.status().resultVerification.recent.every(entry => entry.attempt === 1)).toBe(true)
  })

  it('⑤ 传输不报结论时也不许编：内存替身下这一格全为零', async () => {
    const root = await scratch('qianshou-e7-noseam-')
    const { built, connector, store } = await assembly({
      workspaceRoot: join(root, 'attempts'),
      minDiskFreeBytes: 0,
      resultConsumer: { consume: async () => ({ outputs: Object.freeze([{ name: 'result.txt', bytes: 5, sha256: 'a'.repeat(64) }]) }) },
    })
    await built.runtime.start()
    await built.tick()
    const session = connector.latest() as MemoryResidentSession
    await session.push(offer('task-e7-no-seam'))
    expect((await built.tick()).outcomes[0]).toMatchObject({ accepted: true })
    await expect.poll(() => session.returnFrames().length, { timeout: 10_000 }).toBe(1)
    await built.tick()
    expect(built.status().resultVerification).toEqual({ observed: 0, settled: 0, dropped: 0, pending: 0, recent: [] })
    // 结论一格不填，但回传帧照旧；而且没有任何东西被结算。
    expect((await store.get('task-e7-no-seam', 1))?.status).toBe('RETURNED')
  })
})

/** Digest of one UTF-8 payload, matching what a real consumer reports. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
