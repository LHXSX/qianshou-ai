/** Host-only bridge from a reviewed private video graph to one already started resident attempt. */
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { comfyVideoPublicContractDigest, verifyComfyVideoPublicGraph,
  type ComfyVideoPublicContract } from '@deepseek-ai/dsh-compute-core/comfy-video-public-contract'
import type { ComfyVideoAttemptLedger } from '@deepseek-ai/dsh-compute-core/src/comfy-video-attempt-ledger.ts'
import type { VideoWorkflowDraftStore, VideoWorkflowDraftMapping } from '@deepseek-ai/dsh-compute-core/src/video-workflow-draft.ts'
import type { ComputeResidentAttemptExecution } from '@deepseek-ai/dsh-compute-core/resident'
import { runComfyVideoLocally, type ComfyVideoLocalResult, type ComfyVideoRunDependencies,
  type ComfyVideoRunInput } from './comfy-video-runner.ts'

const HASH = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u

/** Platform-owned, currently approved publication identity; never inferred from a local draft. */
export interface ReviewedComfyVideoPublication {
  readonly publicationId: string
  readonly ownerAccountId: number
  readonly taskType: string
  readonly artifactDigest: string
  readonly contractSha256: string
  readonly approvedContractDigest: string
  readonly status: 'approved'
}

/** These values must come from an installed package independently approved for this owner and task type. */
export interface ReviewedComfyVideoInstallation {
  readonly ownerAccountId: number
  readonly publicationId: string
  readonly artifactDigest: string
  readonly contractSha256: string
  readonly draftId: string
  readonly graphSha256: string
  readonly publicContract: ComfyVideoPublicContract
  readonly approvedContractDigest: string
  readonly packageDigest: string
  readonly dependencyManifestSha256: string
  readonly runnerSourceSha256: string
  readonly allowedClassTypes: readonly string[]
  readonly capabilityVersion: string
}

/** Exact loopback service and executable selected by the trusted Host for this attempt. */
export interface ComfyVideoRuntimeSelection {
  readonly port: number
  readonly ffprobePath: string
}

/** Host-owned services; none is supplied by the buyer's task parameters or a browser route. */
export interface ResidentComfyVideoBridgePorts {
  readonly drafts: Pick<VideoWorkflowDraftStore, 'readPrivate'>
  /** Windows supplies the recovered SQLite ledger; the POSIX file ledger retains its Win32 refusal. */
  readonly ledger: Pick<ComfyVideoAttemptLedger, 'reserve' | 'assertReserved' | 'beforePromptSubmit'
    | 'recordPromptId' | 'recordLocalResult'>
  /** Re-read the installed, reviewed bytes and current ownership before every irreversible step. */
  readonly readCurrentInstallation: () => Promise<ReviewedComfyVideoInstallation | null>
  /** Independently read the current platform review; a local install is not approval. */
  readonly readCurrentPublication: (publicationId: string,
    signal: AbortSignal) => Promise<ReviewedComfyVideoPublication | null>
  /** Match this exact publication to the authenticated, signed order and current worker lease. */
  readonly assertOrderPublication: (execution: ComputeResidentAttemptExecution,
    publication: ReviewedComfyVideoPublication, signal: AbortSignal) => Promise<void>
  /** Compare the authenticated account with the signed order and current worker lease. */
  readonly assertOrderOwnership: (execution: ComputeResidentAttemptExecution, ownerAccountId: number,
    signal: AbortSignal) => Promise<void>
  /** Match the supplied values and staged media digests to the signed task form and lease. */
  readonly assertTaskValues: (execution: ComputeResidentAttemptExecution, values: ComfyVideoRunInput['values'],
    signal: AbortSignal) => Promise<void>
  /** Confirm actual Comfy/ffprobe process identity, dependencies and local resource admission. */
  readonly assertRuntimeCurrent: (selection: ComfyVideoRuntimeSelection, signal: AbortSignal) => Promise<void>
  /** Serialize this execution with existing H3 trials and other GPU owners on the same host. */
  readonly withGpuReservation: <T>(selection: ComfyVideoRuntimeSelection,
    execution: ComputeResidentAttemptExecution, operation: () => Promise<T>) => Promise<T>
}

/** Inputs already staged by the accepted resident task and an authorized media transfer provider. */
export interface ResidentComfyVideoBridgeInput {
  /** Authenticated owner identity from the Host session, not task parameters. */
  readonly ownerAccountId: number
  readonly execution: ComputeResidentAttemptExecution
  readonly reviewed: ReviewedComfyVideoInstallation
  readonly values: ComfyVideoRunInput['values']
  readonly port: number
  readonly workspacePath: string
  readonly ffprobePath: string
}

function invalid(): never { throw new ComputeError('COMPUTE_COMFY_VIDEO_REVIEW_BINDING_INVALID', 409) }
function sameReview(expected: ReviewedComfyVideoInstallation, actual: ReviewedComfyVideoInstallation | null): void {
  if (actual === null || expected.ownerAccountId !== actual.ownerAccountId
    || expected.publicationId !== actual.publicationId
    || expected.artifactDigest !== actual.artifactDigest
    || expected.contractSha256 !== actual.contractSha256
    || expected.draftId !== actual.draftId || expected.graphSha256 !== actual.graphSha256
    || expected.approvedContractDigest !== actual.approvedContractDigest
    || expected.packageDigest !== actual.packageDigest
    || expected.dependencyManifestSha256 !== actual.dependencyManifestSha256
    || expected.runnerSourceSha256 !== actual.runnerSourceSha256
    || expected.capabilityVersion !== actual.capabilityVersion
    || expected.allowedClassTypes.length !== actual.allowedClassTypes.length
    || expected.allowedClassTypes.some((name, index) => name !== actual.allowedClassTypes[index])
    || comfyVideoPublicContractDigest(actual.publicContract) !== expected.approvedContractDigest) invalid()
}
function samePublication(installation: ReviewedComfyVideoInstallation,
  publication: ReviewedComfyVideoPublication | null): asserts publication is ReviewedComfyVideoPublication {
  if (publication === null || publication.status !== 'approved'
    || publication.publicationId !== installation.publicationId
    || publication.ownerAccountId !== installation.ownerAccountId
    || publication.taskType !== installation.publicContract.taskType
    || publication.artifactDigest !== installation.artifactDigest
    || publication.contractSha256 !== installation.contractSha256
    || publication.approvedContractDigest !== installation.approvedContractDigest) invalid()
}
function mapped(ref: { nodeId: string; field: string }, contract: ComfyVideoPublicContract,
  kind: 'text' | 'integer' | 'artifact_ref'): boolean {
  return contract.inputSlots.some(slot => slot.kind === kind && slot.nodeId === ref.nodeId && slot.field === ref.field)
}
function mappingMatches(mapping: VideoWorkflowDraftMapping, contract: ComfyVideoPublicContract): void {
  if (mapping.outputNodeId !== contract.outputs[0].nodeId || !mapped(mapping.prompt, contract, 'text')
    || mapping.referenceImage !== undefined && !mapped(mapping.referenceImage, contract, 'artifact_ref')
    || mapping.frames !== undefined && !mapped(mapping.frames, contract, 'integer')) invalid()
}

/** Enter one private Comfy execution only through existing resident lease and Host GPU admission.
 * @param input - Accepted resident execution, reviewed package and Host-staged task values.
 * @param ports - Owner-private draft, durable reservation and independently verified runtime services.
 * @param dependencies - Deterministic local transport seams for tests.
 * @returns Locally verified MP4; the resident result channel must still upload and settle it.
 */
export async function runResidentComfyVideoAttempt(input: ResidentComfyVideoBridgeInput,
  ports: ResidentComfyVideoBridgePorts,
  dependencies: ComfyVideoRunDependencies = {}): Promise<ComfyVideoLocalResult> {
  const { execution, reviewed } = input
  execution.signal.throwIfAborted()
  const rawTask = execution.task as unknown as Record<string, unknown>
  const parameters = execution.task.parameters
  const now = Date.now()
  const taskDeadline = Date.parse(execution.task.deadlineAt)
  const leaseDeadline = Date.parse(execution.attempt.leaseExpiresAt)
  if (!Number.isSafeInteger(input.ownerAccountId) || input.ownerAccountId < 1
    || input.ownerAccountId !== reviewed.ownerAccountId
    || rawTask.version !== 'qianshou.task.v1'
    || execution.task.taskId !== execution.attempt.taskId
    || execution.task.idempotencyKey !== execution.attempt.idempotencyKey
    || !Number.isFinite(taskDeadline) || taskDeadline <= now
    || !Number.isFinite(leaseDeadline) || leaseDeadline <= now
    || !Number.isSafeInteger(execution.task.maxOutputBytes)
    || execution.task.maxOutputBytes < reviewed.publicContract.limits.maxOutputBytes
    || parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)
    || (parameters as Record<string, unknown>).taskType !== reviewed.publicContract.taskType
    || execution.task.capabilityId !== reviewed.publicContract.capabilityId
    || execution.task.capabilityVersion !== reviewed.capabilityVersion
    || execution.attempt.capabilityId !== execution.task.capabilityId
    || execution.attempt.capabilityVersion !== execution.task.capabilityVersion
    || execution.attempt.capabilityPluginDigest !== reviewed.packageDigest
    || !UUID.test(reviewed.publicationId)
    || !DIGEST.test(reviewed.artifactDigest) || !DIGEST.test(reviewed.contractSha256)
    || !HASH.test(reviewed.packageDigest) || !HASH.test(reviewed.graphSha256)
    || !DIGEST.test(reviewed.approvedContractDigest)
    || !HASH.test(reviewed.dependencyManifestSha256) || !HASH.test(reviewed.runnerSourceSha256)
    || comfyVideoPublicContractDigest(reviewed.publicContract) !== reviewed.approvedContractDigest
    || reviewed.publicContract.graph.sha256 !== reviewed.graphSha256
    || reviewed.publicContract.dependencyManifestSha256 !== reviewed.dependencyManifestSha256
    || reviewed.publicContract.runner.sourceSha256 !== reviewed.runnerSourceSha256) invalid()
  const draft = await ports.drafts.readPrivate(reviewed.draftId, reviewed.graphSha256)
  verifyComfyVideoPublicGraph(reviewed.publicContract, JSON.parse(draft.graphJson) as unknown)
  mappingMatches(draft.mapping, reviewed.publicContract)
  const selection: ComfyVideoRuntimeSelection = { port: input.port, ffprobePath: input.ffprobePath }
  const assertCurrent = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    if (Date.now() >= Math.min(taskDeadline, leaseDeadline)) invalid()
    sameReview(reviewed, await ports.readCurrentInstallation())
    const publication = await ports.readCurrentPublication(reviewed.publicationId, signal)
    samePublication(reviewed, publication)
    await ports.assertOrderPublication(execution, publication, signal)
    const currentDraft = await ports.drafts.readPrivate(reviewed.draftId, reviewed.graphSha256)
    if (currentDraft.graphJson !== draft.graphJson) invalid()
    await ports.assertOrderOwnership(execution, input.ownerAccountId, signal)
    await ports.assertTaskValues(execution, input.values, signal)
    await ports.assertRuntimeCurrent(selection, signal)
    signal.throwIfAborted()
  }
  // Reject a withdrawn publication or mismatched signed order before reserving the GPU.
  // Recheck under the reservation and immediately before the sole /prompt to close the race.
  await assertCurrent(execution.signal)
  return ports.withGpuReservation(selection, execution, async () => {
    execution.signal.throwIfAborted()
    await assertCurrent(execution.signal)
    const reserved = await ports.ledger.reserve(execution.attempt, reviewed.approvedContractDigest, reviewed.graphSha256)
    const result = await runComfyVideoLocally({ admission: {
      publicContract: reviewed.publicContract, privateGraphJson: draft.graphJson,
      approvedContractDigest: reviewed.approvedContractDigest,
      approvedDependencyManifestSha256: reviewed.dependencyManifestSha256,
      approvedRunnerSourceSha256: reviewed.runnerSourceSha256,
      allowedClassTypes: reviewed.allowedClassTypes, attemptId: reserved.attemptId,
      assertReserved: async (signal) => { signal.throwIfAborted(); await ports.ledger.assertReserved(reserved) },
      beforePromptSubmit: async (signal) => {
        signal.throwIfAborted()
        await assertCurrent(signal)
        await ports.ledger.beforePromptSubmit(reserved)
      },
      recordPromptId: async (promptId, signal) => { signal.throwIfAborted(); await ports.ledger.recordPromptId(reserved, promptId) },
      assertCurrent,
    }, values: input.values, port: input.port, workspacePath: input.workspacePath,
    ffprobePath: input.ffprobePath, signal: execution.signal }, dependencies)
    if (result.bytes > execution.task.maxOutputBytes) invalid()
    await ports.ledger.recordLocalResult(reserved, result.sha256)
    return result
  })
}
