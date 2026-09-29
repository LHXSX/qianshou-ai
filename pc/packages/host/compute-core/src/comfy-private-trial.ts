/** Trusted Host-only ComfyUI sample runner. Not mounted as a route, model tool or public executor. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ComfyImageBackend } from './comfy-image-backend.ts'
import { ComfyPrivateTrialLedger, type ComfyTrialResult } from './comfy-private-trial-ledger.ts'
import type { PrivateComfyDraftAsset } from './comfy-draft-asset.ts'
import { preflightLocalComfyWorkflow } from './comfy-workflow-preflight.ts'
import { PRIVATE_COMFY_EXECUTOR_CAPABILITY, PRIVATE_COMFY_EXECUTOR_VERSION } from './comfy-private-adapter-candidate.ts'
import { verifyTaskOutputs } from './task-output.ts'
import type { LocalPluginDraftStore } from './plugin-draft.ts'
import { ComputeExecutorRegistry, type ComputeExecutor } from './executor.ts'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from './protocol.ts'
import { ComputeError } from './errors.ts'

const ID = /^[A-Za-z0-9._:-]{1,128}$/u
const TRIAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const MAX_PROMPT = 2000
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const PRIVATE_CAPABILITY = ComputeCapabilityId(PRIVATE_COMFY_EXECUTOR_CAPABILITY)
const PRIVATE_VERSION = PRIVATE_COMFY_EXECUTOR_VERSION

/** Exact approval seam supplied by the real Host user-approval service during an open agent turn. */
export interface ComfyTrialOwnerApproval {
  request(value: {
    agent: unknown
    toolName: string
    callId?: unknown
    reason: string
    signal: AbortSignal
  }): Promise<string>
}

export interface PrivateComfyTrialInput {
  readonly ownerId: string
  readonly draftId: string
  readonly operationId: string
  readonly idempotencyKey: string
  readonly port: number
  readonly prompt: string
  readonly negativePrompt?: string
  readonly seed?: number
  readonly width?: number
  readonly height?: number
  readonly agent: unknown
  readonly callId?: unknown
  readonly signal: AbortSignal
}

export interface PrivateComfyTrialReceipt {
  readonly trialId: string
  readonly status: 'completed'
  readonly graphSha256: string
  readonly result: ComfyTrialResult
  readonly installable: false
  readonly dispatchable: false
}

/** A Host-only readback. Pending means the original prompt must not be resubmitted. */
export interface PrivateComfyTrialReconciliation {
  readonly trialId: string
  readonly status: 'pending' | 'completed' | 'rejected'
  readonly result?: ComfyTrialResult
  readonly installable: false
  readonly dispatchable: false
}

function invalid(): ComputeError { return new ComputeError('COMPUTE_COMFY_TRIAL_INVALID', 400) }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function parameters(value: PrivateComfyTrialInput, asset: PrivateComfyDraftAsset): Record<string, string | number> {
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT
    || /[\u0000\u007f]/u.test(value.prompt)) throw invalid()
  const input: Record<string, string | number> = { prompt: value.prompt }
  if (value.negativePrompt !== undefined) {
    if (!asset.mapping.negativePrompt || typeof value.negativePrompt !== 'string'
      || value.negativePrompt.length > MAX_PROMPT || /[\u0000\u007f]/u.test(value.negativePrompt)) throw invalid()
    input.negativePrompt = value.negativePrompt
  }
  if (value.seed !== undefined) {
    if (!asset.mapping.seed || !Number.isSafeInteger(value.seed) || value.seed < 0) throw invalid()
    input.seed = value.seed
  }
  for (const key of ['width', 'height'] as const) {
    const size = value[key]
    if (size !== undefined) {
      if (!asset.mapping[key] || !Number.isSafeInteger(size) || size < 256 || size > 1024 || size % 64 !== 0) throw invalid()
      input[key] = size
    }
  }
  return input
}

/** One immutable owner graph plus only explicitly mapped text/seed/size overrides. */
function renderGraph(asset: PrivateComfyDraftAsset, input: Record<string, string | number>, trialId: string): unknown {
  const graph = structuredClone(asset.graph) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  for (const [key, value] of Object.entries(input)) {
    const ref = asset.mapping[key as keyof typeof asset.mapping]
    if (!ref || typeof ref !== 'object' || !('nodeId' in ref)) throw invalid()
    const node = graph[ref.nodeId]
    if (!node) throw invalid()
    node.inputs[ref.field] = value
  }
  const output = graph[asset.mapping.outputNodeId]
  if (output?.class_type !== 'SaveImage') throw invalid()
  output.inputs.filename_prefix = `qs_trial_${trialId.replaceAll('-', '').slice(0, 12)}`
  return graph
}

/** Exact Host-owned contribution, captured to one draft operation and graph digest. */
class ComfyPrivateSampleExecutor implements ComputeExecutor {
  readonly capabilityId = PRIVATE_CAPABILITY
  readonly version = PRIVATE_VERSION

  constructor(private readonly trialId: string, private readonly inputSha256: string,
    private readonly graph: unknown, private readonly promptId: string, private readonly clientId: string,
    private readonly outputNodeId: string, private readonly backend: ComfyImageBackend,
    private readonly ledger: ComfyPrivateTrialLedger, private readonly key: string) {}

  async execute(task: ComputeTaskEnvelope, context: Parameters<ComputeExecutor['execute']>[1]) {
    if (String(task.taskId) !== this.trialId || digest(task.parameters) !== this.inputSha256
      || task.capabilityId !== this.capabilityId || task.capabilityVersion !== this.version) throw invalid()
    await this.backend.submit(this.graph, this.promptId, this.clientId, context.signal)
    await this.ledger.advance(this.key, ['sending'], 'queued')
    await context.reportProgress(0.1, 'queued')
    const image = await this.backend.waitForImage(this.promptId, this.outputNodeId, context.signal)
    const downloaded = await this.backend.download(image, context.workspacePath, context.signal)
    const requested = task.parameters as Record<string, unknown>
    if ((requested.width !== undefined && downloaded.width !== requested.width)
      || (requested.height !== undefined && downloaded.height !== requested.height)) {
      throw new ComputeError('COMPUTE_COMFY_TRIAL_DIMENSION_MISMATCH', 422)
    }
    await context.reportProgress(1, 'sample-ready')
    return { outputs: [downloaded.output], metadata: {
      width: String(downloaded.width), height: String(downloaded.height), privateTrial: 'true',
    } }
  }
}

/** Entrypoint requires a real Host approval service; there is intentionally no HTTP/model entry. */
export class PrivateComfyTrialHost {
  private readonly inFlight = new Set<string>()
  constructor(private readonly options: {
    readonly drafts: Pick<LocalPluginDraftStore, 'list' | 'readComfyAsset'>
    readonly ledger: ComfyPrivateTrialLedger
    readonly approval: ComfyTrialOwnerApproval
    readonly workspaceRoot: string
    readonly outputRoot: string
    readonly fetcher?: typeof fetch
    readonly pollMs?: number
    readonly maxWaitMs?: number
    /** Set only after Host verifies this instance/version has ID-scoped cancellation. */
    readonly supportsIdScopedCancel?: boolean
  }) {
    if (!isAbsolute(options.workspaceRoot) || !isAbsolute(options.outputRoot)
      || options.workspaceRoot === options.outputRoot
      || typeof options.approval.request !== 'function') throw invalid()
  }

  /** Returns metadata only; the private PNG is at an owner-only Host path, never in this receipt. */
  async run(value: PrivateComfyTrialInput): Promise<PrivateComfyTrialReceipt> {
    if (![value.ownerId, value.draftId, value.operationId, value.idempotencyKey].every(item => typeof item === 'string' && ID.test(item))
      || !value.agent || !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535) throw invalid()
    value.signal.throwIfAborted()
    const draft = (await this.options.drafts.list()).find(item => item.id === value.draftId)
    const operation = draft?.spec.operations.find(item => item.id === value.operationId)
    if (!draft || operation?.binding.kind !== 'workflow' || !operation.binding.ref.startsWith('comfy:')) throw invalid()
    const asset = await this.options.drafts.readComfyAsset(value.draftId, value.operationId)
    const output = asset.graph[asset.mapping.outputNodeId]
    if (output?.class_type !== 'SaveImage'
      || Object.values(asset.graph).filter(node => node.class_type === 'SaveImage' || node.class_type === 'SaveImageWebsocket').length !== 1) {
      throw new ComputeError('COMPUTE_COMFY_TRIAL_OUTPUT_UNSUPPORTED', 409)
    }
    const input = parameters(value, asset)
    const inputSha256 = digest(input)
    const fingerprint = digest({ ownerId: value.ownerId, draftId: value.draftId, operationId: value.operationId,
      graphSha256: asset.graphSha256, inputSha256, port: value.port })
    const existing = await this.options.ledger.get(value.idempotencyKey)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ComputeError('COMPUTE_COMFY_TRIAL_KEY_CONFLICT', 409)
      throw new ComputeError('COMPUTE_COMFY_TRIAL_ALREADY_SUBMITTED', 409)
    }
    const preflight = await preflightLocalComfyWorkflow({ workflow: asset.graph, port: value.port },
      value.signal, this.options.fetcher)
    if (preflight.sha256 !== asset.graphSha256 || preflight.nodes.some(node => node.available !== true
      || node.modelFields.some(field => field.selectable !== true))) {
      throw new ComputeError('COMPUTE_COMFY_TRIAL_PREFLIGHT_FAILED', 409)
    }
    // This Host-owned class is the only executor for this trial. No global registry or market declaration is consulted.
    const trialId = randomUUID()
    const promptId = randomUUID()
    const clientId = randomUUID()
    const graph = renderGraph(asset, input, trialId)
    const outcome = await this.options.approval.request({ agent: value.agent,
      toolName: 'comfy_private_trial_execute', callId: value.callId, signal: value.signal,
      reason: `机主 ${value.ownerId} 只在本机运行一次 ComfyUI 私有样例：草稿 ${value.draftId}，操作 ${value.operationId}，图 SHA-256 ${asset.graphSha256}，输入 SHA-256 ${inputSha256}，本机端口 ${value.port}，试跑 ${trialId}。最多一张 PNG；不接单、不扣费、不发布。是否仅批准这一次 GPU 试跑？` })
    if (outcome !== 'allowed-once') throw new ComputeError('COMPUTE_COMFY_TRIAL_OWNER_APPROVAL_REQUIRED', 403)
    value.signal.throwIfAborted()
    const reservation = await this.options.ledger.reserve({ key: value.idempotencyKey, fingerprint,
      trialId, promptId, draftId: value.draftId, operationId: value.operationId,
      graphSha256: asset.graphSha256, inputSha256, ownerId: value.ownerId, port: value.port,
      outputNodeId: asset.mapping.outputNodeId,
      ...(typeof input.width === 'number' ? { requestedWidth: input.width } : {}),
      ...(typeof input.height === 'number' ? { requestedHeight: input.height } : {}) })
    if (!reservation.created) throw new ComputeError('COMPUTE_COMFY_TRIAL_ALREADY_SUBMITTED', 409)
    const backend = new ComfyImageBackend(value.port, this.options.fetcher, this.options.pollMs,
      this.options.maxWaitMs, this.options.supportsIdScopedCancel)
    const executor = new ComfyPrivateSampleExecutor(trialId, inputSha256, graph, promptId, clientId,
      asset.mapping.outputNodeId, backend, this.options.ledger, value.idempotencyKey)
    const privateRegistry = new ComputeExecutorRegistry()
    const unregister = privateRegistry.register(executor)
    let workspace: string | undefined
    this.inFlight.add(trialId)
    try {
      // A dedicated registry cannot substitute another plugin's matching name/version.
      if (privateRegistry.resolve(PRIVATE_CAPABILITY, PRIVATE_VERSION) !== executor
        || privateRegistry.list().length !== 1) throw new ComputeError('COMPUTE_PLUGIN_EXECUTOR_MISMATCH', 409)
      await mkdir(this.options.workspaceRoot, { recursive: true, mode: 0o700 })
      workspace = await mkdtemp(join(this.options.workspaceRoot, 'comfy-trial-'))
      await chmod(workspace, 0o700)
      await this.options.ledger.advance(value.idempotencyKey, ['reserved'], 'sending')
      const task: ComputeTaskEnvelope = { version: 'qianshou.task.v1', taskId: ComputeTaskId(trialId),
        capabilityId: PRIVATE_CAPABILITY, capabilityVersion: PRIVATE_VERSION, parameters: input,
        inputRefs: [], deadlineAt: new Date(Date.now() + 11 * 60_000).toISOString(),
        maxOutputBytes: MAX_IMAGE_BYTES, idempotencyKey: value.idempotencyKey }
      const executed = await privateRegistry.execute(task, { signal: value.signal,
        workspacePath: workspace, inputs: [], interactionPolicy: 'autonomous', reportProgress: () => {} })
      const verified = await verifyTaskOutputs(workspace, executed, MAX_IMAGE_BYTES, value.signal)
      const verifiedOutput = verified.outputs[0]
      if (!verifiedOutput) throw new ComputeError('COMPUTE_COMFY_BACKEND_INVALID', 422)
      const result = { sha256: verifiedOutput.sha256, bytes: verifiedOutput.bytes,
        width: Number(executed.metadata?.width), height: Number(executed.metadata?.height) }
      await this.persistResult(trialId, verifiedOutput.path, result)
      await this.options.ledger.advance(value.idempotencyKey, ['queued'], 'completed', result)
      return { trialId, status: 'completed', graphSha256: asset.graphSha256,
        result, installable: false, dispatchable: false }
    } catch (error) {
      await this.recordFailure(value.idempotencyKey, backend, promptId, error)
      throw error
    } finally {
      this.inFlight.delete(trialId)
      unregister()
      if (workspace) await rm(workspace, { recursive: true, force: true })
    }
  }

  /** Reconcile the exact durable prompt after restart, without approval reuse or another /prompt. */
  async reconcile(trialId: string, ownerId: string, signal: AbortSignal): Promise<PrivateComfyTrialReconciliation> {
    if (!TRIAL_ID.test(trialId) || !ID.test(ownerId)) throw invalid()
    signal.throwIfAborted()
    const record = await this.options.ledger.getByTrialId(trialId)
    if (record?.ownerId !== ownerId) throw new ComputeError('COMPUTE_COMFY_TRIAL_RESULT_UNAVAILABLE', 404)
    const base = { trialId, installable: false, dispatchable: false } as const
    if (record.status === 'completed' && record.result) {
      await this.readImage(trialId, ownerId)
      return { ...base, status: 'completed', result: record.result }
    }
    if (record.status === 'rejected') return { ...base, status: 'rejected' }
    if (this.inFlight.has(trialId) || record.status === 'reserved' || !record.outputNodeId) {
      return { ...base, status: 'pending' }
    }
    const backend = new ComfyImageBackend(record.port, this.options.fetcher, this.options.pollMs,
      this.options.maxWaitMs, this.options.supportsIdScopedCancel)
    const history = await backend.inspectHistory(record.promptId, record.outputNodeId, signal)
    if (history.status === 'pending') return { ...base, status: 'pending' }
    if (history.status === 'failed') {
      await this.options.ledger.advance(record.key,
        ['sending', 'queued', 'submission-unknown', 'cancel-uncertain'], 'rejected')
      return { ...base, status: 'rejected' }
    }
    await mkdir(this.options.workspaceRoot, { recursive: true, mode: 0o700 })
    const workspace = await mkdtemp(join(this.options.workspaceRoot, 'comfy-reconcile-'))
    await chmod(workspace, 0o700)
    try {
      const downloaded = await backend.download(history.image, workspace, signal)
      if ((record.requestedWidth !== undefined && downloaded.width !== record.requestedWidth)
        || (record.requestedHeight !== undefined && downloaded.height !== record.requestedHeight)) {
        throw new ComputeError('COMPUTE_COMFY_TRIAL_DIMENSION_MISMATCH', 422)
      }
      const verified = await verifyTaskOutputs(workspace, { outputs: [downloaded.output] }, MAX_IMAGE_BYTES, signal)
      const image = verified.outputs[0]
      if (!image) throw new ComputeError('COMPUTE_COMFY_BACKEND_INVALID', 422)
      const result = { sha256: image.sha256, bytes: image.bytes,
        width: downloaded.width, height: downloaded.height }
      await this.persistResult(trialId, image.path, result)
      await this.options.ledger.advance(record.key,
        ['sending', 'queued', 'submission-unknown', 'cancel-uncertain'], 'completed', result)
      return { ...base, status: 'completed', result }
    } finally { await rm(workspace, { recursive: true, force: true }) }
  }

  /** Show owner-local trial IDs for recovery without disclosing graph, prompt or Comfy transport ID. */
  recent(ownerId: string) { return this.options.ledger.recent(ownerId) }

  /** Read one completed private image by opaque trial ID for the authenticated local UI. */
  async readImage(trialId: string, ownerId: string): Promise<Buffer> {
    if (!TRIAL_ID.test(trialId) || !ID.test(ownerId)) throw invalid()
    const record = await this.options.ledger.getByTrialId(trialId)
    if (record?.ownerId !== ownerId || record.status !== 'completed' || record.result === undefined) {
      throw new ComputeError('COMPUTE_COMFY_TRIAL_RESULT_UNAVAILABLE', 404)
    }
    let file
    try { file = await open(join(this.options.outputRoot, `${trialId}.png`), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ComputeError('COMPUTE_COMFY_TRIAL_RESULT_UNAVAILABLE', 404)
      }
      throw new ComputeError('COMPUTE_OUTPUT_FILE_INVALID', 422)
    }
    try {
      const metadata = await file.stat()
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== record.result.bytes
        || metadata.size > MAX_IMAGE_BYTES) throw new ComputeError('COMPUTE_OUTPUT_FILE_INVALID', 422)
      const bytes = await file.readFile()
      if (bytes.length !== record.result.bytes
        || createHash('sha256').update(bytes).digest('hex') !== record.result.sha256) {
        throw new ComputeError('COMPUTE_OUTPUT_FILE_CHANGED', 422)
      }
      return bytes
    } finally { await file.close() }
  }

  /** Treat ambiguous transport/timeout/cancellation as active until the exact prompt is reconciled. */
  private async recordFailure(key: string, backend: ComfyImageBackend, promptId: string, error: unknown): Promise<void> {
    const record = await this.options.ledger.get(key)
    if (!record) return
    if (record.status === 'reserved') {
      await this.options.ledger.advance(key, ['reserved'], 'rejected')
    } else if (record.status === 'sending') {
      await this.options.ledger.advance(key, ['sending'],
        error instanceof ComputeError && error.code === 'COMPUTE_COMFY_PROMPT_REJECTED' ? 'rejected' : 'submission-unknown')
    } else if (record.status === 'queued') {
      if (error instanceof ComputeError && ['COMPUTE_COMFY_EXECUTION_FAILED', 'COMPUTE_COMFY_BACKEND_INVALID',
        'COMPUTE_COMFY_PNG_INVALID', 'COMPUTE_COMFY_TRIAL_DIMENSION_MISMATCH'].includes(error.code)) {
        await this.options.ledger.advance(key, ['queued'], 'rejected')
      } else {
        await backend.cancelById(promptId)
        await this.options.ledger.advance(key, ['queued'], 'cancel-uncertain')
      }
    }
  }

  private async persistResult(trialId: string, sourcePath: string, result: ComfyTrialResult): Promise<void> {
    await mkdir(this.options.outputRoot, { recursive: true, mode: 0o700 })
    const bytes = await readFile(sourcePath)
    if (bytes.length !== result.bytes || createHash('sha256').update(bytes).digest('hex') !== result.sha256) {
      throw new ComputeError('COMPUTE_OUTPUT_FILE_CHANGED', 422)
    }
    const path = join(this.options.outputRoot, `${trialId}.png`)
    let file
    try { file = await open(path, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const metadata = await existing.stat()
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== result.bytes
          || createHash('sha256').update(await existing.readFile()).digest('hex') !== result.sha256) {
          throw new ComputeError('COMPUTE_OUTPUT_FILE_CHANGED', 422)
        }
      } finally { await existing.close() }
      return
    }
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    if ((await stat(path)).size !== result.bytes) throw new ComputeError('COMPUTE_OUTPUT_FILE_CHANGED', 422)
  }
}
