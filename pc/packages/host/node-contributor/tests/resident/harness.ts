import { createHash, createHmac } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ComputeCapabilityId,
  ComputeTaskId,
  ComputeTaskStore,
  ComputeExecutorRegistry,
  ComputeLocalTaskRunner,
  EmployeeTaskCoordinator,
  assignmentFingerprint,
  parseNodeTaskLease,
  type ComputeExecutionResult,
  type ComputeExecutionContext,
  type ComputeExecutor,
  type ComputeTaskEnvelope,
  type ComputeTaskState,
  type ContributorPolicy,
  type ContributorSnapshot,
} from '@deepseek-ai/dsh-compute-core'
import { ComputeNodeId, type NodeTaskOfferMessage } from '@deepseek-ai/dsh-compute-core/node-protocol'
import { ResidentNodeRuntime } from '@deepseek-ai/dsh-compute-core/resident'
import type { ComputeResidentAttemptExecution, ComputeResidentWorkspace, ResidentResourceObservation } from '@deepseek-ai/dsh-compute-core/resident'
import { MemoryResidentConnector, MemoryResidentSession } from '@deepseek-ai/dsh-compute-core/transport/memory-session'
import { ContributionController, type ContributionTransport } from '../../src/index.ts'
import { createResidentControlPort } from '../../src/resident-port.ts'

/** Test-only signing secret; it never leaves this harness. */
const SECRET = 'resident-loop-test-secret'
export const NODE_ID = 'node-resident-1'
export const AGENT_VERSION = 'agent-0.1.0'
export const CAPABILITY_ID = 'image.reference-generation'
export const CAPABILITY_VERSION = '1.0.0'
export const CAPABILITY_DIGEST = 'd'.repeat(64)
export const OTHER_DIGEST = 'e'.repeat(64)
export const T0 = Date.UTC(2026, 8, 15, 12, 0, 0)

/** Deterministic clock the test advances explicitly. */
export class FakeClock {
  private value: number
  constructor(start: number = T0) { this.value = start }
  now(): number { return this.value }
  iso(): string { return new Date(this.value).toISOString() }
  advance(ms: number): void { this.value += ms }
}

/** One recorded local execution attempt. */
export interface RecordedRun {
  taskId: string
  attempt: number
  workspacePath: string
}

/** One locally self-tested capability the node advertises. */
export interface TestCapability {
  capabilityId: string
  version: string
  pluginDigest: string
  dataScope: 'none' | 'task-inputs'
  maxInputBytes: number
  maxOutputBytes: number
  available: boolean
}

/**
 * Test node: the real resident runtime, the real local execution stack and the
 * real `ContributionController` bound through the production port factory.
 */
export class TestResidentNode {
  readonly clock = new FakeClock()
  readonly connector = new MemoryResidentConnector()
  readonly executors = new ComputeExecutorRegistry()
  readonly runner: ComputeLocalTaskRunner
  readonly store: ComputeTaskStore
  readonly coordinator: EmployeeTaskCoordinator
  readonly controller: ContributionController
  readonly runs: RecordedRun[] = []
  readonly createdWorkspaces: string[] = []
  readonly closedWorkspaces: string[] = []
  readonly decisions: unknown[] = []
  readonly earnings: unknown[] = []
  runtime: ResidentNodeRuntime
  snapshot: ContributorSnapshot
  failWorkspaceWith: string | null = null
  holdRun: { promise: Promise<void>; release: () => void } | null = null
  capabilityList: TestCapability[]
  private readonly root: string
  /** Control-plane port under test, kept visible so a case can drive it directly. */
  readonly port: ReturnType<typeof createResidentControlPort>['port']
  private readonly onRun: ((run: RecordedRun) => Promise<void>) | undefined
  private session: MemoryResidentSession | null = null
  private attemptCounter = 0
  private finalWorkspacePath: string | null = null

  private constructor(options: {
    root: string
    policy: ContributorPolicy
    snapshot: ContributorSnapshot
    onRun?: (run: RecordedRun) => Promise<void>
    keepExpiredQueuedAttempts?: boolean
    stopTimeoutMs?: number
  }) {
    this.root = options.root
    this.snapshot = options.snapshot
    this.onRun = options.onRun
    this.capabilityList = [{
      capabilityId: CAPABILITY_ID,
      version: CAPABILITY_VERSION,
      pluginDigest: CAPABILITY_DIGEST,
      dataScope: 'task-inputs',
      maxInputBytes: 1_048_576,
      maxOutputBytes: 8_388_608,
      available: true,
    }]
    this.store = new ComputeTaskStore({ path: join(options.root, 'tasks.json'), maxTasks: 64, maxBytes: 65_536 })
    this.coordinator = new EmployeeTaskCoordinator(this.store)
    this.runner = new ComputeLocalTaskRunner(this.executors)
    const transport: ContributionTransport = {
      publishHeartbeat: async (message) => { await this.session?.sendHeartbeat(message) },
      reportDecision: async (event) => { this.decisions.push(event) },
      reportEarnings: async (event) => { this.earnings.push(event) },
    }
    const { port, controller } = createResidentControlPort({
      nodeId: NODE_ID,
      agentVersion: AGENT_VERSION,
      policy: options.policy,
      coordinator: this.coordinator,
      store: this.store,
      capabilities: () => this.capabilityList,
      transport,
      verifySignature: async (fingerprint, signature) => signature === sign(fingerprint),
      leaseOf: (taskId, attempt, expiresAt) => this.leaseOf(taskId, attempt, expiresAt),
    })
    this.controller = controller
    const inner = port
    this.port = { ...inner, verifyOffer: async (request) => { const r = await inner.verifyOffer(request); console.log('VERIFY', JSON.stringify({ accepted: r.accepted, code: r.code })); return r } }
    const observer = {
      snapshot: async (runningTasks: number): Promise<ResidentResourceObservation> => ({
        snapshot: { ...this.snapshot, runningTasks },
        heartbeat: {
          version: 'qianshou.node.v1' as const,
          nodeId: ComputeNodeId(NODE_ID),
          agentVersion: AGENT_VERSION,
          sentAt: this.clock.iso(),
          capabilities: options.policy.mode === 'OFF'
            ? []
            : [{ capabilityId: ComputeCapabilityId(CAPABILITY_ID), version: CAPABILITY_VERSION, pluginDigest: CAPABILITY_DIGEST }],
          maxConcurrency: options.policy.maxConcurrency,
          runningTasks,
        },
      }),
    }
    this.runtime = new ResidentNodeRuntime({
      nodeId: NODE_ID,
      agentVersion: AGENT_VERSION,
      policy: options.policy,
      observer,
      capabilities: { listCapabilities: () => this.capabilityList },
      connector: { connect: (signal) => this.connect(signal) },
      port,
      workspace: { createWorkspace: (execution) => this.createWorkspace(execution) },
      resultConsumer: { consume: async ({ workspace }) => ({ outputs: workspace.outputs }) },
      clock: () => this.clock.now(),
      // Generous enough for a real filesystem-backed run to finish and be
      // recorded; the grace-period case narrows it explicitly.
      stopTimeoutMs: options.stopTimeoutMs ?? 3_000,
      drainStepMs: 1,
      ...(options.keepExpiredQueuedAttempts === undefined ? {} : { keepExpiredQueuedAttempts: options.keepExpiredQueuedAttempts }),
    })
  }

  /** Create one node with a private task store and workspace root. */
  static async create(options: {
    policy?: Partial<ContributorPolicy>
    snapshot?: Partial<ContributorSnapshot>
    onRun?: (run: RecordedRun) => Promise<void>
    keepExpiredQueuedAttempts?: boolean
    stopTimeoutMs?: number
  } = {}): Promise<TestResidentNode> {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-resident-'))
    const policy: ContributorPolicy = {
      mode: 'BACKGROUND_ONLY',
      maxConcurrency: 2,
      maxCpuPercent: 80,
      maxGpuPercent: 80,
      maxTemperatureC: 85,
      minDiskFreeBytes: 1_000,
      allowWhileUserActive: false,
      ...options.policy,
    }
    const snapshot: ContributorSnapshot = {
      userActive: false,
      voiceActive: false,
      cpuPercent: 10,
      gpuPercent: 10,
      temperatureC: 40,
      diskFreeBytes: 100_000,
      runningTasks: 0,
      ...options.snapshot,
    }
    const node = new TestResidentNode({
      root,
      policy,
      snapshot,
      ...(options.onRun === undefined ? {} : { onRun: options.onRun }),
      ...(options.keepExpiredQueuedAttempts === undefined ? {} : { keepExpiredQueuedAttempts: options.keepExpiredQueuedAttempts }),
      ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    })
    node.registerExecutor()
    return node
  }

  /** Register a deterministic capability that writes one verifiable output file. */
  registerExecutor(execute?: ComputeExecutor['execute']): void {
    const defaultExecute = async (task: ComputeTaskEnvelope, context: ComputeExecutionContext): Promise<ComputeExecutionResult> => {
      this.runs.push({ taskId: task.taskId, attempt: this.attemptCounter, workspacePath: context.workspacePath })
      await context.reportProgress(0.5, 'executing')
      if (this.holdRun) await this.holdRun.promise
      context.signal.throwIfAborted()
      const content = `result:${task.taskId}`
      await writeFile(join(context.workspacePath, 'out.txt'), content, { mode: 0o600 })
      return {
        outputs: [{ name: 'out.txt', path: 'out.txt', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }],
      }
    }
    this.executors.register({
      capabilityId: ComputeCapabilityId(CAPABILITY_ID),
      version: CAPABILITY_VERSION,
      execute: execute ?? defaultExecute,
    })
  }

  /** Decision events the binding actually reported to the transport. */
  decisionEvents(): readonly { decision: string; reason?: string; taskId: string | null }[] {
    return this.decisions as readonly { decision: string; reason?: string; taskId: string | null }[]
  }

  /** Latest opened session, or null before the runtime connected or after a drop. */
  latestSession(): MemoryResidentSession | null { return this.session }

  /** Every session the runtime opened, in connect order. */
  sessions(): readonly MemoryResidentSession[] { return this.connector.sessions }

  /** Build one signed wire offer for the given task identity. */
  offer(taskId: string, options: { attempt?: number; leaseMs?: number; deadlineMs?: number; capabilityVersion?: string; capabilityPluginDigest?: string } = {}): NodeTaskOfferMessage {
    const attempt = options.attempt ?? 1
    const envelope = this.envelope(taskId, options)
    const assignment = {
      envelope,
      attempt,
      capabilityPluginDigest: options.capabilityPluginDigest ?? CAPABILITY_DIGEST,
      leaseExpiresAt: new Date(this.clock.now() + (options.leaseMs ?? 600_000)).toISOString(),
      receivedAt: this.clock.iso(),
    }
    return {
      type: 'task.offer',
      envelope,
      attempt,
      leaseExpiresAt: assignment.leaseExpiresAt,
      receivedAt: assignment.receivedAt,
      signature: sign(assignmentFingerprint(assignment)),
    }
  }

  /** One task envelope matching the node's advertised capability. */
  envelope(taskId: string, options: { deadlineMs?: number; capabilityVersion?: string } = {}): ComputeTaskEnvelope {
    return {
      version: 'qianshou.task.v1',
      taskId: ComputeTaskId(taskId),
      capabilityId: ComputeCapabilityId(CAPABILITY_ID),
      capabilityVersion: options.capabilityVersion ?? CAPABILITY_VERSION,
      inputRefs: [],
      parameters: { prompt: 'resident-loop' },
      deadlineAt: new Date(this.clock.now() + (options.deadlineMs ?? 1_800_000)).toISOString(),
      maxOutputBytes: 1_048_576,
      idempotencyKey: `idem-${taskId}`,
    }
  }

  /** Deliver one signed offer through the session seam the runtime subscribed to. */
  async pushOffer(offer: NodeTaskOfferMessage): Promise<void> {
    const session = this.session
    if (!session) throw new Error('resident test node is not connected')
    // The JSON round trip proves the runtime never depends on object identity
    // from a test helper; a real transport delivers decoded JSON.
    await session.push(JSON.parse(JSON.stringify(offer)) as NodeTaskOfferMessage)
  }

  /** Persisted attempt state for one task attempt, read from the node's own store. */
  async state(taskId: string, attempt = 1): Promise<{ status: string; progress: number; decisionReason?: string } | null> {
    const state = await this.store.get(taskId, attempt)
    if (state === null) return null
    return {
      status: state.status,
      progress: state.progress,
      ...(state.decisionReason === undefined ? {} : { decisionReason: state.decisionReason }),
    }
  }

  /** Every persisted attempt, ordered as the store returns it. */
  async states(): Promise<readonly ComputeTaskState[]> { return await this.store.list() }

  /** Workspace path for one executed task. */
  workspaceOf(taskId: string): string | undefined { return this.runs.find(run => run.taskId === taskId)?.workspacePath }

  /** True when the path exists; used to check that a workspace was really removed. */
  async workspaceExists(path: string): Promise<boolean> {
    try { await access(path); return true } catch { return false }
  }

  /** Drop the temporary root and close every owned resource. */
  async dispose(): Promise<void> {
    await this.runtime.stop('test teardown').catch(() => undefined)
    await this.controller.close().catch(() => undefined)
    await this.coordinator.close().catch(() => undefined)
    await this.store.close().catch(() => undefined)
    await rm(this.root, { recursive: true, force: true })
  }

  private async connect(signal: AbortSignal): Promise<MemoryResidentSession> {
    const session = await this.connector.connect(signal) as MemoryResidentSession
    this.session = session
    return session
  }

  private leaseOf(taskId: string, attempt: number, expiresAt: string): unknown {
    return {
      version: 'qianshou.node.lease.v1',
      leaseId: `lease-${taskId}-${attempt}`,
      taskId,
      attempt,
      ownerNodeId: NODE_ID,
      // Independent of the test clock: the dispatch side issues the lease one
      // minute before it expires, so advancing the clock cannot make this invalid.
      issuedAt: new Date(Date.parse(expiresAt) - 60_000).toISOString(),
      expiresAt,
      idempotencyKey: `idem-${taskId}`,
      capabilityPluginDigest: CAPABILITY_DIGEST,
    }
  }

  private async createWorkspace(execution: ComputeResidentAttemptExecution): Promise<ComputeResidentWorkspace> {
    if (this.failWorkspaceWith !== null) throw new Error(this.failWorkspaceWith)
    this.attemptCounter = execution.attempt.attempt
    const rootPath = join(this.root, `work-${execution.task.taskId}-${execution.attempt.attempt}-${Date.now()}`)
    await mkdir(rootPath, { recursive: true, mode: 0o700 })
    this.createdWorkspaces.push(rootPath)
    const outputs = await this.runner.run(execution.task, {
      workspace: { rootPath, maxInputBytes: 1_048_576 },
      source: execution.source,
      signal: execution.signal,
      reportProgress: async (progress, phase) => {
        // Advance the deterministic clock so a long run still shows the lease
        // guard firing, then forward the receipt to the resident runtime.
        this.clock.advance(1_000)
        await execution.reportProgress(progress, phase)
      },
      consumeResult: async (result, consumeSignal) => {
        consumeSignal.throwIfAborted()
        for (const output of result.outputs) {
          if ((await readFile(output.path)).byteLength === 0) throw new Error('COMPUTE_RESIDENT_EMPTY_OUTPUT')
        }
        // Record the canonical workspace path; the runner resolves symlinks
        // (macOS `/tmp` -> `/private/var/...`) before handing files back.
        this.finalWorkspacePath = await realpath(rootPath)
        // Verified output references keep their canonical paths: the resident
        // runtime never receives a local path, only the manifest it uploads.
        return { outputs: result.outputs.map(output => ({ name: output.name, path: output.path, bytes: output.bytes, sha256: output.sha256 })) }
      },
    })
    if (this.onRun) await this.onRun({ taskId: execution.task.taskId, attempt: execution.attempt.attempt, workspacePath: rootPath })
    const owned = this.finalWorkspacePath ?? rootPath
    return {
      path: owned,
      outputs: outputs.outputs,
      close: async () => { this.closedWorkspaces.push(owned) },
    }
  }
}

/** Test-only HMAC signature over an assignment fingerprint. */
export function sign(fingerprint: string): string {
  return createHmac('sha256', SECRET).update(fingerprint).digest('base64')
}

/** SHA-256 hex digest of a UTF-8 string. */
export function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Let the runtime's asynchronous pipeline advance. `setImmediate` alone cannot
 * flush real filesystem I/O, so a short real timer is included.
 */
export async function settle(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise(resolve => { setImmediate(resolve) })
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }
}

/**
 * Wait until `check` is true, or fail the assertion with the last observation.
 * @param check - Predicate polled until it returns true.
 * @param describe - Message used when the deadline expires.
 * @param timeoutMs - Bounded wait; a runaway attempt must fail the test, not hang it.
 */
export async function waitFor(check: () => boolean | Promise<boolean>, describe: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await settle(1)
  }
  if (await check()) return
  throw new Error(`timed out waiting for ${describe}`)
}

/** Wait until one attempt reaches a persisted status. */
export async function waitForStatus(node: TestResidentNode, taskId: string, status: string, timeoutMs = 5_000): Promise<void> {
  await waitFor(async () => (await node.state(taskId))?.status === status, `${taskId} to reach ${status}`, timeoutMs)
}

/** Lease parser the harness shares with the production binding during assertions. */
export const parseLease = parseNodeTaskLease
