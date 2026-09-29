/**
 * Resolving Edge worker connector for the resident contributor plugin.
 *
 * Origin, access token and owner id are read at `connect()`, not at plugin
 * load, because the account session may sign in after the row is mounted.
 * The socket still opens only when the resident loop is started.
 *
 * This module also closes the loop C25 opened on the node daemon: the resident
 * path used to drop the send fact entirely. The seam is
 * `transport/edge-worker-session.ts:298` — `sendReturn` calls
 * `this.connection.complete(offer.identity, encoded)` and **discards** the
 * `EdgeResultSent` it returns, so a resident node could not even say "I am
 * awaiting verification", let alone learn what the platform did with the frame.
 *
 * What this module does about it, without touching that seam:
 * - the HMAC bridge is wrapped, so the exact `EdgeTaskIdentity` each local
 *   `taskId` was translated from is remembered (it is the only place the edge
 *   tuple and the local id meet — the resident `task.return` frame carries only
 *   `taskId`/`attempt`);
 * - the session's `sendReturn` is wrapped: the workload counters are read
 *   **before** the frame leaves, the frame is sent, and only then does
 *   {@link verifySubmittedResult} poll the platform's own projection;
 * - each conclusion is published as a {@link ResidentResultVerification} on the
 *   session, which is how `resident-assembly.ts` lands it in the attempt's
 *   existing task state.
 *
 * The four outcomes and their single disposition mapping are **not** redefined
 * here: they live in `compute-core/src/edge-worker/polled-verification.ts` and
 * `edge-worker/types.ts` (C25). This module only supplies the tuple, the
 * pre-send baseline and the bounded window, and never invents a second state set.
 */
import {
  capabilityIdIfRegistered,
  createInlineEdgeBinding,
  createInlineSessionConsumer,
  createIsolatedInlineRunner,
  ComputeError,
  EdgeSupplyApi,
  hasIsolatedInlineRunner,
  HOST_SUPPLY_TOOLS,
  ISOLATED_INLINE_SESSION_DIGEST,
  ISOLATED_INLINE_SESSION_PROTOCOL,
  ISOLATED_INLINE_SESSION_VERSION,
  probeLocalSupply,
  runnerOwnedCapabilityIds,
  type EdgeResultSent,
  type EdgeTaskIdentity,
  type InlineEdgeBinding,
  type IsolatedInlineRunner,
  type SupplyToolProbe,
} from '@deepseek-ai/dsh-compute-core'
import { randomUUID } from 'node:crypto'
import {
  mergeProvidedCapabilityAds,
  projectNodeCapabilities,
  providedCapabilityAdsForIds,
} from '@deepseek-ai/dsh-compute-core/node-capability'
import { marketCapabilityAds, readMarketIds } from './market-declarations.ts'
import {
  EdgeWorkerResidentConnector,
  type EdgeWorkerResidentSession,
  type OrderAdapterChallengeObservation,
  type NativeH3DeviceKeyObservation,
  type NativeH3DevicePresenceObservation,
  EdgeWorkerTransportError,
  type EdgeSessionBridge,
} from '@deepseek-ai/dsh-compute-core/transport/edge-worker-session'
import { verifySubmittedResult, type EdgeResultVerification,
  type WorkloadStatusReader } from '@deepseek-ai/dsh-compute-core/edge-worker/polled-verification'
import { createFileOrderConsumer, type FileOrderRuntimeRunner, type ComputeResidentResultConsumer,
  type ResidentCapability, type ResidentRuntimeConfig, type ResidentSession,
  type ResidentSessionConnector } from '@deepseek-ai/dsh-compute-core/resident'
import { createArtifactOrderConsumer, validateArtifactOrderAdapter, type ArtifactOrderAdapter } from './artifact-order.ts'
import { isPublishedNativeH3Adapter, nativeH3AdapterClaim } from './native-h3-publication.ts'
import { createReviewedComfyVideoResidentRoute,
  type ReviewedComfyVideoResidentRoute } from './reviewed-comfy-video-resident-route.ts'
import { submitReviewedVideoSupplyUpdate } from './reviewed-video-supply-proof.ts'
import type { ReviewedVideoHostPort } from './reviewed-video-host-port.ts'

/**
 * The per-workload shard counters one read reported.
 *
 * Taken from the verification record rather than redeclared, so this module cannot drift from the
 * projection `verifySubmittedResult` compares against.
 */
type WorkloadCounters = NonNullable<EdgeResultVerification['before']>

/** Inputs resolved at connect time from sibling Host services. */
export interface EdgeResidentCredentials {
  originOf: () => string | null
  tokenOf: () => Promise<string | undefined>
  ownerIdOf: () => Promise<number | undefined>
}

/**
 * Bounded polling window, in the units `verifySubmittedResult` reads.
 *
 * Two independent bounds on purpose (C25): a wall-clock budget **and** a hard
 * read cap, so neither a frozen clock nor a fast failing read side can turn the
 * window into an unbounded loop.
 */
export interface ResidentVerificationWindow {
  readonly timeoutMs: number
  readonly maxPolls: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
}

/** Production window: 30s budget, at most 6 reads, first wait 1s, backoff capped at 8s. */
export const DEFAULT_RESIDENT_VERIFICATION_WINDOW: ResidentVerificationWindow = Object.freeze({
  timeoutMs: 30_000, maxPolls: 6, initialDelayMs: 1_000, maxDelayMs: 8_000,
})

/**
 * Wiring for polling each sent result against the platform's own projection.
 *
 * The read side is the already-audited `GET /api/v8/workloads/{id}` projection
 * (`supply/edge-api.ts:queryWorkload`). By default this binding builds it from
 * the same origin and access token it authenticates the socket with, so a
 * deployment enables nothing and still gets the loop closed; a test injects a
 * reader instead of starting an HTTP server.
 */
export interface ResidentVerificationOptions {
  /** Authenticated read side; the default is built from this binding's own origin and token. */
  readonly reader?: WorkloadStatusReader
  /** Bounded polling window; defaults to {@link DEFAULT_RESIDENT_VERIFICATION_WINDOW}. */
  readonly window?: ResidentVerificationWindow
  /** Per-request timeout for the built-in reader. */
  readonly timeoutMs?: number
  /** Response byte ceiling for the built-in reader. */
  readonly maxResponseBytes?: number
}

/**
 * One result frame that left this process, plus what polling then observed.
 *
 * Read `verification.attribution` before trusting the outcome: the read side is
 * the per-workload aggregate, so even `workload-completed-shard-observed` means
 * "that workload's completed counter advanced", never "the platform confirmed
 * *this* shard". This is not a receipt, not an ack and not a settlement.
 */
export interface ResidentResultVerification {
  /** Local task identity the frame carried (`task.return.taskId`). */
  readonly taskId: string
  /** Resident attempt number the frame carried. */
  readonly attempt: number
  /**
   * The transport fact the resident seam used to drop.
   *
   * `edge-worker-session.ts:298` throws this value away; a record exists here
   * only because `sendReturn` resolved without throwing, which is exactly when
   * `connection.complete` returns `sent-awaiting-verification`.
   */
  readonly sent: EdgeResultSent['state']
  /** The edge tuple the frame was sent with; the read side is addressed by `identity.workloadId`. */
  readonly identity: EdgeTaskIdentity
  /** The bounded polled-verification record; its four outcomes and one disposition table live in compute-core. */
  readonly verification: EdgeResultVerification
}

/** Receives one record per sent result, after that result's polling window closed. */
export type ResidentResultVerificationHandler = (record: ResidentResultVerification) => void

/**
 * The session {@link bindInlineEdgeResident} hands the resident runtime.
 *
 * A `ResidentSession` plus the two reads the assembly needs to stop guessing. It
 * is a `Proxy` over the real `EdgeWorkerResidentSession`, so every other member
 * the concrete class exposes (its link `state`, its `failure`, the acknowledged
 * `workerId`) is forwarded unchanged rather than reimplemented here.
 */
export interface EdgeVerificationSession extends ResidentSession {
  /**
   * Subscribe to post-send polling conclusions.
   *
   * Records observed before the handler was registered are delivered on
   * registration (bounded), so a subscriber that attaches right after `connect`
   * cannot miss a conclusion that raced it.
   * @param handler - Called once per sent result.
   * @returns Unsubscribe.
   */
  onResultVerification(handler: ResidentResultVerificationHandler): () => void
  /**
   * The conclusion for one sent result.
   * @param taskId - Local task identity the frame carried.
   * @param attempt - Resident attempt number the frame carried.
   * @returns The record once polling finished, or null when this session will never produce one.
   */
  resultVerification(taskId: string, attempt: number): Promise<EdgeResultVerification | null>
}

/** Construction inputs for one inline Edge binding. */
export interface EdgeResidentBindOptions extends EdgeResidentCredentials {
  nodeId: string
  agentVersion: string
  allowedTaskTypes: readonly string[]
  handshakeTimeoutMs: number
  maxFrameBytes: number
  maxOutputBytes: number
  supply: () => 'running' | 'paused'
  /** Isolated runner; defaults to `word_count` plus listed agent types. */
  run?: IsolatedInlineRunner
  /** Catalogue types the injected isolated agent may run. */
  agentTaskTypes?: readonly string[]
  /** Exact locally pinned task landings with a current Host output proof. */
  localTaskTypes?: () => readonly string[]
  /** Trusted local tool probes advertised on `hello`; defaults to the shared `HOST_SUPPLY_TOOLS` catalogue. */
  tools?: readonly SupplyToolProbe[]
  /** Bounded whole-probe timeout in milliseconds. */
  probeTimeoutMs?: number
  /** Injected probe for tests; defaults to the real local probe. */
  probe?: () => Promise<Awaited<ReturnType<typeof probeLocalSupply>>>
  /**
   * Capability ids saved by the plugin market, read again on every hello.
   * Ids this node cannot accept are dropped before they are advertised.
   */
  marketCapabilityIds?: () => readonly string[]
  /** Exact, self-tested inline task landings installed on this client, independent of their source. */
  taskAdapters?: () => Promise<readonly VerifiedTaskAdapterClaim[]>
  /** Server-owned entitlement plus this worker's signed receipt and a reverified private v5 runtime. */
  purchasedTaskAdapters?: () => Promise<readonly VerifiedTaskAdapterClaim[]>
  /** Dedicated purpose proof, current account/device installation and immutable file runtime provider. */
  purchasedFileTaskAdapters?: () => Promise<readonly VerifiedTaskAdapterClaim[]>
  /** Current Host provider and runner availability, reread before an empty paused registration. */
  allowEmptyDynamicAdapterRegistration?: () => boolean
  fileOrderRun?: FileOrderRuntimeRunner
  /** Explicit installed file adapter. Both local proof and owner-scoped platform readiness must pass. */
  artifactOrder?: {
    readonly taskType: 'bar_chart_svg_v1'
    loadAndSelfTest(): Promise<ArtifactOrderAdapter | null>
    publicationReady(artifactDigest: string, packageDigest: string): Promise<boolean>
  }
  /** Built-in public media contracts with owner-configured, already trialed native runtimes. */
  nativeArtifactOrders?: readonly {
    readonly taskType: string
    loadAndSelfTest(): Promise<ArtifactOrderAdapter | null>
  }[]
  /** Exact published H3 aliases from current signature-verified owner/device receipts. */
  publishedNativeArtifactOrders?: () => Promise<readonly ArtifactOrderAdapter[]>
  /** Product Host video provider; absent means no reviewed task claim or route. */
  reviewedVideoHost?: ReviewedVideoHostPort
  /**
   * Polled verification of every result this binding sends.
   *
   * Enabled by default: with no option the binding builds the read side from the
   * very origin and token it authenticates the socket with, because a node that
   * never looks is the bug this exists to remove. `false` turns it off entirely
   * (no read is ever attempted for the lifetime of this binding).
   */
  verification?: false | ResidentVerificationOptions
}

/** `task-adapters.v1` hello evidence. A name or category alone never forms a claim. */
export interface VerifiedTaskAdapterClaim {
  readonly task_type: string
  readonly capability_id: string
  readonly input_kinds: readonly string[]
  readonly output_kind: 'inline_json' | 'inline_text' | 'artifact_ref' | 'artifact_manifest'
  readonly contract_version: string
  readonly artifact_digest: string
  readonly package_digest?: string
  readonly installation_state: 'installed' | 'builtin'
  readonly health: 'verified'
  readonly self_test: 'passed'
}

const TASK_ADAPTER_PROTOCOL = 'task-adapters.v1'
const TASK_ADAPTER_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u
const CAPABILITY_NAME = /^[a-z][a-z0-9_.-]{0,99}$/u
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u
const TASK_ADAPTER_INPUT_KINDS = new Set(['inline', 'single_file', 'multi_file', 'archive', 'stream', 'params_only'])
const TASK_ADAPTER_OUTPUT_KINDS = new Set(['inline_json', 'inline_text', 'artifact_ref', 'artifact_manifest'])

/** Keep the declaration inside this binding's actual inline transport and runner envelope. */
function verifiedTaskAdapters(
  candidates: readonly VerifiedTaskAdapterClaim[],
  allowedTaskTypes: readonly string[],
  agentTaskTypes: readonly string[],
  localTaskTypes: readonly string[],
  artifactAdapters: ReadonlyMap<string, ArtifactOrderAdapter>,
  purchased: ReadonlyMap<string, VerifiedTaskAdapterClaim> = new Map(),
  files: ReadonlyMap<string, VerifiedTaskAdapterClaim> = new Map(),
): VerifiedTaskAdapterClaim[] {
  const accepted: VerifiedTaskAdapterClaim[] = []
  const seen = new Set<string>()
  for (const candidate of candidates.slice(0, 128)) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const taskType = candidate.task_type
    const artifactAdapter = artifactAdapters.get(taskType)
    const artifact = artifactAdapter !== undefined && taskType === artifactAdapter.taskType
      && candidate.capability_id === 'video.render'
      && Array.isArray(candidate.input_kinds) && candidate.input_kinds.length === 1 && candidate.input_kinds[0] === 'inline'
      && candidate.output_kind === 'artifact_ref'
      && candidate.artifact_digest === artifactAdapter.artifactDigest
      && candidate.package_digest === artifactAdapter.packageDigest
    const bought = purchased.get(taskType)
    const purchasedInline = bought !== undefined && bought === candidate
      && candidate.output_kind === 'inline_json'
      && candidate.package_digest !== undefined
      && candidate.installation_state === 'installed'
    const file = files.get(taskType)
    const purchasedFile = file !== undefined && file === candidate && candidate.output_kind === 'artifact_ref'
      && candidate.package_digest !== undefined && candidate.installation_state === 'installed'
    if (typeof taskType !== 'string' || !TASK_ADAPTER_NAME.test(taskType)
      || !allowedTaskTypes.includes(taskType)
      || (!artifact && !purchasedInline && !purchasedFile && !hasIsolatedInlineRunner(taskType, agentTaskTypes)
        && !localTaskTypes.includes(taskType))
      || typeof candidate.capability_id !== 'string' || !CAPABILITY_NAME.test(candidate.capability_id)
      || (!artifact && !purchasedInline && !purchasedFile
        && candidate.capability_id !== (capabilityIdIfRegistered(taskType) ?? taskType))
      || !Array.isArray(candidate.input_kinds) || candidate.input_kinds.length !== 1
      || candidate.input_kinds[0] !== 'inline'
      || !candidate.input_kinds.every(kind => TASK_ADAPTER_INPUT_KINDS.has(kind))
      || !TASK_ADAPTER_OUTPUT_KINDS.has(candidate.output_kind)
      || (!artifact && !purchasedFile && candidate.output_kind !== 'inline_json' && candidate.output_kind !== 'inline_text')
      || candidate.contract_version !== 'v1'
      || !SHA256_DIGEST.test(candidate.artifact_digest)
      || (candidate.package_digest !== undefined && !SHA256_DIGEST.test(candidate.package_digest))
      || (candidate.installation_state !== 'installed' && candidate.installation_state !== 'builtin')
      || candidate.health !== 'verified' || candidate.self_test !== 'passed'
      || seen.has(taskType)) continue
    seen.add(taskType)
    accepted.push({ ...candidate, input_kinds: ['inline'] })
  }
  return accepted
}

/**
 * The read side this binding uses when the caller injects none.
 *
 * Exported so the default is inspectable and directly testable: it is the same
 * `EdgeSupplyApi` the host supply page and the node daemon already read the
 * platform through, bound to the origin and access token this binding
 * authenticates its socket with. One origin serves both transports, so a node
 * never needs a second credential to look at its own results.
 * @param origin - Authenticated Edge origin, for example `https://api.example.com`.
 * @param token - Access token for this connect; the reader never refreshes it itself.
 * @param limits - Request timeout and response ceiling; defaults match the node daemon's own.
 * @returns A read side bound to the platform's own workload projection endpoint.
 */
export function defaultVerificationReader(
  origin: string,
  token: string,
  limits: {
    readonly timeoutMs?: number
    readonly maxResponseBytes?: number
  } = {},
): WorkloadStatusReader {
  return new EdgeSupplyApi({
    baseUrl: origin,
    tokenProvider: () => token,
    timeoutMs: limits.timeoutMs ?? 15_000,
    maxResponseBytes: limits.maxResponseBytes ?? 65_536,
  })
}

/**
 * Tool self-tests advertised on `hello` — the shared host catalogue, not a second copy of it.
 *
 * This used to be a local literal (`node`, `git`, `python3`) whose comment claimed it matched the
 * host supply page's own list. It did not: the host probed `node`, `git`, `ffmpeg`. The node
 * therefore advertised `software: ["node","git","python3"]`, and because the dispatcher matches
 * `required_software` against exactly this list, every `ffmpeg`-requiring task type
 * (`video_compress`, `video_info`, `video_thumbnail`, `audio_extract`, `audio_transcode`,
 * `video_repurpose`, `video_analyze`, …) could never be assigned to a machine that had ffmpeg
 * installed. Reading the one exported catalogue makes that divergence unrepresentable; the
 * catalogue module documents the measurement and the absolute-path search order it applies.
 */
export const DEFAULT_HELLO_TOOLS: readonly SupplyToolProbe[] = HOST_SUPPLY_TOOLS

/**
 * The trusted tool list one binding actually hands to the probe: the caller's list when one was
 * injected, otherwise the shared catalogue.
 *
 * The binding's `hello` assembly calls this instead of open-coding the fallback, so a test can ask
 * the same question the binding asks — "which tools will this node advertise?" — without a live
 * socket or a mocked probe.
 * @param options - Only the optional trusted list is read.
 * @returns The list to probe, unchanged from its source.
 */
export function helloToolsOf(options: Pick<EdgeResidentBindOptions, 'tools'> = {}): readonly SupplyToolProbe[] {
  return options.tools ?? DEFAULT_HELLO_TOOLS
}

/** Connector, HMAC binding, result consumer and advertised capabilities. */
export interface EdgeResidentBinding {
  connector: ResidentSessionConnector
  binding: InlineEdgeBinding
  resultConsumer: ComputeResidentResultConsumer
  /** Exact input reader, present only when a complete Host video provider was injected. */
  inputSource?: ResidentRuntimeConfig['inputSource']
  capabilities: () => readonly ResidentCapability[]
  transport: 'edge-worker'
  /** Shanghai worker id after the first successful `auth_ok`; `null` before handshake. */
  workerId: () => string | null
  /** Server-issued UUID of the current ready socket, independent of stable worker identity. */
  connectionId: () => string | null
  /** Exact authenticated socket observation, independent of the owner's supply switch. */
  observeOrderAdapterChallenge: (observation: OrderAdapterChallengeObservation) => Promise<void>
  observeNativeH3DeviceKeyProof: (observation: NativeH3DeviceKeyObservation) => Promise<void>
  observeNativeH3DeviceConfigProof: (observation: NativeH3DeviceKeyObservation) => Promise<void>
  observeNativeH3DevicePresence: (observation: NativeH3DevicePresenceObservation) => Promise<void>
  /** Fixed native claims are admitted by the current authenticated server ACK, without reconnecting. */
  refreshNativeH3OrderAdapters: () => Promise<void>
  /** Read current server-admitted native readiness without renewing, selecting or executing.
   * @param taskType - Exact native publication landing.
   * @returns Whether the acknowledged alias still belongs to this owner and ready socket.
   */
  nativeH3OrderAdapterReady: (taskType: string) => Promise<boolean>
  /** Exact media adapter is loaded, self-tested and approved for this session. */
  artifactReady: (taskType?: string) => boolean
  /** Current media types with a ready worker session, including verified author aliases. */
  verifiedArtifactTaskTypes: () => readonly string[]
  /** A reviewed task is usable only after this socket's signed supply update ACK. */
  reviewedVideoReady: () => boolean
  /** Immediately refuse media offers while an installed adapter is being replaced. */
  withdrawArtifact: (taskType?: string) => void
}

/**
 * Bind the HMAC Edge path for executable task types or an empty authenticated dynamic-provider registration.
 * @param options - Node identity, advertised types, socket limits and credential resolvers.
 * @returns Connector, verifier binding, isolated consumer and capability list.
 */
export function bindInlineEdgeResident(options: EdgeResidentBindOptions): EdgeResidentBinding {
  const artifactTaskType = options.artifactOrder?.taskType
  const staticArtifactTaskTypes = [artifactTaskType, ...(options.nativeArtifactOrders ?? []).map(item => item.taskType)]
    .filter((item): item is string => item !== undefined)
  const reviewedTaskType = options.reviewedVideoHost?.offer.taskType
  if (reviewedTaskType !== undefined && (options.allowedTaskTypes.includes(reviewedTaskType)
    || staticArtifactTaskTypes.includes(reviewedTaskType))) {
    throw new ComputeError('COMPUTE_REVIEWED_VIDEO_TASK_COLLISION', 409)
  }
  // The bridge reads this same array when each offer arrives; only branded H3 aliases may extend it.
  const artifactTaskTypes = [...staticArtifactTaskTypes]
  const agentTaskTypes = (options.agentTaskTypes ?? []).filter(type => !artifactTaskTypes.includes(type))
  const activeArtifacts = new Map<string, ArtifactOrderAdapter>()
  let activeAllowedTaskTypes: readonly string[] = options.allowedTaskTypes.filter(type => !artifactTaskTypes.includes(type))
  let activePurchased = new Map<string, VerifiedTaskAdapterClaim>()
  let activeFiles = new Map<string, VerifiedTaskAdapterClaim>()
  let uploadSession: EdgeWorkerResidentSession | null = null
  let reviewedRoute: ReviewedComfyVideoResidentRoute | null = null
  let reviewedCapability: ResidentCapability | null = null
  const reviewedVideoReady = (): boolean => reviewedTaskType !== undefined
    && reviewedRoute !== null && reviewedCapability !== null && uploadSession?.state() === 'ready'
    && uploadSession.reviewedVideoAdapterTaskType() === reviewedTaskType
  const artifactReady = (taskType: string | undefined = artifactTaskType): boolean =>
    taskType !== undefined && activeArtifacts.has(taskType) && uploadSession?.state() === 'ready'
  const withdrawArtifact = (taskType: string | undefined = artifactTaskType): void => {
    if (taskType === undefined) return
    activeArtifacts.delete(taskType)
    activeAllowedTaskTypes = activeAllowedTaskTypes.filter(type => type !== taskType)
    binding.updateAllowedTaskTypes(activeAllowedTaskTypes)
  }
  const binding = createInlineEdgeBinding({
    nodeId: options.nodeId,
    allowedTaskTypes: activeAllowedTaskTypes,
    maxOutputBytes: options.maxOutputBytes,
    capabilityIdForTaskType: taskType => activeFiles.get(taskType)?.capability_id ?? activePurchased.get(taskType)?.capability_id,
    fileTaskTypeAllowed: taskType => activeFiles.has(taskType),
    artifactTaskTypes, artifactMaxOutputBytes: 16 * 1024 * 1024,
    ...(options.reviewedVideoHost === undefined ? {} : { reviewedVideo: options.reviewedVideoHost.offer }),
  })
  const inlineConsumer = createInlineSessionConsumer({
    run: options.run ?? createIsolatedInlineRunner({ agentTaskTypes }),
    rememberResult: binding.rememberResult,
  })
  const resultConsumer: ComputeResidentResultConsumer = {
    async consume(input) {
      const taskType = (input.execution.task.parameters as Record<string, unknown> | null)?.taskType
      if (reviewedTaskType !== undefined && taskType === reviewedTaskType) {
        if (!reviewedVideoReady() || reviewedRoute === null) {
          throw new ComputeError('COMPUTE_COMFY_VIDEO_CONSUMER_DISABLED', 503)
        }
        return reviewedRoute.resultConsumer.consume(input)
      }
      if (typeof taskType === 'string' && activeFiles.has(taskType)) {
        const session = uploadSession
        if (session === null || session.state() !== 'ready' || options.fileOrderRun === undefined) {
          throw new ComputeError('COMPUTE_FILE_ADAPTER_UNAVAILABLE', 503)
        }
        return createFileOrderConsumer({ run: options.fileOrderRun, remember: binding.rememberArtifact,
          ports: (taskId, attempt) => ({
            read: (fields, signal) => session.readFileAttachment(taskId, attempt, fields, signal),
            upload: (fields, signal) => session.uploadFileArtifact(taskId, attempt, fields, signal),
          }),
        }).consume(input)
      }
      const parameters = input.execution.task.parameters as Record<string, unknown> | null
      // A queued native lease keeps its execution channel even after its route is withdrawn.
      if (parameters?.nativeDeviceLease !== undefined
        && (typeof taskType !== 'string' || !artifactTaskTypes.includes(taskType))) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_UNAVAILABLE', 503)
      }
      if (typeof taskType !== 'string' || !artifactTaskTypes.includes(taskType)) return inlineConsumer.consume(input)
      const adapter = activeArtifacts.get(taskType)
      const session = uploadSession
      if (adapter === undefined || session === null || !artifactReady(taskType)) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_UNAVAILABLE', 503)
      }
      return createArtifactOrderConsumer(adapter, {
        nativeDeviceLease: (taskId, attempt) => binding.leaseOf(taskId, attempt, input.execution.attempt.leaseExpiresAt).nativeDeviceLease,
        upload: (taskId, attempt, artifact, signal) => session.uploadArtifact(taskId, attempt, artifact, signal),
        remember: binding.rememberArtifact,
      }).consume(input)
    },
  }
  const inputSource: ResidentRuntimeConfig['inputSource'] = options.reviewedVideoHost === undefined ? undefined : {
    open(execution, task, input, signal) {
      if ((execution.task.parameters as Record<string, unknown> | null)?.taskType !== reviewedTaskType) {
        throw new ComputeError('COMPUTE_COMFY_VIDEO_CONSUMER_DISABLED', 503)
      }
      const source = reviewedRoute?.inputSource
      if (source === undefined || !reviewedVideoReady()) {
        throw new ComputeError('COMPUTE_COMFY_VIDEO_CONSUMER_DISABLED', 503)
      }
      return source.open(execution, task, input, signal)
    },
  }
  const verification = options.verification === false ? null : options.verification ?? {}
  const window = verification?.window ?? DEFAULT_RESIDENT_VERIFICATION_WINDOW
  /**
   * Edge tuple each local task id was translated from.
   *
   * Why the bridge is wrapped rather than the session asked: the resident
   * `task.return` frame carries only `taskId`/`attempt`, and `EdgeTaskIdentity`
   * is `workerId`/`workloadId`/`shardId`/`attempt` — the tuple exists for one
   * instant, as an argument to `toNodeOffer`, and the read side can only be
   * addressed by `workloadId`. Bounded so a long-lived node cannot grow it
   * without limit.
   */
  const identities = new Map<string, EdgeTaskIdentity>()
  const sessionBridge: EdgeSessionBridge = verification === null ? binding.bridge : {
    toNodeOffer(offer, context) {
      const mapped = binding.bridge.toNodeOffer(offer, context)
      // A refused offer has no local identity to remember; nothing is invented for it.
      if (!('refuse' in mapped)) {
        rememberIdentity(identities, mapped.envelope.taskId, {
          workerId: offer.workerId,
          workloadId: offer.workloadId,
          shardId: offer.shardId,
          attempt: offer.attempt,
        })
      }
      return mapped
    },
    toEdgeResult: message => binding.bridge.toEdgeResult(message),
  }
  const capabilities = (): readonly ResidentCapability[] => activeAllowedTaskTypes.map((taskType) => {
    if (taskType === reviewedTaskType && reviewedCapability !== null) {
      return Object.freeze({ ...reviewedCapability, available: reviewedVideoReady() })
    }
    return Object.freeze({
      // 与桥同一条反查：登记过的落地名写成语义 id，未登记名保持原样。
      capabilityId: artifactTaskTypes.includes(taskType) ? 'video.render'
        : activeFiles.get(taskType)?.capability_id ?? activePurchased.get(taskType)?.capability_id
            ?? capabilityIdIfRegistered(taskType) ?? taskType,
      version: ISOLATED_INLINE_SESSION_VERSION,
      pluginDigest: ISOLATED_INLINE_SESSION_DIGEST,
      dataScope: 'none' as const,
      maxInputBytes: 0,
      maxOutputBytes: artifactTaskTypes.includes(taskType) ? 16 * 1024 * 1024
        : activeFiles.has(taskType) ? 16 * 1024 : options.maxOutputBytes,
      available: artifactTaskTypes.includes(taskType) ? artifactReady(taskType)
        : activeFiles.has(taskType) || activePurchased.has(taskType) || hasIsolatedInlineRunner(taskType, agentTaskTypes)
          || (options.localTaskTypes?.() ?? []).includes(taskType),
    })
  })
  /**
   * Real measured machine identity for `hello`.
   *
   * Why this is not just the protocol marker: the platform stores this dict as the node's
   * capability profile and both the dispatcher and its machine-identity dedupe read it. A hello
   * carrying only `{ protocol }` is read as a machine that can run nothing (`runtimes: []`,
   * `cpu_cores: 0`), and — because the fingerprint helper needs `hostname`/`os`/`arch` — a
   * reconnect cannot be recognised as the same machine, so every reconnect registers another
   * ghost node. Facts that were not probed stay absent; nothing is invented.
   */
  let measuredProbe: Promise<{ ok: true; projected: ReturnType<typeof projectNodeCapabilities> } | { ok: false }> | undefined
  const refreshNativeArtifacts = async (): Promise<void> => {
    for (const type of artifactTaskTypes) {
      if (!staticArtifactTaskTypes.includes(type)) activeArtifacts.delete(type)
    }
    artifactTaskTypes.splice(0, artifactTaskTypes.length, ...staticArtifactTaskTypes)
    for (const provider of (options.nativeArtifactOrders ?? []).slice(0, 16)) {
      activeArtifacts.delete(provider.taskType)
      if (provider.taskType === artifactTaskType || !options.allowedTaskTypes.includes(provider.taskType)
        || capabilityIdIfRegistered(provider.taskType) !== 'video.render') continue
      try {
        const candidate = await provider.loadAndSelfTest()
        if (candidate !== null) {
          validateArtifactOrderAdapter(candidate)
          if (candidate.taskType === provider.taskType) activeArtifacts.set(provider.taskType, candidate)
        }
      } catch { /* Missing native prerequisites or prior real trial means no claim. */ }
    }
    try {
      for (const candidate of (await options.publishedNativeArtifactOrders?.() ?? []).slice(0, 16)) {
        if (!isPublishedNativeH3Adapter(candidate) || activeArtifacts.has(candidate.taskType)
          || options.allowedTaskTypes.includes(candidate.taskType)) continue
        validateArtifactOrderAdapter(candidate)
        activeArtifacts.set(candidate.taskType, candidate)
        artifactTaskTypes.push(candidate.taskType)
      }
    } catch { /* No current enrolled proof means no dynamic native media claim. */ }
  }
  let nativeUpdateInProgress = false
  let nativeAckOwnerId: number | undefined
  let nativeAckConnectionId: string | null = null
  const refreshNativeH3OrderAdapters = async (): Promise<void> => {
    const session = uploadSession
    const connectionId = session?.acknowledgedConnectionId()
    const workerId = acknowledgedWorkerId
    const ownerId = await options.ownerIdOf()
    if (session?.state() !== 'ready' || !connectionId || !workerId || ownerId === undefined) {
      throw new EdgeWorkerTransportError('TRANSPORT_NOT_CONNECTED', 'not-configured')
    }
    if (nativeUpdateInProgress) throw new ComputeError('H3_NATIVE_SELECTION_BUSY', 409)
    nativeUpdateInProgress = true
    const previous = artifactTaskTypes.filter(type => !staticArtifactTaskTypes.includes(type))
    const previousClaims = previous.map(type => nativeH3AdapterClaim(activeArtifacts.get(type)))
      .filter(item => item !== null).sort((a, b) => a.task_type.localeCompare(b.task_type))
    const withdraw = (): void => {
      nativeAckOwnerId = undefined; nativeAckConnectionId = null
      for (const type of artifactTaskTypes) if (!staticArtifactTaskTypes.includes(type)) activeArtifacts.delete(type)
      artifactTaskTypes.splice(0, artifactTaskTypes.length, ...staticArtifactTaskTypes)
      activeAllowedTaskTypes = activeAllowedTaskTypes.filter(type => !previous.includes(type))
      binding.updateAllowedTaskTypes(activeAllowedTaskTypes)
    }
    const assertCurrent = async (): Promise<void> => {
      if (uploadSession !== session || session.state() !== 'ready'
        || session.acknowledgedConnectionId() !== connectionId || acknowledgedWorkerId !== workerId
        || await options.ownerIdOf() !== ownerId) throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409)
    }
    try {
      await assertCurrent()
      const readCandidates = async (): Promise<ArtifactOrderAdapter[]> => {
        const result = (await options.publishedNativeArtifactOrders?.() ?? [])
          .filter(item => isPublishedNativeH3Adapter(item) && item.taskType !== reviewedTaskType
            && !staticArtifactTaskTypes.includes(item.taskType)
            && !options.allowedTaskTypes.includes(item.taskType))
        if (result.length > 16) throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409)
        return result
      }
      const candidates = await readCandidates()
      const rows = candidates.map(item => nativeH3AdapterClaim(item))
      if (rows.some(item => item === null)) throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409)
      const claims = rows.filter(item => item !== null).sort((a, b) => a.task_type.localeCompare(b.task_type))
      if (claims.length !== new Set(claims.map(item => item.task_type)).size) throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409)
      await assertCurrent()
      // Fresh source/provider/proof reads may retain an already acknowledged, identical tuple without an intake gap.
      if (claims.length === previous.length && nativeAckOwnerId === ownerId && nativeAckConnectionId === connectionId
        && JSON.stringify(claims) === JSON.stringify(previousClaims)) return
      withdraw()
      if (claims.length === 0 && previous.length === 0) return
      await session.updateNativeH3Adapters({ requestId: randomUUID(), adapters: claims })
      await assertCurrent()
      // ACK is not enough: changed local source, provider or proof may settle while the server responds.
      const current = (await readCandidates())
        .map(item => nativeH3AdapterClaim(item)).filter(item => item !== null)
        .sort((a, b) => a.task_type.localeCompare(b.task_type))
      if (JSON.stringify(current) !== JSON.stringify(claims)) throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409)
      await assertCurrent()
      for (const candidate of candidates) {
        validateArtifactOrderAdapter(candidate)
        activeArtifacts.set(candidate.taskType, candidate); artifactTaskTypes.push(candidate.taskType)
      }
      activeAllowedTaskTypes = [...new Set([...activeAllowedTaskTypes, ...candidates.map(item => item.taskType)])].slice(0, 64)
      binding.updateAllowedTaskTypes(activeAllowedTaskTypes)
      nativeAckOwnerId = ownerId; nativeAckConnectionId = connectionId
    } catch (error) { withdraw(); throw error }
    finally { nativeUpdateInProgress = false }
  }
  const helloCapabilities = async (): Promise<Record<string, unknown>> => {
    await refreshNativeArtifacts()
    const probe = options.probe ?? (() => probeLocalSupply({
      tools: [...helloToolsOf(options)],
      timeoutMs: options.probeTimeoutMs ?? 8_000,
      maxResponseBytes: 65_536,
      // This seam is a capability self-test, not an activity reading: the host activity fact is
      // owned by the supply assembly, so it stays unknown here rather than being guessed.
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
    }))
    measuredProbe ??= (async () => {
      try {
        return {
          ok: true as const,
          projected: projectNodeCapabilities(await probe(), { mode: options.supply() }),
        }
      } catch {
        // A failed probe advertises no measured machine fact; the in-process runner still can.
        return { ok: false as const }
      }
    })()
    const probed = await measuredProbe
    let taskAdapters: VerifiedTaskAdapterClaim[] = []
    let purchased: VerifiedTaskAdapterClaim[] = []
    try {
      if (options.taskAdapters !== undefined) {
        // The callback can perform the first bounded output proof. Read the
        // locally verified types only after it finishes so a fresh profile can
        // publish its runner ad and exact adapter in the same hello.
        taskAdapters = [...await options.taskAdapters()]
      }
    } catch {
      // Self-test or inventory failed: advertise no adapter, never an inferred one.
    }
    try {
      purchased = [...(await options.purchasedTaskAdapters?.() ?? [])]
    } catch { purchased = [] }
    const purchasedMap = new Map<string, VerifiedTaskAdapterClaim>()
    for (const claim of purchased) {
      if (claim && claim.task_type !== reviewedTaskType && TASK_ADAPTER_NAME.test(claim.task_type)
        && CAPABILITY_NAME.test(claim.capability_id)
        && SHA256_DIGEST.test(claim.artifact_digest)
        && SHA256_DIGEST.test(claim.package_digest ?? '')
        && claim.output_kind === 'inline_json' && claim.installation_state === 'installed'
        && !options.allowedTaskTypes.includes(claim.task_type)
        && !purchasedMap.has(claim.task_type)
        && purchasedMap.size < 64 - options.allowedTaskTypes.length) {
        purchasedMap.set(claim.task_type, claim)
      }
    }
    const filesMap = new Map<string, VerifiedTaskAdapterClaim>()
    if (options.fileOrderRun !== undefined && options.purchasedFileTaskAdapters !== undefined) {
      try {
        for (const claim of (await options.purchasedFileTaskAdapters()).slice(0, 128)) {
          if (claim && claim.task_type !== reviewedTaskType
            && TASK_ADAPTER_NAME.test(claim.task_type) && CAPABILITY_NAME.test(claim.capability_id)
            && SHA256_DIGEST.test(claim.artifact_digest) && SHA256_DIGEST.test(claim.package_digest ?? '')
            && claim.output_kind === 'artifact_ref' && claim.installation_state === 'installed'
            && !options.allowedTaskTypes.includes(claim.task_type) && !purchasedMap.has(claim.task_type)
            && !filesMap.has(claim.task_type) && filesMap.size + purchasedMap.size < 64 - options.allowedTaskTypes.length) {
            filesMap.set(claim.task_type, claim)
          }
        }
      } catch { filesMap.clear() }
    }
    activePurchased = purchasedMap
    activeFiles = filesMap
    activeAllowedTaskTypes = [...options.allowedTaskTypes.filter(type => !artifactTaskTypes.includes(type)),
      ...purchasedMap.keys(), ...filesMap.keys(), ...activeArtifacts.keys()].slice(0, 64)
    binding.updateAllowedTaskTypes(activeAllowedTaskTypes)
    taskAdapters.push(...purchasedMap.values(), ...filesMap.values())
    for (const activeArtifactAdapter of activeArtifacts.values()) taskAdapters.push({
      task_type: activeArtifactAdapter.taskType,
      capability_id: 'video.render',
      input_kinds: ['inline'],
      output_kind: 'artifact_ref',
      contract_version: activeArtifactAdapter.contractVersion,
      artifact_digest: activeArtifactAdapter.artifactDigest,
      package_digest: activeArtifactAdapter.packageDigest,
      installation_state: 'installed', health: 'verified', self_test: 'passed',
    })
    const localTaskTypes = options.localTaskTypes?.() ?? []
    taskAdapters = verifiedTaskAdapters(taskAdapters, activeAllowedTaskTypes, agentTaskTypes,
      localTaskTypes, activeArtifacts, purchasedMap, filesMap)
    activePurchased = new Map(taskAdapters.filter((item) => {
      const claim = purchasedMap.get(item.task_type)
      return claim !== undefined && claim.capability_id === item.capability_id
        && claim.artifact_digest === item.artifact_digest
        && claim.package_digest === item.package_digest
    })
      .map(item => [item.task_type, item]))
    activeFiles = new Map(taskAdapters.filter((item) => {
      const claim = filesMap.get(item.task_type)
      return claim !== undefined && claim.capability_id === item.capability_id
        && claim.artifact_digest === item.artifact_digest && claim.package_digest === item.package_digest
    }).map(item => [item.task_type, item]))
    activeAllowedTaskTypes = [...new Set([...options.allowedTaskTypes.filter(type =>
      !artifactTaskTypes.includes(type)), ...activeArtifacts.keys(), ...activePurchased.keys(), ...activeFiles.keys()])]
    binding.updateAllowedTaskTypes(activeAllowedTaskTypes)
    const runnerIds = runnerOwnedCapabilityIds(activeAllowedTaskTypes, agentTaskTypes, localTaskTypes)
    const runnerAds = providedCapabilityAdsForIds(runnerIds)
    // A market row can name a capability, but hello only repeats ids this process can run.
    const declaredAds = marketCapabilityAds(
      readMarketIds(options.marketCapabilityIds).filter(id => runnerIds.includes(id)),
    )
    const adapterClaims = options.taskAdapters === undefined && options.purchasedTaskAdapters === undefined
      && options.purchasedFileTaskAdapters === undefined
      && options.artifactOrder === undefined && options.nativeArtifactOrders === undefined
      && options.publishedNativeArtifactOrders === undefined
      ? {} : { verified_task_adapters: taskAdapters }
    const mediaAd = taskAdapters.some(item => activeArtifacts.has(item.task_type))
      ? [{ name: 'video.render', version: '1.0.0', health: 'ok' as const }] : []
    const purchasedAds = [...activePurchased.values(), ...activeFiles.values()].map(item => ({
      name: item.capability_id, version: '1.0.0', health: 'ok' as const,
    }))
    const verifiedH3 = [...activeArtifacts.values()].some(adapter =>
      adapter.taskType === 'video_generate' || isPublishedNativeH3Adapter(adapter))
    // A real fixed-runner trial proves this Python/H3 installation. Hardware facts
    // remain owned by the measured probe; this never invents a GPU or GPU memory.
    const nativeRuntimeFacts = verifiedH3 ? {
      software: [...new Set([...(probed.ok ? probed.projected.software : []), 'h3'])],
      runtimes: [...new Set([...(probed.ok ? probed.projected.runtimes : []), 'python3'])],
    } : {}
    if (!probed.ok) {
      return {
        protocol: ISOLATED_INLINE_SESSION_PROTOCOL,
        ...nativeRuntimeFacts,
        provided_capabilities: [...mergeProvidedCapabilityAds(runnerAds, declaredAds), ...mediaAd, ...purchasedAds],
        ...adapterClaims,
      }
    }
    return {
      protocol: ISOLATED_INLINE_SESSION_PROTOCOL,
      ...probed.projected,
      ...nativeRuntimeFacts,
      provided_capabilities: [...mergeProvidedCapabilityAds(probed.projected.provided_capabilities, runnerAds,
        declaredAds), ...mediaAd, ...purchasedAds],
      ...adapterClaims,
    }
  }
  /** Worker id the platform acknowledged for this node, reused by every later reconnect. */
  let acknowledgedWorkerId: string | undefined
  const connector: ResidentSessionConnector = {
    connect: async (signal?: AbortSignal): Promise<ResidentSession> => {
      const origin = options.originOf()
      const token = await options.tokenOf()
      const ownerId = await options.ownerIdOf()
      if (origin === null || origin.length === 0) {
        throw new EdgeWorkerTransportError('TRANSPORT_NOT_CONFIGURED', 'not-configured')
      }
      if (token === undefined || token.length === 0) {
        throw new EdgeWorkerTransportError('TRANSPORT_AUTH_FAILED', 'not-configured', 'EDGE_AUTH_REQUIRED')
      }
      if (ownerId === undefined || !Number.isSafeInteger(ownerId) || ownerId < 1) {
        throw new EdgeWorkerTransportError('TRANSPORT_AUTH_FAILED', 'not-configured', 'EDGE_AUTH_REQUIRED')
      }
      activeArtifacts.clear()
      activePurchased = new Map()
      reviewedRoute = null
      reviewedCapability = null
      uploadSession = null
      if (options.artifactOrder !== undefined && options.allowedTaskTypes.includes(options.artifactOrder.taskType)) {
        try {
          const candidate = await options.artifactOrder.loadAndSelfTest()
          if (candidate !== null) {
            validateArtifactOrderAdapter(candidate)
            if (candidate.taskType === options.artifactOrder.taskType
              && await options.artifactOrder.publicationReady(candidate.artifactDigest, candidate.packageDigest)) {
              activeArtifacts.set(candidate.taskType, candidate)
            }
          }
        } catch { /* No local proof or no platform publication means no media claim. */ }
      }
      activeAllowedTaskTypes = options.allowedTaskTypes.filter(type => !artifactTaskTypes.includes(type) || activeArtifacts.has(type))
      binding.updateAllowedTaskTypes(activeAllowedTaskTypes)
      const capabilities = await helloCapabilities()
      const registrationOnly = activeAllowedTaskTypes.length === 0
      // A configured fixed media provider may still need its private configuration or real trial.
      // It can authenticate for explicit review; no unavailable execution claim is advertised.
      if (registrationOnly && (options.allowedTaskTypes.some(type =>
        !staticArtifactTaskTypes.includes(type) || activeArtifacts.has(type))
        || options.allowEmptyDynamicAdapterRegistration?.() !== true
        || (options.publishedNativeArtifactOrders === undefined && options.purchasedTaskAdapters === undefined
          && options.reviewedVideoHost === undefined
          && (options.purchasedFileTaskAdapters === undefined || options.fileOrderRun === undefined)))) {
        throw new EdgeWorkerTransportError('TRANSPORT_NOT_CONFIGURED', 'not-configured', 'NO_APPROVED_TASK_ADAPTER')
      }
      const inner = new EdgeWorkerResidentConnector({
        endpoint: origin,
        tokenProvider: () => token,
        expectedOwnerId: ownerId,
        name: options.nodeId,
        clientBuild: options.agentVersion,
        os: process.platform,
        arch: process.arch,
        // `software` is the old package-name advertisement. `provided_capabilities` is the
        // dual-write: registry objects from probed packages, plus semantic ids this process
        // can run (isolated-inline owns `text.transform`). Landing names such as
        // `word_count` stay on the connector; they are not capability ids.
        // Deliberately absent: `supported_executors` (the platform's executor
        // labels are `native|onnx|http|python3`, and this node runs none of them — it executes the
        // types it advertises in-process) and `bench_capability_score` (a self-reported number the
        // platform copies into `capability_score`; reporting one we cannot calibrate would inflate
        // this node's standing instead of describing it).
        // Registration can retain measured hardware and tool facts. Execution claims wait for
        // the current authenticated socket's independently verified native update.
        capabilities: registrationOnly ? { ...capabilities, protocol: ISOLATED_INLINE_SESSION_PROTOCOL,
          provided_capabilities: [], verified_task_adapters: [] } : {
          protocol: ISOLATED_INLINE_SESSION_PROTOCOL, ...capabilities,
        },
        // A protocol-capabilities list opts out of the platform's legacy default.
        // Keep the result/assignment profile this connector actually speaks.
        ...(options.taskAdapters === undefined && options.purchasedTaskAdapters === undefined
          && options.purchasedFileTaskAdapters === undefined
          && options.artifactOrder === undefined && options.nativeArtifactOrders === undefined
          && options.reviewedVideoHost === undefined
          ? {} : { protocolCapabilities: ['assignment-token.v1',
            ...(options.taskAdapters === undefined && options.purchasedTaskAdapters === undefined
              && options.purchasedFileTaskAdapters === undefined
              && options.artifactOrder === undefined && options.nativeArtifactOrders === undefined
              ? [] : [TASK_ADAPTER_PROTOCOL]),
            ...(options.reviewedVideoHost === undefined ? [] : ['reviewed-video-supply.v1'])] }),
        allowedTaskTypes: activeAllowedTaskTypes,
        ...(registrationOnly ? { registrationOnly: true as const } : {}),
        handshakeTimeoutMs: options.handshakeTimeoutMs,
        maxFrameBytes: options.maxFrameBytes,
        maxOutputBytes: options.maxOutputBytes,
        loopbackOnly: !origin.startsWith('https:'),
        supply: options.supply,
        bridge: sessionBridge,
        // A reconnect is the same node, not a new one: the platform binds assignments and leases
        // to the acknowledged worker id, and without it every reconnect registers a ghost node
        // while the task under test still points at the old one.
        ...(acknowledgedWorkerId === undefined ? {} : { workerId: acknowledgedWorkerId }),
      })
      const session = await inner.connect(signal)
      uploadSession = session
      const acknowledged = (session as unknown as { workerId?: unknown }).workerId
      if (typeof acknowledged === 'string' && acknowledged.length > 0) acknowledgedWorkerId = acknowledged
      const videoHost = options.reviewedVideoHost
      if (videoHost !== undefined) {
        const attemptSignal = signal ?? new AbortController().signal
        try {
          await videoHost.proveLocalReady(attemptSignal)
          const snapshot = await videoHost.supply.readCurrent(attemptSignal)
          if (snapshot === null || snapshot.workerId !== acknowledgedWorkerId
            || snapshot.connectionId !== session.acknowledgedConnectionId()
            || snapshot.installation.publicContract.taskType !== videoHost.offer.taskType
            || activeAllowedTaskTypes.length >= 64
            || snapshot.installation.publicContract.limits.maxOutputBytes < 1024 * 1024
            || snapshot.installation.publicContract.limits.maxOutputBytes > 64 * 1024 * 1024
            || snapshot.installation.publicContract.limits.maxInputBytes > 17 * 1024 * 1024) {
            throw new ComputeError('COMPUTE_REVIEWED_VIDEO_HOST_UNAVAILABLE', 503)
          }
          const route = createReviewedComfyVideoResidentRoute({ enabled: true, nodeId: options.nodeId,
            binding, offer: videoHost.offer, ports: videoHost.consumerPorts,
            edgeSession: () => uploadSession === session && session.state() === 'ready' ? session : null,
            storageOrigin: videoHost.storageOrigin, controlOrigin: videoHost.controlOrigin,
            evidenceEndpoint: videoHost.evidenceEndpoint, evidenceBucket: videoHost.evidenceBucket })
          await submitReviewedVideoSupplyUpdate({ requestId: randomUUID(),
            attestorPublicKeys: videoHost.attestorPublicKeys, signal: attemptSignal,
            ports: { ...videoHost.supply,
              sendUpdate: (update, updateSignal) => session.updateReviewedVideoAdapter(update, updateSignal) } })
          if (uploadSession !== session || session.state() !== 'ready'
            || session.acknowledgedConnectionId() !== snapshot.connectionId
            || session.reviewedVideoAdapterTaskType() !== videoHost.offer.taskType) {
            throw new ComputeError('COMPUTE_REVIEWED_VIDEO_HOST_UNAVAILABLE', 503)
          }
          reviewedCapability = Object.freeze({ capabilityId: 'video.render',
            version: snapshot.installation.capabilityVersion, pluginDigest: snapshot.installation.packageDigest,
            dataScope: 'task-inputs' as const,
            maxInputBytes: snapshot.installation.publicContract.limits.maxInputBytes,
            maxOutputBytes: snapshot.installation.publicContract.limits.maxOutputBytes, available: true })
          reviewedRoute = route
          activeAllowedTaskTypes = [...new Set([...activeAllowedTaskTypes, videoHost.offer.taskType])]
          binding.updateAllowedTaskTypes(activeAllowedTaskTypes)
        } catch {
          reviewedRoute = null; reviewedCapability = null
          activeAllowedTaskTypes = activeAllowedTaskTypes.filter(type => type !== reviewedTaskType)
          binding.updateAllowedTaskTypes(activeAllowedTaskTypes)
        }
      }
      // Native proof is scoped to this new ACK socket and cannot appear in the pre-auth Hello.
      try { await refreshNativeH3OrderAdapters() }
      catch { /* Ordinary connection remains usable; an unacknowledged native claim stays withdrawn. */ }
      if (verification === null) return session
      // The read side is built from this connect's own origin and token: a re-login between two
      // sessions must not leave the poller holding yesterday's credential.
      if (verification.reader !== undefined) {
        return verifiedSession(session, { reader: verification.reader, closeReader: null, window, identities })
      }
      const built = defaultVerificationReader(origin, token, {
        ...(verification.timeoutMs === undefined ? {} : { timeoutMs: verification.timeoutMs }),
        ...(verification.maxResponseBytes === undefined ? {} : { maxResponseBytes: verification.maxResponseBytes }),
      })
      return verifiedSession(session, {
        reader: built,
        closeReader: () => { (built as EdgeSupplyApi).close() },
        window,
        identities,
      })
    },
  }
  return {
    connector, binding, resultConsumer,
    ...(inputSource === undefined ? {} : { inputSource }),
    capabilities, transport: 'edge-worker',
    workerId: () => acknowledgedWorkerId ?? null,
    connectionId: () => uploadSession?.acknowledgedConnectionId() ?? null,
    observeOrderAdapterChallenge: (observation) => {
      if (uploadSession?.state() !== 'ready') throw new EdgeWorkerTransportError(
        'TRANSPORT_NOT_CONNECTED', 'not-configured')
      return uploadSession.observeOrderAdapterChallenge(observation)
    },
    observeNativeH3DeviceKeyProof: (observation) => {
      if (uploadSession?.state() !== 'ready') throw new EdgeWorkerTransportError('TRANSPORT_NOT_CONNECTED', 'not-configured')
      return uploadSession.observeNativeH3DeviceKeyProof(observation)
    },
    observeNativeH3DeviceConfigProof: (observation) => {
      if (uploadSession?.state() !== 'ready') throw new EdgeWorkerTransportError('TRANSPORT_NOT_CONNECTED', 'not-configured')
      return uploadSession.observeNativeH3DeviceConfigProof(observation)
    },
    observeNativeH3DevicePresence: (observation) => {
      if (uploadSession?.state() !== 'ready') throw new EdgeWorkerTransportError('TRANSPORT_NOT_CONNECTED', 'not-configured')
      return uploadSession.observeNativeH3DevicePresence(observation)
    },
    refreshNativeH3OrderAdapters,
    nativeH3OrderAdapterReady: async (taskType) => {
      const session = uploadSession
      const ownerId = await options.ownerIdOf()
      return uploadSession === session && session?.state() === 'ready' && nativeAckOwnerId === ownerId
        && nativeAckConnectionId !== null && session.acknowledgedConnectionId() === nativeAckConnectionId
        && !staticArtifactTaskTypes.includes(taskType) && artifactReady(taskType)
        && nativeH3AdapterClaim(activeArtifacts.get(taskType)) !== null
    },
    artifactReady,
    verifiedArtifactTaskTypes: () => [...activeArtifacts.keys()].filter(type => artifactReady(type))
      .concat(reviewedVideoReady() && reviewedTaskType !== undefined ? [reviewedTaskType] : []),
    reviewedVideoReady,
    withdrawArtifact,
  }
}

/** Local task ids whose edge tuple is remembered; oldest entries are dropped first. */
const IDENTITY_LIMIT = 256
/** Conclusions kept for a handler that registers after they landed. */
const BACKLOG_LIMIT = 64
/** Conclusions kept for {@link EdgeVerificationSession.resultVerification} after delivery. */
const CONCLUSION_LIMIT = 256

/** Keep one edge tuple for a local task id without letting the map grow without limit. */
function rememberIdentity(identities: Map<string, EdgeTaskIdentity>, taskId: string, identity: EdgeTaskIdentity): void {
  identities.delete(taskId)
  identities.set(taskId, identity)
  while (identities.size > IDENTITY_LIMIT) {
    const oldest = identities.keys().next()
    if (oldest.done === true) break
    identities.delete(oldest.value)
  }
}

/** Key one conclusion by the local `(taskId, attempt)` pair the frame carried. */
function conclusionKey(taskId: string, attempt: number): string {
  return `${taskId}\u0000${attempt}`
}

/** Wiring one verified session needs; the reader is either injected or built from this connect's credentials. */
interface VerifiedSessionSeam {
  readonly reader: WorkloadStatusReader
  /** Closes the reader this module built; null when the caller injected one it owns. */
  readonly closeReader: (() => void) | null
  readonly window: ResidentVerificationWindow
  readonly identities: ReadonlyMap<string, EdgeTaskIdentity>
}

/**
 * Read the pre-send baseline, or refuse to have one.
 *
 * `null` is the honest answer when the projection cannot be read, and it is what
 * makes the verification report `unobservable` **without spending a single
 * request**: a baseline read after the send cannot tell "the platform already
 * counted this" from "the platform counted this because of my frame", so it is
 * never substituted.
 * @param reader - Authenticated read side.
 * @param identity - The tuple the result is about.
 * @param signal - Session lifetime cancellation.
 * @returns The counters read before the send, or null when they could not be read.
 */
async function readBaseline(
  reader: WorkloadStatusReader,
  identity: EdgeTaskIdentity,
  signal: AbortSignal,
): Promise<WorkloadCounters | null> {
  try {
    const workload = await reader.queryWorkload(identity.workloadId, signal)
    return { completedShards: workload.completedShards, failedShards: workload.failedShards }
  } catch {
    // Never `{completedShards: 0}`: an unread projection is unknown, not zero.
    return null
  }
}

/**
 * Wrap one real session so a sent result stops being blind.
 *
 * `sendReturn` becomes: read the baseline → send the frame → poll in the
 * background. The polling is deliberately **not** awaited inside `sendReturn`:
 * the runtime's state machine records the attempt's own `RETURNED` transition as
 * soon as this promise resolves, and holding a 30s verification window open
 * there would park every attempt in `UPLOADING` for the whole window.
 * @param session - The concrete `EdgeWorkerResidentSession` this connector just opened.
 * @param seam - Read side, window, remembered tuples and the reader's owner.
 * @returns A proxy over that session that adds the two verification reads.
 */
function verifiedSession(
  session: ResidentSession,
  seam: VerifiedSessionSeam,
): EdgeVerificationSession {
  const lifetime = new AbortController()
  const handlers = new Set<ResidentResultVerificationHandler>()
  const conclusions = new Map<string, EdgeResultVerification>()
  const inFlight = new Map<string, Promise<EdgeResultVerification | null>>()
  const backlog: ResidentResultVerification[] = []
  const publish = (key: string, record: ResidentResultVerification): void => {
    conclusions.delete(key)
    conclusions.set(key, record.verification)
    while (conclusions.size > CONCLUSION_LIMIT) {
      const oldest = conclusions.keys().next()
      if (oldest.done === true) break
      conclusions.delete(oldest.value)
    }
    if (handlers.size === 0) {
      // Nothing is listening yet (the assembly subscribes right after `connect`, but a record can
      // race it): hold it briefly so a late subscriber still sees it, then let it go.
      backlog.push(record)
      while (backlog.length > BACKLOG_LIMIT) backlog.shift()
      return
    }
    for (const handler of [...handlers]) handler(record)
  }
  /** Members this proxy answers itself; everything else is forwarded to the concrete session. */
  const overrides: Record<PropertyKey, unknown> = {
    async sendReturn(message: Parameters<ResidentSession['sendReturn']>[0]): Promise<void> {
      const identity = seam.identities.get(message.taskId)
      const before = identity === undefined
        ? null
        : await readBaseline(seam.reader, identity, lifetime.signal)
      // The frame goes out after the baseline read, so the counters compared later were
      // demonstrably read **before** this result existed on the platform.
      await session.sendReturn(message)
      if (identity === undefined) return
      const key = conclusionKey(message.taskId, message.attempt)
      const pending = verifySubmittedResult({
        reader: seam.reader,
        identity,
        before,
        ...seam.window,
        signal: lifetime.signal,
      }).catch(() => null).then((record: EdgeResultVerification | null) => {
        // `null` here means the poll could not run at all (a refused window): that is "unknown",
        // and it is published like any other conclusion so both reads agree.
        const verification = record ?? indeterminateRecord(identity, before)
        publish(key, {
          taskId: message.taskId,
          attempt: message.attempt,
          // Proven by the send above: this is the value `connection.complete` returned and the
          // resident seam discarded at `transport/edge-worker-session.ts:298`.
          sent: 'sent-awaiting-verification',
          identity,
          verification,
        })
        return verification
      })
      inFlight.set(key, pending)
      void pending.finally(() => { inFlight.delete(key) })
    },
    onResultVerification(handler: ResidentResultVerificationHandler): () => void {
      handlers.add(handler)
      for (const record of backlog.splice(0, backlog.length)) handler(record)
      return () => { handlers.delete(handler) }
    },
    resultVerification(taskId: string, attempt: number): Promise<EdgeResultVerification | null> {
      const key = conclusionKey(taskId, attempt)
      const pending = inFlight.get(key)
      if (pending !== undefined) return pending
      return Promise.resolve(conclusions.get(key) ?? null)
    },
    async close(reason?: string): Promise<void> {
      // A closed session can no longer learn anything: cancel the window so a pending poll
      // reports a bounded unknown instead of settling after the socket is gone.
      lifetime.abort()
      handlers.clear()
      backlog.length = 0
      seam.closeReader?.()
      await session.close(reason)
    },
  }
  return new Proxy(session as unknown as EdgeVerificationSession, {
    get(target, property) {
      if (property in overrides) return overrides[property]
      // Everything else — `state()`, `failure()`, the acknowledged `workerId`, `onOffer`,
      // `onDisconnect`, `sendDecision`, `sendEarnings` — is the concrete session's own member,
      // forwarded unchanged and bound to the target so private fields keep working.
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** The `unobservable` record used when the poll itself could not run; it is never `settleable`. */
function indeterminateRecord(
  identity: EdgeTaskIdentity,
  before: WorkloadCounters | null,
): EdgeResultVerification {
  return Object.freeze({
    outcome: 'unobservable' as const,
    disposition: 'indeterminate' as const,
    attribution: 'workload-aggregate-only' as const,
    identity,
    before,
    after: null,
    polls: 0,
    failedPolls: 0,
    elapsedMs: 0,
    code: 'EDGE_VERIFICATION_UNREADABLE',
    // 读都没读成（轮询没跑起来）⇒ 归类为 unreadable：属"可恢复"窗口，
    // 再读一次仍可能得出不同结论（`RECOVERABLE` 里含 'unreadable'）。**不是**终局。
    failureClass: 'unreadable',
    retryable: true,
  })
}
