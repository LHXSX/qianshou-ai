/**
 * 准入闸门 G3/G4 的钉子。
 *
 * 这两处是**当前实际生效**的文件输入闸门（C12 §3.4 / 锚点第二十一节登记为"全仓无测试"）：
 * - G3 `src/resident-port.ts:162-167` —— precheck：`inputBytes > maxInputBytes`
 *   `|| maxOutputBytes > capability.maxOutputBytes` `|| (dataScope === 'none' && inputRefs.length > 0)`
 *   ⇒ `DATA_SCOPE_OR_RESOURCE_LIMIT`；
 * - G4 `src/index.ts:238-242` —— `ContributionController.acceptOffer` 里同形的第二个副本。
 *
 * 两者都在活路径上：`admission.ts:83` 先调 `port.precheck`，通过后再于 `:95` 调 `port.accept`。
 * 因此这里刻意**不经过 `ResidentNodeRuntime`**，直接驱动 `createResidentControlPort` 产出的
 * 真实 port，把"闸门本身"与循环、工作区、执行器解耦——本文件不修改任何既有文件。
 *
 * 生产广告形状是 `dataScope: 'none'` + `maxInputBytes: 0`（`src/edge-binding.ts:115-123`），
 * 所以生产上第一道就是 G3；G4 是第二道，也是"租约在排队期间已过期"那条支路
 * （`admission.ts:69` 跳过 precheck、直接 `accept`）上**唯一**的闸门。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ComputeCapabilityId,
  ComputeTaskId,
  EmployeeTaskCoordinator,
  assignmentFingerprint,
  type ComputeTaskEnvelope,
  type ContributorPolicy,
  type ContributorSnapshot,
} from '@deepseek-ai/dsh-compute-core'
import type { NodeTaskOfferMessage } from '@deepseek-ai/dsh-compute-core/node-protocol'
import { ComputeTaskStore } from '@deepseek-ai/dsh-compute-core/task-store'
import type {
  ResidentControlPort,
  ResidentDecisionEvent,
  ResidentOfferRequest,
  ResidentPrecheckInput,
} from '@deepseek-ai/dsh-compute-core/resident'
import type { ContributionCapability } from '../../src/index.ts'
import { createResidentControlPort } from '../../src/resident-port.ts'

/** Test-only signing secret; it never leaves this spec. */
const SECRET = 'c13-admission-gate-secret'
const sign = (fingerprint: string): string => createHmac('sha256', SECRET).update(fingerprint).digest('base64')

const NODE_ID = 'node-admission-gate-1'
const AGENT_VERSION = 'agent-0.1.0'
const CAPABILITY_ID = 'image.reference-generation'
const CAPABILITY_VERSION = '1.0.0'
const CAPABILITY_DIGEST = 'd'.repeat(64)
const T0 = Date.UTC(2026, 8, 15, 12, 0, 0)
const NOW = new Date(T0).toISOString()
const LEASE_EXPIRES = new Date(T0 + 600_000).toISOString()
const DIGEST = 'a'.repeat(64)

const POLICY: ContributorPolicy = {
  mode: 'BACKGROUND_ONLY', maxConcurrency: 2, maxCpuPercent: 80, maxGpuPercent: 80,
  maxTemperatureC: 85, minDiskFreeBytes: 1_000, allowWhileUserActive: false,
}
const SNAPSHOT: ContributorSnapshot = {
  userActive: false, voiceActive: false, cpuPercent: 10, gpuPercent: 10,
  temperatureC: 40, diskFreeBytes: 100_000, runningTasks: 0,
}

/** Production advertisement shape: the node advertises it cannot take input bytes at all. */
const NONE_SCOPE_CAPABILITY: ContributionCapability = {
  capabilityId: CAPABILITY_ID, version: CAPABILITY_VERSION, pluginDigest: CAPABILITY_DIGEST,
  dataScope: 'none', maxInputBytes: 0, maxOutputBytes: 1_048_576, available: true,
}
/**
 * A mis-advertised scope: the node says it takes no input but still publishes a byte
 * ceiling. Without this shape the byte clause refuses first, so the scope clause can
 * never be observed on its own.
 */
const NONE_SCOPE_WITH_CEILING: ContributionCapability = { ...NONE_SCOPE_CAPABILITY, maxInputBytes: 64 }
/** The scope a node must advertise before any input reference may be admitted. */
const TASK_INPUTS_CAPABILITY: ContributionCapability = {
  capabilityId: CAPABILITY_ID, version: CAPABILITY_VERSION, pluginDigest: CAPABILITY_DIGEST,
  dataScope: 'task-inputs', maxInputBytes: 10_000, maxOutputBytes: 100_000, available: true,
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(async path => { await rm(path, { recursive: true, force: true }) })) })

interface Fixture {
  port: ResidentControlPort
  decisions: ResidentDecisionEvent[]
}

/** The real control-plane binding, over a real store/coordinator and a real controller. */
async function binding(capabilities: readonly ContributionCapability[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-admission-gate-'))
  roots.push(root)
  const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 16, maxBytes: 65_536 })
  const coordinator = new EmployeeTaskCoordinator(store)
  const decisions: ResidentDecisionEvent[] = []
  const { port } = createResidentControlPort({
    nodeId: NODE_ID,
    agentVersion: AGENT_VERSION,
    policy: POLICY,
    coordinator,
    store,
    capabilities: () => capabilities,
    transport: {
      publishHeartbeat: async () => {},
      reportDecision: async (event) => { decisions.push(event) },
      reportEarnings: async () => {},
    },
    verifySignature: async (fingerprint, signature) => signature === sign(fingerprint),
    leaseOf: (taskId, attempt, expiresAt) => ({
      version: 'qianshou.node.lease.v1',
      leaseId: `lease-${taskId}-${attempt}`,
      taskId,
      attempt,
      ownerNodeId: NODE_ID,
      // Issued one minute before it expires, so it never depends on a local clock.
      issuedAt: new Date(Date.parse(expiresAt) - 60_000).toISOString(),
      expiresAt,
      idempotencyKey: `idem-${taskId}`,
      capabilityPluginDigest: CAPABILITY_DIGEST,
    }),
  })
  return { port, decisions }
}

/** One signed `task.offer` frame; `inputRefs` and `maxOutputBytes` are the only knobs the gates read. */
async function frame(
  fixture: Fixture,
  taskId: string,
  inputRefs: readonly ComputeTaskEnvelope['inputRefs'][number][] = [],
  maxOutputBytes = 100_000,
): Promise<ReturnType<ResidentControlPort['verifyOffer']> extends Promise<infer R> ? R : never> {
  const envelope: ComputeTaskEnvelope = {
    version: 'qianshou.task.v1',
    taskId: ComputeTaskId(taskId),
    capabilityId: ComputeCapabilityId(CAPABILITY_ID),
    capabilityVersion: CAPABILITY_VERSION,
    inputRefs,
    parameters: { prompt: 'admission-gate' },
    deadlineAt: new Date(T0 + 1_800_000).toISOString(),
    maxOutputBytes,
    idempotencyKey: `idem-${taskId}`,
  }
  const assignment = {
    envelope, attempt: 1, capabilityPluginDigest: CAPABILITY_DIGEST,
    leaseExpiresAt: LEASE_EXPIRES, receivedAt: NOW,
  }
  const signature = sign(assignmentFingerprint(assignment))
  const request: ResidentOfferRequest = {
    offer: { type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: LEASE_EXPIRES, receivedAt: NOW, signature } as NodeTaskOfferMessage,
    signature,
    traceId: `trace-${taskId}`,
  }
  return await fixture.port.verifyOffer(request)
}

const precheckInput = (): ResidentPrecheckInput => ({
  now: NOW,
  policy: POLICY,
  snapshot: SNAPSHOT,
  availableCapabilities: new Set([`${CAPABILITY_ID}@${CAPABILITY_VERSION}@${CAPABILITY_DIGEST}`]),
})

/** The candidate the real verifier minted, or a failure that names why it did not. */
async function candidateOf(
  fixture: Fixture,
  taskId: string,
  inputRefs: readonly ComputeTaskEnvelope['inputRefs'][number][] = [],
  maxOutputBytes = 100_000,
) {
  const verified = await frame(fixture, taskId, inputRefs, maxOutputBytes)
  expect(verified.accepted, `verifyOffer refused ${taskId}: ${verified.code ?? ''}`).toBe(true)
  return verified.candidate!
}

describe('G3 · resident-port precheck gate (resident-port.ts:162-167)', () => {
  it('admits a reference that exactly fills maxInputBytes', async () => {
    // Pins `>` (not `>=`) at :163 and `>` at :164: both comparisons sit exactly on the ceiling.
    const fixture = await binding([TASK_INPUTS_CAPABILITY])
    const result = await fixture.port.precheck(
      await candidateOf(fixture, 'g3-allow', [{ name: 'a.bin', bytes: 10_000, sha256: DIGEST }]),
      precheckInput(),
    )
    expect(result).toEqual({ accepted: true, reason: 'READY' })
    expect(fixture.decisions).toEqual([])
  })

  it('refuses when summed inputRefs bytes exceed maxInputBytes', async () => {
    // Pins the `reduce` and the `>` at :162-163. Deleting the clause admits the offer ⇒ red.
    const fixture = await binding([TASK_INPUTS_CAPABILITY])
    const result = await fixture.port.precheck(
      await candidateOf(fixture, 'g3-input-over', [{ name: 'a.bin', bytes: 10_001, sha256: DIGEST }]),
      precheckInput(),
    )
    expect(result).toEqual({ accepted: false, reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT' })
    expect(fixture.decisions).toEqual([expect.objectContaining({
      decision: 'refused', reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT', taskId: 'g3-input-over', attempt: 1,
    })])
  })

  it('refuses when several individually legal references exceed the ceiling together', async () => {
    // Pins that the gate sums: reading only `inputRefs[0].bytes` would admit this offer ⇒ red.
    const fixture = await binding([TASK_INPUTS_CAPABILITY])
    const result = await fixture.port.precheck(
      await candidateOf(fixture, 'g3-input-sum', [
        { name: 'a.bin', bytes: 6_000, sha256: DIGEST },
        { name: 'b.bin', bytes: 6_000, sha256: DIGEST },
      ]),
      precheckInput(),
    )
    expect(result).toEqual({ accepted: false, reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT' })
  })

  it('refuses when maxOutputBytes exceed the capability ceiling', async () => {
    // Pins :164 alone: input bytes are zero here, so only the output ceiling can refuse.
    const fixture = await binding([TASK_INPUTS_CAPABILITY])
    const result = await fixture.port.precheck(
      await candidateOf(fixture, 'g3-output-over', [], 100_001),
      precheckInput(),
    )
    expect(result).toEqual({ accepted: false, reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT' })
  })

  it('refuses an input reference on a dataScope:none node that still publishes a byte ceiling', async () => {
    // Pins :165 alone: one byte is inside this node's 64-byte ceiling, so the byte
    // clause cannot refuse — deleting the scope clause admits the offer ⇒ red.
    const fixture = await binding([NONE_SCOPE_WITH_CEILING])
    const result = await fixture.port.precheck(
      await candidateOf(fixture, 'g3-scope-clause', [{ name: 'a.bin', bytes: 1, sha256: DIGEST }]),
      precheckInput(),
    )
    expect(result).toEqual({ accepted: false, reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT' })
    expect(fixture.decisions).toEqual([expect.objectContaining({
      decision: 'refused', reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT', taskId: 'g3-scope-clause', attempt: 1,
    })])
  })

  it('refuses input on the production dataScope:none / maxInputBytes:0 advertisement', async () => {
    // The shape `edge-binding.ts:115-123` really publishes; :163 and :165 both cover it.
    const fixture = await binding([NONE_SCOPE_CAPABILITY])
    const result = await fixture.port.precheck(
      await candidateOf(fixture, 'g3-production-shape', [{ name: 'a.bin', bytes: 1, sha256: DIGEST }]),
      precheckInput(),
    )
    expect(result).toEqual({ accepted: false, reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT' })
  })

  it('still admits an offer that carries no reference at all', async () => {
    // The advertisement refuses input references, not work: an empty `inputRefs` passes.
    const fixture = await binding([NONE_SCOPE_CAPABILITY])
    const result = await fixture.port.precheck(await candidateOf(fixture, 'g3-production-empty'), precheckInput())
    expect(result).toEqual({ accepted: true, reason: 'READY' })
  })
})

describe('G4 · ContributionController.acceptOffer gate (index.ts:238-242)', () => {
  it('admits an offer inside both ceilings', async () => {
    // The allow path of the second copy: `coordination.action.type === 'accept'`.
    const fixture = await binding([TASK_INPUTS_CAPABILITY])
    const candidate = await candidateOf(fixture, 'g4-allow', [{ name: 'a.bin', bytes: 10_000, sha256: DIGEST }])
    const result = await fixture.port.accept(candidate, precheckInput())
    expect(result.accepted).toBe(true)
    expect(fixture.decisions).toEqual([expect.objectContaining({ decision: 'accepted', taskId: 'g4-allow' })])
  })

  it('refuses with DATA_SCOPE_OR_RESOURCE_LIMIT when input bytes exceed the ceiling', async () => {
    // Pins index.ts:238-239. The distinguishing signal is the reported frame, because the
    // returned `action.reason` is the coarse 'CAPABILITY_UNAVAILABLE' literal at :245.
    const fixture = await binding([TASK_INPUTS_CAPABILITY])
    const candidate = await candidateOf(fixture, 'g4-input-over', [{ name: 'a.bin', bytes: 10_001, sha256: DIGEST }])
    const result = await fixture.port.accept(candidate, precheckInput())
    expect(result.accepted).toBe(false)
    expect(fixture.decisions).toEqual([expect.objectContaining({
      decision: 'refused', reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT', taskId: 'g4-input-over', attempt: 1,
    })])
  })

  it('refuses when maxOutputBytes exceed the ceiling', async () => {
    // Pins index.ts:240 with zero input bytes.
    const fixture = await binding([TASK_INPUTS_CAPABILITY])
    const candidate = await candidateOf(fixture, 'g4-output-over', [], 100_001)
    const result = await fixture.port.accept(candidate, precheckInput())
    expect(result.accepted).toBe(false)
    expect(fixture.decisions).toEqual([expect.objectContaining({
      decision: 'refused', reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT', taskId: 'g4-output-over',
    })])
  })

  it('refuses an input reference on a dataScope:none node that still publishes a byte ceiling', async () => {
    // Pins index.ts:241 alone, and pins that the refusal reason survives to the frame.
    const fixture = await binding([NONE_SCOPE_WITH_CEILING])
    const candidate = await candidateOf(fixture, 'g4-scope-clause', [{ name: 'a.bin', bytes: 1, sha256: DIGEST }])
    const result = await fixture.port.accept(candidate, precheckInput())
    expect(result.accepted).toBe(false)
    expect(fixture.decisions).toEqual([expect.objectContaining({
      decision: 'refused', reason: 'DATA_SCOPE_OR_RESOURCE_LIMIT', taskId: 'g4-scope-clause',
    })])
  })

  it('refuses input on the production dataScope:none advertisement and admits an empty offer', async () => {
    // The shape `edge-binding.ts:115-123` really publishes: references refused, plain work admitted.
    const refused = await binding([NONE_SCOPE_CAPABILITY])
    expect((await refused.port.accept(
      await candidateOf(refused, 'g4-production-shaped', [{ name: 'a.bin', bytes: 1, sha256: DIGEST }]),
      precheckInput(),
    )).accepted).toBe(false)

    const admitted = await binding([NONE_SCOPE_CAPABILITY])
    const empty = await admitted.port.accept(await candidateOf(admitted, 'g4-production-empty'), precheckInput())
    expect(empty.accepted).toBe(true)
    expect(admitted.decisions).toEqual([expect.objectContaining({ decision: 'accepted', taskId: 'g4-production-empty' })])
  })
})
