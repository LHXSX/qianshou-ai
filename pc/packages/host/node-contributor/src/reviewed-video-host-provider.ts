/** Explicit Host composition for one reviewed Comfy installation on a provisioned local ledger. */
import { constants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { probeLocalComfy } from '@deepseek-ai/dsh-compute-core/comfy-local-probe'
import { comfyVideoPublicContractDigest, verifyComfyVideoPublicGraph }
  from '@deepseek-ai/dsh-compute-core/comfy-video-public-contract'
import { ComfyVideoSqliteAttemptLedger }
  from '@deepseek-ai/dsh-compute-core/comfy-video-sqlite-attempt-ledger'
import type { ComputeTaskStore } from '@deepseek-ai/dsh-compute-core/src/task-store.ts'
import type { VideoWorkflowDraftStore } from '@deepseek-ai/dsh-compute-core/src/video-workflow-draft.ts'
import type { KeyObject } from 'node:crypto'
import type { ResidentComfyVideoBridgePorts, ComfyVideoRuntimeSelection,
  ReviewedComfyVideoInstallation, ReviewedComfyVideoPublication } from './comfy-video-resident-bridge.ts'
import { executeNativeProgram, type NativeProgramRunner } from './command-artifact.ts'
import { createSignedReviewedVideoOfferPort } from './reviewed-video-signed-order.ts'
import type { ReviewedVideoHostPort } from './reviewed-video-host-port.ts'

type BridgeServices = Omit<ResidentComfyVideoBridgePorts, 'drafts' | 'ledger'>

/** The caller must source these services from the installed package, authenticated account,
 * enrolled device and Guangzhou attestation. A buyer draft cannot supply any of them. */
export interface ReviewedVideoHostProviderOptions extends Pick<ReviewedVideoHostPort,
  'storageOrigin' | 'controlOrigin' | 'evidenceEndpoint' | 'evidenceBucket'
  | 'attestorPublicKeys'> {
  readonly taskType: string
  readonly orderPublicKeys: Readonly<Record<string, string | KeyObject>>
  /** Provision once out of band. Startup deliberately refuses a missing or damaged database. */
  readonly ledgerPath: string
  readonly taskStore: Pick<ComputeTaskStore, 'get'>
  readonly drafts: Pick<VideoWorkflowDraftStore, 'readPrivate'>
  readonly bridge: BridgeServices
  readonly ownerAccountId: () => Promise<number>
  readonly runtime: () => Promise<ComfyVideoRuntimeSelection>
  readonly supply: ReviewedVideoHostPort['supply']
  /** Read-only deterministic seams for tests. Production uses real loopback GET and ffprobe. */
  readonly fetcher?: typeof fetch
  readonly program?: NativeProgramRunner
}

/** Device-specific inputs only. Product-owned attempts, private graph and account identity
 * are bound by NodeContributor and cannot be supplied by an installation manifest. */
export type ProductReviewedVideoHostProvision = Omit<ReviewedVideoHostProviderOptions,
  'taskStore' | 'drafts' | 'ownerAccountId'>

/** Bind an optional reviewed installation to the actual product stores. A metadata-only
 * market installation cannot construct this port or provide the private graph reader. */
export function createProductReviewedVideoHostPort(
  provision: unknown,
  taskStore: Pick<ComputeTaskStore, 'get'>,
  computeCore: unknown,
): ReviewedVideoHostPort | null {
  if (provision === null || typeof provision !== 'object' || Array.isArray(provision)
    || computeCore === null || typeof computeCore !== 'object'
    || ['taskStore', 'drafts', 'ownerAccountId'].some(key => Object.hasOwn(provision, key))) return null
  const core = computeCore as {
    ownerAccountId?: () => Promise<number>
    readPrivateVideoWorkflowDraft?: Pick<VideoWorkflowDraftStore, 'readPrivate'>['readPrivate']
  }
  const ownerAccountId = core.ownerAccountId
  const readPrivateVideoWorkflowDraft = core.readPrivateVideoWorkflowDraft
  if (typeof ownerAccountId !== 'function'
    || typeof readPrivateVideoWorkflowDraft !== 'function') return null
  return createProvisionedReviewedVideoHostPort({
    ...provision as ProductReviewedVideoHostProvision,
    taskStore,
    drafts: { readPrivate: (id, digest) => readPrivateVideoWorkflowDraft.call(core, id, digest) },
    ownerAccountId: () => ownerAccountId.call(core),
  })
}

function unavailable(): never { throw new ComputeError('COMPUTE_REVIEWED_VIDEO_HOST_UNAVAILABLE', 503) }

function samePublication(install: ReviewedComfyVideoInstallation,
  publication: ReviewedComfyVideoPublication | null): void {
  if (publication === null || publication.status !== 'approved'
    || publication.publicationId !== install.publicationId
    || publication.ownerAccountId !== install.ownerAccountId
    || publication.taskType !== install.publicContract.taskType
    || publication.artifactDigest !== install.artifactDigest
    || publication.contractSha256 !== install.contractSha256
    || publication.approvedContractDigest !== install.approvedContractDigest) unavailable()
}

function sameInstallation(left: ReviewedComfyVideoInstallation,
  right: ReviewedComfyVideoInstallation): boolean {
  return left.ownerAccountId === right.ownerAccountId
    && left.publicationId === right.publicationId
    && left.artifactDigest === right.artifactDigest
    && left.contractSha256 === right.contractSha256
    && left.draftId === right.draftId
    && left.graphSha256 === right.graphSha256
    && left.approvedContractDigest === right.approvedContractDigest
    && left.packageDigest === right.packageDigest
    && left.dependencyManifestSha256 === right.dependencyManifestSha256
    && left.runnerSourceSha256 === right.runnerSourceSha256
    && left.capabilityVersion === right.capabilityVersion
    && left.allowedClassTypes.length === right.allowedClassTypes.length
    && left.allowedClassTypes.every((name, index) => name === right.allowedClassTypes[index])
    && comfyVideoPublicContractDigest(left.publicContract)
      === comfyVideoPublicContractDigest(right.publicContract)
}

/** Binds the existing Windows SQLite journal and private draft reader to the product Host port.
 * This does not install a skill or open supply: the product still requires a current Shanghai ACK.
 */
export function createProvisionedReviewedVideoHostPort(
  options: ReviewedVideoHostProviderOptions,
): ReviewedVideoHostPort {
  if (!isAbsolute(options.ledgerPath)) unavailable()
  const ledger = new ComfyVideoSqliteAttemptLedger(options.ledgerPath, options.taskStore)
  const bridge: ResidentComfyVideoBridgePorts = {
    ...options.bridge, drafts: options.drafts, ledger,
  }
  const offer = createSignedReviewedVideoOfferPort({ taskType: options.taskType,
    publicKeys: options.orderPublicKeys })
  const currentInstallation = async (signal: AbortSignal): Promise<ReviewedComfyVideoInstallation> => {
    signal.throwIfAborted()
    const install = await bridge.readCurrentInstallation()
    if (install === null || install.publicContract.taskType !== options.taskType
      || install.publicContract.limits.maxOutputBytes < 1024 * 1024
      || install.publicContract.limits.maxOutputBytes > 64 * 1024 * 1024
      || install.publicContract.limits.maxInputBytes > 17 * 1024 * 1024
      || comfyVideoPublicContractDigest(install.publicContract) !== install.approvedContractDigest
      || install.graphSha256 !== install.publicContract.graph.sha256
      || install.dependencyManifestSha256 !== install.publicContract.dependencyManifestSha256
      || install.runnerSourceSha256 !== install.publicContract.runner.sourceSha256
      || await options.ownerAccountId() !== install.ownerAccountId) unavailable()
    const publication = await bridge.readCurrentPublication(install.publicationId, signal)
    samePublication(install, publication)
    const draft = await options.drafts.readPrivate(install.draftId, install.graphSha256)
    verifyComfyVideoPublicGraph(install.publicContract, JSON.parse(draft.graphJson) as unknown)
    return install
  }
  const runtimeReady = async (signal: AbortSignal): Promise<void> => {
    const selection = await options.runtime()
    if (!Number.isSafeInteger(selection.port) || selection.port < 1024 || selection.port > 65535
      || !isAbsolute(selection.ffprobePath)) unavailable()
    const stat = await lstat(selection.ffprobePath).catch(() => unavailable())
    if (!stat.isFile() || stat.isSymbolicLink()) unavailable()
    await access(selection.ffprobePath, constants.X_OK).catch(() => unavailable())
    const { stdout } = await (options.program ?? executeNativeProgram)(selection.ffprobePath,
      ['-version'], { timeout: 5000, maxBuffer: 4096, windowsHide: true, signal })
      .catch(() => unavailable())
    if (!/^ffprobe version\s/u.test(stdout)) unavailable()
    const observed = await probeLocalComfy({ port: selection.port }, signal, options.fetcher)
    if (observed.version === null || observed.devices.length === 0) unavailable()
    await bridge.assertRuntimeCurrent(selection, signal)
  }
  const supply: ReviewedVideoHostPort['supply'] = {
    ...options.supply,
    async readCurrent(signal) {
      const snapshot = await options.supply.readCurrent(signal)
      if (snapshot === null) return null
      const install = await currentInstallation(signal)
      if (snapshot.ownerAccountId !== install.ownerAccountId
        || !sameInstallation(snapshot.installation, install)) unavailable()
      samePublication(install, snapshot.publication)
      await runtimeReady(signal)
      return snapshot
    },
  }
  const proveLocalReady = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    const recovered = await ledger.recoverAtStartup()
    // An unspent or uncertain previous /prompt must be explicitly reconciled first.
    if (recovered.state === 'unknown' || recovered.state === 'unspent') unavailable()
    if (recovered.state === 'local-verified' && recovered.record
      && (await options.taskStore.get(recovered.record.taskId, recovered.record.attempt))?.status !== 'SETTLED') {
      unavailable()
    }
    if (await supply.readCurrent(signal) === null) unavailable()
  }
  return { offer, consumerPorts: { bridge, ownerAccountId: options.ownerAccountId,
    runtime: options.runtime }, storageOrigin: options.storageOrigin,
  controlOrigin: options.controlOrigin, evidenceEndpoint: options.evidenceEndpoint,
  evidenceBucket: options.evidenceBucket, attestorPublicKeys: options.attestorPublicKeys,
  supply, proveLocalReady }
}
