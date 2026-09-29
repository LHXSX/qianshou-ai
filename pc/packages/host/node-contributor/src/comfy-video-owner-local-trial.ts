/** Host-only, owner-approved local Comfy video trial. It never publishes or accepts an order. */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { canonicalComfyVideoApiGraphJson, comfyVideoPublicContractDigest,
  verifyComfyVideoPublicGraph, type ComfyVideoPublicContract,
} from '@deepseek-ai/dsh-compute-core/comfy-video-public-contract'
import type { ComfyVideoLocalTrialLedger } from '@deepseek-ai/dsh-compute-core/src/comfy-video-local-trial-ledger.ts'
import { runComfyVideoLocally, type ComfyVideoLocalResult, type ComfyVideoRunDependencies,
  type ComfyVideoRunInput } from './comfy-video-runner.ts'

const HASH = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9._:-]{1,128}$/u
const CLASS = /^[A-Za-z][A-Za-z0-9_:. -]{0,95}$/u
const MAX_APPROVAL_AGE_MS = 10 * 60_000

/** Authenticated Host owner and independently chosen local trial, never buyer JSON. */
export interface OwnerLocalVideoTrialIdentity {
  readonly ownerId: string
  readonly profileId: string
  readonly trialKey: string
}

/** Private, revisioned owner review of one immutable API graph and public declaration. */
export interface OwnerReviewedComfyVideoGraph {
  readonly schema: 'qianshou.comfy-video-owner-review.v1'
  readonly ownerId: string
  readonly profileId: string
  readonly reviewEvidenceSha256: string
  readonly privateGraphJson: string
  readonly publicContract: unknown
  readonly allowedClassTypes: readonly string[]
}

/** Exact local process and executable selection made by the trusted Host. */
export interface OwnerLocalComfyVideoRuntime {
  readonly port: number
  readonly ffprobePath: string
  readonly workspacePath: string
}

/** The provider must measure running processes and Comfy's loaded-model generation, not disk stats. */
export interface OwnerLocalComfyVideoRuntimeWitness {
  readonly schema: 'qianshou.comfy-video-owner-runtime.v1'
  readonly hostPid: number
  readonly hostStartedAt: string
  readonly comfyPid: number
  readonly comfyStartedAt: string
  readonly dependencyManifestSha256: string
  readonly runnerSourceSha256: string
  readonly classOriginsSha256: string
  readonly modelFilesSha256: string
  readonly loadedModelGenerationSha256: string
  readonly ffmpegSha256: string
  readonly ffprobeSha256: string
}

/** Values shown to and atomically approved by the current authenticated owner. */
export interface OwnerLocalComfyVideoApprovalRequest extends OwnerLocalVideoTrialIdentity {
  readonly reviewEvidenceSha256: string
  readonly graphSha256: string
  readonly contractDigest: string
  readonly runtimeWitnessSha256: string
  readonly inputSha256: string
}

/** Host-owned proof of one consumed local UI approval; no platform review is implied. */
export interface OwnerLocalComfyVideoApproval extends OwnerLocalComfyVideoApprovalRequest {
  readonly schema: 'qianshou.comfy-video-owner-approval.v1'
  readonly approvalSha256: string
  readonly expiresAt: string
}

/** The adapter must hold Comfy's queue lock while checking this witness and sending one /prompt. */
export interface OwnerLocalAtomicComfyPromptRequest {
  readonly port: number
  readonly attemptId: string
  readonly body: string
  readonly expectedRuntimeWitnessSha256: string
  readonly expectedComfyPid: number
  readonly expectedLoadedModelGenerationSha256: string
  readonly signal: AbortSignal
}

/** Returned only after the adapter atomically checked actual process/model identity and POSTed. */
export interface OwnerLocalAtomicComfyPromptResult {
  readonly response: Response
  readonly actualRuntimeWitnessSha256: string
  readonly actualComfyPid: number
  readonly actualLoadedModelGenerationSha256: string
}

/** Privileged ports must be supplied by the authenticated desktop Host, never a browser request. */
export interface OwnerLocalComfyVideoTrialPorts {
  readonly ledger: Pick<ComfyVideoLocalTrialLedger, 'recoverAtStartup' | 'reserve' | 'assertReserved'
    | 'beforePromptSubmit' | 'recordPromptId' | 'recordLocalResult' | 'latest' | 'abandonReserved'>
  readonly readAuthenticatedOwner: (signal: AbortSignal) => Promise<Pick<OwnerLocalVideoTrialIdentity,
    'ownerId' | 'profileId'>>
  readonly readCurrentReview: (owner: Pick<OwnerLocalVideoTrialIdentity, 'ownerId' | 'profileId'>,
    signal: AbortSignal) => Promise<OwnerReviewedComfyVideoGraph | null>
  readonly selectRuntime: (signal: AbortSignal) => Promise<OwnerLocalComfyVideoRuntime>
  /** Observe the selected Comfy process, code, model loader generation and both ffmpeg binaries. */
  readonly readActualRuntimeWitness: (runtime: OwnerLocalComfyVideoRuntime,
    signal: AbortSignal) => Promise<OwnerLocalComfyVideoRuntimeWitness>
  /** Refuse on OFF, paused, active/unknown H3 work, other GPU claims or a changed owner session. */
  readonly assertSharedH3Admission: (runtime: OwnerLocalComfyVideoRuntime,
    signal: AbortSignal) => Promise<void>
  /** Atomically consume a fresh one-time approval from the current owner UI. */
  readonly consumeOneTimeOwnerApproval: (request: OwnerLocalComfyVideoApprovalRequest,
    signal: AbortSignal) => Promise<OwnerLocalComfyVideoApproval | null>
  /** Revalidate the consumed approval and owner session; never consume it a second time. */
  readonly assertConsumedApprovalCurrent: (approval: OwnerLocalComfyVideoApproval,
    signal: AbortSignal) => Promise<void>
  /** No direct Comfy POST fallback exists. No production implementation is currently connected. */
  readonly submitPromptWithExpectedWitness: (request: OwnerLocalAtomicComfyPromptRequest)
  => Promise<OwnerLocalAtomicComfyPromptResult>
  /** Hold the same GPU reservation as existing H3 trials through output verification. */
  readonly withSharedH3GpuReservation: <T>(runtime: OwnerLocalComfyVideoRuntime,
    signal: AbortSignal, operation: () => Promise<T>) => Promise<T>
}

/** Private Host input. Its values are copied before approval so a later mutation cannot change the run. */
export interface OwnerLocalComfyVideoTrialInput {
  readonly trialKey: string
  readonly values: ComfyVideoRunInput['values']
  readonly signal: AbortSignal
}

/** Local-only result; its path must stay on this device and is not an Edge artifact or review receipt. */
export interface OwnerLocalComfyVideoTrialResult {
  readonly schema: 'qianshou.comfy-video-owner-local-result.v1'
  readonly platformReady: false
  readonly attemptId: string
  readonly graphSha256: string
  readonly contractDigest: string
  readonly runtimeWitnessSha256: string
  readonly privateResult: ComfyVideoLocalResult
}

interface FrozenReview {
  readonly ownerId: string
  readonly profileId: string
  readonly reviewEvidenceSha256: string
  readonly privateGraphJson: string
  readonly publicContract: ComfyVideoPublicContract
  readonly contractDigest: string
  readonly allowedClassTypes: readonly string[]
}

function invalid(code: string, status = 409): never { throw new ComputeError(code, status) }
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function owner(value: Pick<OwnerLocalVideoTrialIdentity, 'ownerId' | 'profileId'>): void {
  if (!ID.test(value.ownerId) || !ID.test(value.profileId)) invalid('COMPUTE_COMFY_VIDEO_LOCAL_OWNER_INVALID')
}
function freezeReview(raw: OwnerReviewedComfyVideoGraph | null,
  identity: Pick<OwnerLocalVideoTrialIdentity, 'ownerId' | 'profileId'>): FrozenReview {
  if (raw?.schema !== 'qianshou.comfy-video-owner-review.v1'
    || raw.ownerId !== identity.ownerId || raw.profileId !== identity.profileId
    || !HASH.test(raw.reviewEvidenceSha256) || typeof raw.privateGraphJson !== 'string'
    || !Array.isArray(raw.allowedClassTypes)) invalid('COMPUTE_COMFY_VIDEO_LOCAL_REVIEW_INVALID')
  let graph: unknown
  try { graph = JSON.parse(raw.privateGraphJson) as unknown }
  catch { invalid('COMPUTE_COMFY_VIDEO_LOCAL_REVIEW_INVALID') }
  if (canonicalComfyVideoApiGraphJson(graph) !== raw.privateGraphJson) {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_REVIEW_INVALID')
  }
  const contract = verifyComfyVideoPublicGraph(raw.publicContract, graph)
  const classes = Object.values(graph as Record<string, { class_type: string }>)
    .map(node => node.class_type).sort()
  const allowed = [...raw.allowedClassTypes].sort()
  if (allowed.length !== new Set(allowed).size || allowed.some(name => !CLASS.test(name))
    || new Set(classes).size !== allowed.length
    || [...new Set(classes)].some((name, index) => name !== allowed[index])) {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_REVIEW_INVALID')
  }
  return Object.freeze({ ownerId: raw.ownerId, profileId: raw.profileId,
    reviewEvidenceSha256: raw.reviewEvidenceSha256, privateGraphJson: raw.privateGraphJson,
    publicContract: contract, contractDigest: comfyVideoPublicContractDigest(contract),
    allowedClassTypes: Object.freeze(allowed) })
}
function sameReview(expected: FrozenReview, actual: FrozenReview): void {
  if (actual.ownerId !== expected.ownerId || actual.profileId !== expected.profileId
    || actual.reviewEvidenceSha256 !== expected.reviewEvidenceSha256
    || actual.privateGraphJson !== expected.privateGraphJson
    || actual.contractDigest !== expected.contractDigest
    || actual.allowedClassTypes.length !== expected.allowedClassTypes.length
    || actual.allowedClassTypes.some((name, index) => name !== expected.allowedClassTypes[index])) {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_REVIEW_CHANGED')
  }
}
function snapshotValues(values: ComfyVideoRunInput['values'], contract: ComfyVideoPublicContract): {
  values: ComfyVideoRunInput['values']
  inputSha256: string
} {
  if (values === null || typeof values !== 'object' || Array.isArray(values)
    || Object.keys(values).length !== contract.inputSlots.length) {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_INPUT_INVALID')
  }
  const copied: Record<string, ComfyVideoRunInput['values'][string]> = {}
  const fingerprint: unknown[] = []
  for (const slot of contract.inputSlots) {
    if (!Object.hasOwn(values, slot.name)) invalid('COMPUTE_COMFY_VIDEO_LOCAL_INPUT_INVALID')
    const value = values[slot.name]
    if (slot.kind === 'text') {
      if (typeof value !== 'string' || !value.isWellFormed()
        || Buffer.byteLength(value, 'utf8') > slot.maxUtf8Bytes) {
        invalid('COMPUTE_COMFY_VIDEO_LOCAL_INPUT_INVALID')
      }
      copied[slot.name] = value
      fingerprint.push([slot.name, 'text', value])
    } else if (slot.kind === 'integer') {
      if (!Number.isSafeInteger(value) || (value as number) < slot.min || (value as number) > slot.max) {
        invalid('COMPUTE_COMFY_VIDEO_LOCAL_INPUT_INVALID')
      }
      copied[slot.name] = value as number
      fingerprint.push([slot.name, 'integer', value as number])
    } else {
      if (value === null || typeof value !== 'object' || !('bytes' in value)
        || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 8
        || value.bytes.byteLength > Math.min(slot.maxBytes, 16 * 1024 * 1024)
        || value.mimeType !== slot.mimeType || !HASH.test(value.sha256)) {
        invalid('COMPUTE_COMFY_VIDEO_LOCAL_INPUT_INVALID')
      }
      const bytes = Buffer.from(value.bytes)
      if (sha256(bytes) !== value.sha256) invalid('COMPUTE_COMFY_VIDEO_LOCAL_INPUT_INVALID')
      copied[slot.name] = Object.freeze({ mimeType: value.mimeType, sha256: value.sha256, bytes })
      fingerprint.push([slot.name, 'artifact_ref', value.mimeType, value.sha256, bytes.length])
    }
  }
  return { values: Object.freeze(copied), inputSha256: sha256(JSON.stringify(fingerprint)) }
}
function runtime(value: OwnerLocalComfyVideoRuntime): OwnerLocalComfyVideoRuntime {
  if (!Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535
    || !isAbsolute(value.ffprobePath) || !isAbsolute(value.workspacePath)) {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_RUNTIME_INVALID', 503)
  }
  return Object.freeze({ port: value.port, ffprobePath: value.ffprobePath,
    workspacePath: value.workspacePath })
}
function sameRuntime(expected: OwnerLocalComfyVideoRuntime, actual: OwnerLocalComfyVideoRuntime): void {
  if (actual.port !== expected.port || actual.ffprobePath !== expected.ffprobePath
    || actual.workspacePath !== expected.workspacePath) {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_RUNTIME_CHANGED')
  }
}
function witness(raw: OwnerLocalComfyVideoRuntimeWitness, review: FrozenReview): string {
  if (raw?.schema !== 'qianshou.comfy-video-owner-runtime.v1'
    || raw.hostPid !== process.pid || !Number.isSafeInteger(raw.comfyPid) || raw.comfyPid < 1
    || raw.comfyPid === raw.hostPid
    || !Number.isFinite(Date.parse(raw.hostStartedAt))
    || !Number.isFinite(Date.parse(raw.comfyStartedAt))
    || raw.dependencyManifestSha256 !== review.publicContract.dependencyManifestSha256
    || raw.runnerSourceSha256 !== review.publicContract.runner.sourceSha256
    || !HASH.test(raw.classOriginsSha256) || !HASH.test(raw.modelFilesSha256)
    || !HASH.test(raw.loadedModelGenerationSha256)
    || !HASH.test(raw.ffmpegSha256) || !HASH.test(raw.ffprobeSha256)) {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_WITNESS_INVALID', 503)
  }
  const stable = { schema: raw.schema, hostPid: raw.hostPid, hostStartedAt: raw.hostStartedAt,
    comfyPid: raw.comfyPid, comfyStartedAt: raw.comfyStartedAt,
    dependencyManifestSha256: raw.dependencyManifestSha256,
    runnerSourceSha256: raw.runnerSourceSha256, classOriginsSha256: raw.classOriginsSha256,
    modelFilesSha256: raw.modelFilesSha256,
    loadedModelGenerationSha256: raw.loadedModelGenerationSha256,
    ffmpegSha256: raw.ffmpegSha256, ffprobeSha256: raw.ffprobeSha256 }
  return sha256(JSON.stringify(stable))
}
function exactApproval(request: OwnerLocalComfyVideoApprovalRequest,
  approval: OwnerLocalComfyVideoApproval | null): asserts approval is OwnerLocalComfyVideoApproval {
  const deadline = Date.parse(approval?.expiresAt ?? '')
  if (approval?.schema !== 'qianshou.comfy-video-owner-approval.v1'
    || !HASH.test(approval.approvalSha256) || !Number.isFinite(deadline)
    || deadline <= Date.now() || deadline > Date.now() + MAX_APPROVAL_AGE_MS
    || approval.ownerId !== request.ownerId || approval.profileId !== request.profileId
    || approval.trialKey !== request.trialKey
    || approval.reviewEvidenceSha256 !== request.reviewEvidenceSha256
    || approval.graphSha256 !== request.graphSha256
    || approval.contractDigest !== request.contractDigest
    || approval.runtimeWitnessSha256 !== request.runtimeWitnessSha256
    || approval.inputSha256 !== request.inputSha256) {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_APPROVAL_REQUIRED')
  }
}

/** Run one owner-approved local trial under the existing H3 GPU and unknown-work admission.
 * The Host must bind every port to its authenticated local owner session and durable review. This
 * source module has no production Host registration, Edge offer route, publication or billing path.
 * @param input - Fresh owner trial key and values; never an accepted market assignment.
 * @param ports - Current Host owner, approval, runtime, H3 admission and one-shot NTFS journal.
 * @param dependencies - Local transport and ffprobe test seams; production uses the defaults.
 * @returns One private MP4 receipt with platformReady fixed false.
 */
export async function runOwnerPrivateComfyVideoTrial(input: OwnerLocalComfyVideoTrialInput,
  ports: OwnerLocalComfyVideoTrialPorts,
  dependencies: ComfyVideoRunDependencies = {}): Promise<OwnerLocalComfyVideoTrialResult> {
  input.signal.throwIfAborted()
  if (!ID.test(input.trialKey)) invalid('COMPUTE_COMFY_VIDEO_LOCAL_INPUT_INVALID')
  if (typeof ports.submitPromptWithExpectedWitness !== 'function') {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_ATOMIC_SUBMIT_UNAVAILABLE', 503)
  }
  const authenticated = await ports.readAuthenticatedOwner(input.signal)
  owner(authenticated)
  const identity = Object.freeze({ ...authenticated, trialKey: input.trialKey })
  const review = freezeReview(await ports.readCurrentReview(identity, input.signal), identity)
  const copied = snapshotValues(input.values, review.publicContract)
  const selection = runtime(await ports.selectRuntime(input.signal))
  const initialWitness = await ports.readActualRuntimeWitness(selection, input.signal)
  const runtimeWitnessSha256 = witness(initialWitness, review)
  const recovered = await ports.ledger.recoverAtStartup()
  if (recovered.state === 'unknown' || recovered.state === 'unspent') {
    invalid('COMPUTE_COMFY_VIDEO_LOCAL_PREVIOUS_ATTEMPT_UNRESOLVED')
  }
  await ports.assertSharedH3Admission(selection, input.signal)
  const request: OwnerLocalComfyVideoApprovalRequest = Object.freeze({ ...identity,
    reviewEvidenceSha256: review.reviewEvidenceSha256,
    graphSha256: review.publicContract.graph.sha256, contractDigest: review.contractDigest,
    runtimeWitnessSha256, inputSha256: copied.inputSha256 })
  const approval = await ports.consumeOneTimeOwnerApproval(request, input.signal)
  exactApproval(request, approval)

  const assertCurrent = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    const currentOwner = await ports.readAuthenticatedOwner(signal)
    owner(currentOwner)
    if (currentOwner.ownerId !== identity.ownerId || currentOwner.profileId !== identity.profileId) {
      invalid('COMPUTE_COMFY_VIDEO_LOCAL_OWNER_CHANGED')
    }
    sameReview(review, freezeReview(await ports.readCurrentReview(identity, signal), identity))
    const currentRuntime = runtime(await ports.selectRuntime(signal))
    sameRuntime(selection, currentRuntime)
    if (witness(await ports.readActualRuntimeWitness(selection, signal), review) !== runtimeWitnessSha256) {
      invalid('COMPUTE_COMFY_VIDEO_LOCAL_RUNTIME_CHANGED')
    }
    await ports.assertConsumedApprovalCurrent(approval, signal)
    await ports.assertSharedH3Admission(selection, signal)
    signal.throwIfAborted()
  }
  return ports.withSharedH3GpuReservation(selection, input.signal, async () => {
    await assertCurrent(input.signal)
    const reserved = await ports.ledger.reserve({ ownerId: identity.ownerId,
      profileId: identity.profileId, trialKey: identity.trialKey,
      approvalSha256: approval.approvalSha256,
      graphSha256: review.publicContract.graph.sha256, contractDigest: review.contractDigest,
      dependencyManifestSha256: review.publicContract.dependencyManifestSha256,
      runnerSourceSha256: review.publicContract.runner.sourceSha256,
      runtimeWitnessSha256, inputSha256: copied.inputSha256 })
    const directFetcher = dependencies.fetcher ?? fetch
    const interceptedFetcher: typeof fetch = async (resource, init) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource))
      const method = init?.method ?? (resource instanceof Request ? resource.method : 'GET')
      if (url.origin !== `http://127.0.0.1:${selection.port}`) {
        invalid('COMPUTE_COMFY_VIDEO_LOCAL_ATOMIC_SUBMIT_INVALID')
      }
      if (url.pathname !== '/prompt') {
        if (method === 'POST' && url.pathname !== '/upload/image') {
          invalid('COMPUTE_COMFY_VIDEO_LOCAL_ATOMIC_SUBMIT_INVALID')
        }
        return directFetcher(resource, init)
      }
      const body = init?.body
      const requestSignal = init?.signal
      if (method !== 'POST' || url.href !== `http://127.0.0.1:${selection.port}/prompt`
        || typeof body !== 'string' || !requestSignal) {
        invalid('COMPUTE_COMFY_VIDEO_LOCAL_ATOMIC_SUBMIT_INVALID')
      }
      const submitted = await ports.submitPromptWithExpectedWitness({ port: selection.port,
        attemptId: reserved.attemptId, body,
        expectedRuntimeWitnessSha256: runtimeWitnessSha256,
        expectedComfyPid: initialWitness.comfyPid,
        expectedLoadedModelGenerationSha256: initialWitness.loadedModelGenerationSha256,
        signal: requestSignal })
      if (!(submitted?.response instanceof Response)
        || submitted.actualRuntimeWitnessSha256 !== runtimeWitnessSha256
        || submitted.actualComfyPid !== initialWitness.comfyPid
        || submitted.actualLoadedModelGenerationSha256 !== initialWitness.loadedModelGenerationSha256) {
        invalid('COMPUTE_COMFY_VIDEO_LOCAL_ATOMIC_SUBMIT_UNKNOWN')
      }
      return submitted.response
    }
    let privateResult: ComfyVideoLocalResult
    try {
      privateResult = await runComfyVideoLocally({ admission: {
        publicContract: review.publicContract, privateGraphJson: review.privateGraphJson,
        approvedContractDigest: review.contractDigest,
        approvedDependencyManifestSha256: review.publicContract.dependencyManifestSha256,
        approvedRunnerSourceSha256: review.publicContract.runner.sourceSha256,
        allowedClassTypes: review.allowedClassTypes, attemptId: reserved.attemptId,
        assertReserved: async (signal) => { signal.throwIfAborted(); await ports.ledger.assertReserved(reserved) },
        beforePromptSubmit: async (signal) => {
          await assertCurrent(signal)
          await ports.ledger.beforePromptSubmit(reserved)
        },
        recordPromptId: async (promptId, signal) => {
          signal.throwIfAborted()
          await ports.ledger.recordPromptId(reserved, promptId)
        },
        assertCurrent,
      }, values: copied.values, port: selection.port, workspacePath: selection.workspacePath,
      ffprobePath: selection.ffprobePath, signal: input.signal },
      { ...dependencies, fetcher: interceptedFetcher })
    } catch (error) {
      try {
        const latest = await ports.ledger.latest()
        if (latest?.state === 'reserved' && latest.attemptId === reserved.attemptId
          && latest.trialKey === reserved.trialKey) {
          await ports.ledger.abandonReserved(reserved)
        }
      } catch (_cleanupError) {
        // A concurrent state change or unreadable journal cannot authorize another /prompt.
      }
      throw error
    }
    await assertCurrent(input.signal)
    await ports.ledger.recordLocalResult(reserved, privateResult.sha256)
    return Object.freeze({ schema: 'qianshou.comfy-video-owner-local-result.v1' as const,
      platformReady: false as const, attemptId: reserved.attemptId,
      graphSha256: review.publicContract.graph.sha256, contractDigest: review.contractDigest,
      runtimeWitnessSha256, privateResult })
  })
}
