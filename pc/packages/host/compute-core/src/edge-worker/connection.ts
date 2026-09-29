import { parseNativeH3TaskLeaseV2 } from '../native-h3-task-lease.ts'
import { createHash } from 'node:crypto'
/** Real Edge WebSocket protocol for an explicitly isolated loopback/SSH test environment. */
import { record, SupplyError } from '../supply/policy.ts'
import { safeOrigin } from '../supply/http.ts'
import type { EdgeArtifactManifest, EdgeArtifactResult, EdgeInlineResult, EdgeResultSent, EdgeTaskFailure,
  EdgeTaskIdentity, EdgeTaskOffer, EdgeWorkerEvent, EdgeWorkerPort } from './types.ts'
import { parseEdgeFileContract } from './file-task-contract.ts'
import { requestAttachmentReadCredential } from './attachment-read-credential.ts'
import { readPinnedFileAttachment } from './artifact-read.ts'
import { uploadEdgeArtifact } from './artifact-upload.ts'
import { uploadEdgeVideoFile } from './artifact-upload-file.ts'
import { createShanghaiReviewedVideoFileControl } from './reviewed-video-file-control.ts'
import type { ReviewedVideoAdapterAck, ReviewedVideoAdapterUpdate } from './reviewed-video-supply-contract.ts'
import { parseNativeH3ContractBinding, parseNativeH3PortableExecutionBinding, nativeH3LogicalBindingSha256,
  type NativeH3PortableExecutionBinding, type NativeH3AuthorBinding } from '../native-h3-binding.ts'

/** 握手阶段；`closed` 之后一切入站帧都不再被解释。 */
export type EdgeHandshakeStage = 'new' | 'welcome' | 'auth' | 'ready' | 'closed'

/**
 * 一个被**忽略**的入站帧类型的留痕。
 *
 * 只留类型、计数与时刻——**永不保留帧体**：未知帧里的数据本节点既看不懂，也没被授权留下来。
 * 未知帧的处置方式是「忽略 + 留痕」，**绝不是**断连：平台上新帧的那一天，未更新的节点
 * 不该在**第一帧**上就把自己的会话拆掉（工单 2 头号目标）。
 */
export interface EdgeIgnoredFrameRecord {
  /** 帧类型名（已按字符白名单截断，最多 64 字符）。 */
  readonly frameType: string
  /** 被忽略的次数。 */
  readonly count: number
  /** 首次见到该类型的时刻（本机时钟毫秒）。 */
  readonly firstSeenAt: number
  /** 最近一次见到该类型的时刻（本机时钟毫秒）。 */
  readonly lastSeenAt: number
  /** `unknown-type`：本节点不认识的类型；`out-of-stage`：认识的类型出现在不该出现的阶段。 */
  readonly classification: 'unknown-type' | 'out-of-stage'
}

/** 握手与链路可观测快照：只含状态、计数与时刻，**不含凭据与帧体**，可安全放进状态端点响应。 */
export interface EdgeHandshakeObservability {
  /** 当前阶段。 */
  readonly stage: EdgeHandshakeStage
  /** 关闭原因；未关闭时为 `null`。 */
  readonly closeReason: string | null
  /** 已认证的节点身份；未认证时为空串。 */
  readonly workerId: string
  /** 心跳可观测项（工单 5/6 的可见性读它）。 */
  readonly heartbeat: {
    /** 平台 `welcome.hb_interval_s`。 */
    readonly intervalSeconds: number
    /** 心跳应答截止窗口：平台 `welcome.hb_timeout_s`，缺省时退回 3 × 心跳周期。 */
    readonly ackTimeoutMs: number
    /** 最近一次发出 `hb` 的时刻。 */
    readonly lastSentAt: number | null
    /** 最近一次收到 `hb_ack` 的时刻。 */
    readonly lastAckAt: number | null
    /** 对端尚未应答的那一拍心跳的发出时刻；已应答时为 `null`。 */
    readonly awaitingAckSince: number | null
    /** 是否处于「已 ready 且没有欠着的 ack」这一健康态。 */
    readonly healthy: boolean
  }
  /** 能力协商结果（工单 2 第 2 项）。 */
  readonly features: {
    /** 平台在 `welcome.features` 里声明的可选帧；缺省或形状非法 ⇒ 空数组。 */
    readonly platform: readonly string[]
    /** 本节点在 `supportedOptionalFrames` 里声明的可选帧。 */
    readonly supported: readonly string[]
    /** 双方都声明 ⇒ 协商通过；任一侧缺省 ⇒ 空。 */
    readonly negotiated: readonly string[]
    /** 协商通过且本构建真的有处理器 ⇒ 会被解释的那一部分。 */
    readonly interpreted: readonly string[]
  }
  /** 被忽略帧的留痕汇总。 */
  readonly ignoredFrames: {
    /** 被忽略帧的总数（含超出留痕表容量、只计数的那些）。 */
    readonly total: number
    /** 因留痕表已满而只计数、未建新条目的次数。 */
    readonly overflow: number
    /** 留痕条目，按首次出现顺序。 */
    readonly records: readonly EdgeIgnoredFrameRecord[]
  }
}

/** 重连退避参数：`baseMs` 起步、逐次翻倍、`maxMs` 封顶、`jitterRatio` 抖动比例。 */
export interface EdgeReconnectBackoffOptions {
  /** 首次重连的基准延迟，毫秒（默认 1000）。 */
  readonly baseMs?: number
  /** 延迟上限，毫秒（默认 60000）；必须不小于 `baseMs`，否则配置直接拒绝。 */
  readonly maxMs?: number
  /** 抖动比例 0–1（默认 0.25）：实际延迟乘以 `1 - r + 2r·random()`。 */
  readonly jitterRatio?: number
  /** 随机源，测试可注入以求确定性；默认 `Math.random`。 */
  readonly random?: () => number
  /** 本机时钟；默认 `Date.now`。 */
  readonly clock?: () => number
}

/** 一次重连计划：退避延迟，以及「上次为什么断、断了多久」的审计记录。 */
export interface EdgeReconnectPlan {
  /** 这是第几次重连（从 1 起）。 */
  readonly attempt: number
  /** 本次应等待的毫秒数，恒在 `[1, maxMs]` 内。 */
  readonly delayMs: number
  /** 上一次断开/失败的原因码。 */
  readonly reason: string
  /** 上一次连接从头到尾持续了多久（毫秒）。 */
  readonly lastSessionMs: number
  /** 做出该计划的时刻。 */
  readonly at: number
}

/** 留痕表容量上限：未知帧可以无限来，留痕表不能无限涨。 */
const MAX_IGNORED_FRAME_TYPES = 64
/** 帧类型名/能力名的字符白名单，同时给出长度上界。 */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u
/** 本节点认识的帧类型；不在此列的一律只忽略、不解释。 */
const KNOWN_FRAME_TYPES: ReadonlySet<string> = new Set(['welcome', 'auth_ok', 'hb_ack', 'shard_assign', 'shard_cancel',
  'control', 'err', 'order_adapter_challenge_ack', 'native_h3_device_key_proof_ack',
  'native_h3_device_config_proof_ack', 'native_h3_device_presence_ack', 'native_h3_adapter_update_ack',
  'reviewed_video_adapter_update_ack'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu
const CHALLENGE_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const CHALLENGE_SHA = /^sha256:[0-9a-f]{64}$/u
const PRESENCE_NONCE = /^[A-Za-z0-9_-]{43}$/u

export interface OrderAdapterChallengeObservation {
  readonly challengeNonce: string
  readonly inputDigest: string
  readonly outputDigest: string
  readonly runtimeDigest: string
  readonly artifactDigest: string
}

/** Proof of possession for a server-issued owner/ACK-device enrollment challenge. */
export interface NativeH3DeviceKeyObservation {
  readonly challengeId: string
  readonly signature: string
}

/** Signature of a current, independent presence challenge, witnessed by the same authenticated socket. */
export interface NativeH3DevicePresenceObservation {
  readonly challengeNonce: string
  readonly signature: string
}

/** Fixed native claims compared with the server's current installed proof, never client approval. */
export interface NativeH3AdapterClaimV1 {
  /** Exact approved task landing owned by this immutable native publication. */
  readonly task_type: string
  /** Shared fixed native video capability; never an arbitrary submitted program. */
  readonly capability_id: 'video.render'
  /** The fixed runner accepts a bounded inline prompt. */
  readonly input_kinds: readonly ['inline']
  /** Media delivery uses the existing immutable artifact reference. */
  readonly output_kind: 'artifact_ref'
  /** Existing task adapter contract generation. */
  readonly contract_version: 'v1'
  /** SHA256 of the exact JSON-only author source inventory. */
  readonly artifact_digest: string
  /** Private owner configuration identity, without exposing its paths. */
  readonly package_digest: string
  /** Informational claim compared with the server's actual installed device evidence. */
  readonly installation_state: 'installed'
  /** Informational claim; the server verifies the matching device proof independently. */
  readonly health: 'verified'
  /** Informational claim; no client boolean substitutes for independently reviewed samples. */
  readonly self_test: 'passed'
  /** Immutable approved publication UUID. */
  readonly publication_id: string
  /** Raw SHA256 of Shanghai's frozen TaskSpec snapshot. */
  readonly contract_sha256: string
  /** Fixed ABI, byte-pinned runtime and actual recipe/model/configuration identities. */
  readonly native_binding: NativeH3AuthorBinding
  /** Raw SHA256 of the canonical twenty-field installed-device proof payload. */
  readonly device_proof_sha256: string
}

/** Exact v2 metadata additionally binds the current device-private revision. */
export interface NativeH3AdapterClaimV2 extends Omit<NativeH3AdapterClaimV1, 'contract_version' | 'native_binding'> {
  readonly contract_version: 'v2'
  readonly native_binding: NativeH3PortableExecutionBinding
  readonly local_owner_config_digest: string
  readonly device_binding_revision: number
}
/** Explicit protocol generations; v1 rows remain exactly fourteen fields. */
export type NativeH3AdapterClaim = NativeH3AdapterClaimV1 | NativeH3AdapterClaimV2

/** Composition supplies measured capabilities and explicit task scope; no cloud settings are inferred. */
export interface EdgeWorkerOptions {
  readonly origin: string
  readonly tokenProvider: () => string | undefined
  readonly expectedOwnerId: number
  /** Previously acknowledged worker identity, if the Host is reconnecting its own registered node. */
  readonly workerId?: string
  readonly name: string
  readonly clientBuild: string
  readonly os: string
  readonly arch: string
  readonly capabilities: Readonly<Record<string, unknown>>
  /** Versioned task-adapter declarations supported by this worker's hello payload. */
  readonly protocolCapabilities?: readonly string[]
  readonly allowedTaskTypes: readonly string[]
  /** Authenticate an empty dynamic-provider session for device challenges; it never accepts task execution. */
  readonly registrationOnly?: true
  readonly handshakeTimeoutMs: number
  readonly maxFrameBytes: number
  readonly maxOutputBytes: number
  /** Optional test transport for the metadata POST and direct object-store PUT. */
  readonly artifactFetch?: typeof fetch
  /** Injectable local clock, so the post-auth liveness deadline can be driven by tests. */
  readonly clock?: () => number
  /**
   * 本节点**声明能解释**的可选帧类型名。
   *
   * 缺省空数组 ⇒ 平台就算在 `welcome.features` 里声明了，本节点也不解释任何可选帧。
   * 能力协商缺省即关闭：只有「平台声明 ∩ 节点声明」命中的帧才可能被解释。
   */
  readonly supportedOptionalFrames?: readonly string[]
  /**
   * 可选帧处理器：仅当该帧类型落在协商结果里才被调用。
   *
   * 处理器抛错也不会拆会话——可选帧本就不该让节点下线。
   */
  readonly onOptionalFrame?: (frameType: string, payload: Record<string, unknown>) => void
  /** 每个被忽略的入站帧的留痕回调（类型/计数/时刻，无帧体），供守护进程记日志。 */
  readonly onIgnoredFrame?: (record: EdgeIgnoredFrameRecord) => void
  /**
   * When true (the default), only literal loopback HTTP origins are admitted.
   * HTTPS scheduler origins require `false`; HTTP non-loopback origins stay refused.
   */
  readonly loopbackOnly?: boolean
  readonly readLoad: () => number
  readonly onOffer: (offer: EdgeTaskOffer, signal: AbortSignal) => Promise<void>
  readonly onEvent: (event: EdgeWorkerEvent) => void
}

/** No script download/execution or local lease minting occurs in this transport. */
export class EdgeWorkerConnection implements EdgeWorkerPort {
  #leases = new Map<string, { identity: EdgeTaskIdentity; token: string }>()
  /** Only a successfully uploaded reference may be submitted as a result. */
  #uploadedArtifacts = new Map<string, EdgeArtifactManifest>()
  /** An uncertain presign/PUT/complete must not start a second media PUT on this attempt. */
  #reviewedVideoUploads = new Set<string>()
  #seen = new Set<string>()
  #progress = new Map<string, number>()
  private nativeAdapterTaskTypes: readonly string[] = []
  private nativeAdapterV2TaskTypes: readonly string[] = []
  private reviewedVideoTaskType: string | null = null
  private readonly challengeAcks = new Map<string, { resolve: () => void
    reject: (error: Error) => void
    nativeUpdate?: {
      connectionId: string
      taskTypes: readonly string[]
      v2TaskTypes: readonly string[]
    }
    timer: ReturnType<typeof setTimeout> }>()
  private readonly reviewedVideoAcks = new Map<string, { resolve: (ack: ReviewedVideoAdapterAck) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
    connectionId: string
    publicationId: string
    taskType: string
    approvedContractDigest: string }>()
  private readonly origin: URL
  private readonly lifetime = new AbortController()
  private socket: WebSocket | undefined
  private stage: EdgeHandshakeStage = 'new'
  private workerId = ''
  private authenticatedConnectionId: string | null = null
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined
  private mode: 'running' | 'paused' = 'paused'
  private intervalSeconds = 0
  /** Post-auth ack deadline from `welcome.hb_timeout_s`, in milliseconds. */
  private ackTimeoutMs = 0
  /** Instant of the oldest heartbeat the peer has not answered, or null when answered. */
  private awaitingAckSince: number | null = null
  /** Armed by every `hb`; a `hb_ack` cancels it, its expiry closes the link. */
  private watchdog: ReturnType<typeof setTimeout> | undefined
  private readonly clockNow: () => number
  private resolveConnect: (() => void) | undefined
  private rejectConnect: ((error: Error) => void) | undefined
  private callbacks = new Set<Promise<void>>()
  private closeReason = 'EDGE_CLOSED'
  /** 本节点声明的可选帧（构造期固定）。 */
  private readonly supportedFeatures: readonly string[]
  /** 平台在 `welcome.features` 里声明的可选帧；缺省/形状非法 ⇒ 空。 */
  private platformFeatures: readonly string[] = Object.freeze([])
  /** 协商通过、且本构建确有处理器的可选帧。 */
  private negotiated = new Set<string>()
  /** 被忽略帧的留痕表（键 = 帧类型），容量有界。 */
  private ignored = new Map<string, { frameType: string
    count: number
    firstSeenAt: number
    lastSeenAt: number
    classification: 'unknown-type' | 'out-of-stage' }>()
  private ignoredTotal = 0
  private ignoredOverflow = 0
  private lastHeartbeatSentAt: number | null = null
  private lastHeartbeatAckAt: number | null = null

  /** Bind only literal loopback origins; the tunnel and isolated server identity remain deployment-owned.
   * @param options - Trusted isolated endpoint, measured hardware and Host execution callbacks.
   */
  constructor(private readonly options: EdgeWorkerOptions) {
    this.origin = safeOrigin(options.origin, options.loopbackOnly !== false)
    this.clockNow = options.clock ?? (() => Date.now())
    // 本节点声明的可选帧只认白名单形状的名字：声明里的垃圾项不会变成"解释得动"的帧。
    this.supportedFeatures = Object.freeze([...new Set((options.supportedOptionalFrames ?? []).filter(name => SAFE_NAME.test(name)))])

    if (!Number.isSafeInteger(options.handshakeTimeoutMs) || options.handshakeTimeoutMs < 1
      || !Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1
      || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1
      || !Number.isSafeInteger(options.expectedOwnerId) || options.expectedOwnerId < 1
      || (options.protocolCapabilities !== undefined && (!Array.isArray(options.protocolCapabilities)
        || options.protocolCapabilities.length > 32
        || options.protocolCapabilities.some(name => typeof name !== 'string' || !SAFE_NAME.test(name))))
      || (options.allowedTaskTypes.length === 0 && options.registrationOnly !== true)
      || (options.registrationOnly === true && (options.allowedTaskTypes.length !== 0
        || !Array.isArray(options.capabilities.provided_capabilities) || options.capabilities.provided_capabilities.length !== 0
        || !Array.isArray(options.capabilities.verified_task_adapters) || options.capabilities.verified_task_adapters.length !== 0
        || (options.capabilities.protocol !== undefined && options.capabilities.protocol !== 'qianshou.isolated-inline-session.v1')))) {
      throw new SupplyError('EDGE_WORKER_CONFIG_INVALID')
    }
  }

  /** Establish hello/auth using the real protocol; initial heartbeat is paused.
   * @param signal - Abort the connection and all task callbacks when cancelled.
   * @returns Completion after owner authentication and the initial heartbeat send.
   */
  connect(signal?: AbortSignal): Promise<void> {
    if (this.stage !== 'new') return Promise.reject(new SupplyError('EDGE_CONNECTION_ALREADY_USED'))
    if (signal?.aborted) return Promise.reject(new SupplyError('EDGE_ABORTED'))
    let token: string | undefined
    try { token = this.options.tokenProvider() } catch { /* Provider error details stay private. */ }
    if (!token) return Promise.reject(new SupplyError('EDGE_AUTH_REQUIRED'))
    const socketUrl = new URL('/api/v8/ws/worker', this.origin)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    this.stage = 'welcome'
    const promise = new Promise<void>((resolve, reject) => { this.resolveConnect = resolve; this.rejectConnect = reject })
    this.deadline = setTimeout(() =>{  this.fail('EDGE_HANDSHAKE_TIMEOUT') }, this.options.handshakeTimeoutMs)
    signal?.addEventListener('abort', () =>{  this.fail('EDGE_ABORTED') }, { once: true, signal: this.lifetime.signal })
    this.socket = new WebSocket(socketUrl, 'edgecompute.v8')
    this.socket.addEventListener('open', () => {
      if (this.lifetime.signal.aborted) return
      this.send('hello', { client_version: '8.0.0', client_build: this.options.clientBuild,
        os: this.options.os, arch: this.options.arch, capabilities: this.options.capabilities,
        ...(this.options.protocolCapabilities?.length ? { protocol_capabilities: this.options.protocolCapabilities } : {}),
        ...(this.options.workerId ? { worker_id: this.options.workerId } : {}) })
    })
    this.socket.addEventListener('message', (event) => {
      try { this.receive(event.data, token) }
      catch { this.fail('EDGE_PROTOCOL_INVALID') }
    })
    this.socket.addEventListener('error', () =>{  this.fail('EDGE_CONNECTION_FAILED') })
    this.socket.addEventListener('close', () =>{  this.fail('EDGE_CONNECTION_CLOSED') })
    return promise
  }

  /** Change the real heartbeat mode after Host policy grants or withdraws future supply.
   * @param mode - Whether future task assignment is locally allowed or paused.
   */
  updateMode(mode: 'running' | 'paused'): void {
    this.assertReady()
    if (this.options.registrationOnly === true && this.nativeAdapterTaskTypes.length === 0
      && this.reviewedVideoTaskType === null && mode !== 'paused') throw new SupplyError('EDGE_REGISTRATION_ONLY')
    this.mode = mode; this.sendHeartbeat()
  }

  /** Wait for Shanghai to persist hashes on this authenticated worker socket. */
  observeOrderAdapterChallenge(observation: OrderAdapterChallengeObservation): Promise<void> {
    this.assertReady()
    if (!CHALLENGE_UUID.test(observation.challengeNonce)
      || ![observation.inputDigest, observation.outputDigest, observation.runtimeDigest,
        observation.artifactDigest].every(value => CHALLENGE_SHA.test(value))) {
      throw new SupplyError('EDGE_CHALLENGE_OBSERVATION_INVALID')
    }
    if (this.challengeAcks.size >= 8 || this.challengeAcks.has(observation.challengeNonce)) {
      throw new SupplyError('EDGE_CHALLENGE_OBSERVATION_BUSY')
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.challengeAcks.delete(observation.challengeNonce)
        reject(new SupplyError('EDGE_CHALLENGE_ACK_TIMEOUT'))
      }, 10_000)
      timer.unref()
      this.challengeAcks.set(observation.challengeNonce, { resolve, reject, timer })
      try {
        this.send('order_adapter_challenge_result', {
          challenge_nonce: observation.challengeNonce,
          input_digest: observation.inputDigest, output_digest: observation.outputDigest,
          runtime_digest: observation.runtimeDigest, artifact_digest: observation.artifactDigest,
        })
      } catch (error) {
        clearTimeout(timer)
        this.challengeAcks.delete(observation.challengeNonce)
        reject(error instanceof Error ? error : new SupplyError('EDGE_NOT_CONNECTED'))
      }
    })
  }

  /** Observe an independently issued device enrollment over this exact authenticated connection.
   * @param observation - Server challenge UUID and a canonical Ed25519 base64url signature.
   * @returns Resolves only after the same server connection acknowledges this challenge id.
   */
  observeNativeH3DeviceKeyProof(observation: NativeH3DeviceKeyObservation): Promise<void> {
    if (this.stage !== 'ready') throw new SupplyError('EDGE_NOT_CONNECTED')
    if (Object.keys(observation).sort().join(',') !== 'challengeId,signature'
      || !CHALLENGE_UUID.test(observation.challengeId) || !/^[A-Za-z0-9_-]{86}$/u.test(observation.signature)
      || Buffer.from(observation.signature, 'base64url').toString('base64url') !== observation.signature) {
      throw new SupplyError('EDGE_NATIVE_DEVICE_PROOF_INVALID')
    }
    const key = `native:${observation.challengeId}`
    if (this.challengeAcks.size >= 8 || this.challengeAcks.has(key)) throw new SupplyError('EDGE_CHALLENGE_OBSERVATION_BUSY')
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.challengeAcks.delete(key)
        reject(new SupplyError('EDGE_NATIVE_DEVICE_PROOF_ACK_TIMEOUT'))
      }, 10_000)
      timer.unref()
      this.challengeAcks.set(key, { resolve, reject, timer })
      try { this.send('native_h3_device_key_proof', { challenge_id: observation.challengeId, signature: observation.signature }) }
      catch (error) {
        clearTimeout(timer)
        this.challengeAcks.delete(key)
        reject(error instanceof Error ? error : new SupplyError('EDGE_NOT_CONNECTED'))
      }
    })
  }

  /** Observe an v2 private-configuration CAS plan over this exact authenticated connection.
   * @param observation - Server challenge UUID and a canonical Ed25519 base64url signature.
   * @returns Resolves only after the same server connection acknowledges this challenge id.
   */
  observeNativeH3DeviceConfigProof(observation: NativeH3DeviceKeyObservation): Promise<void> {
    if (this.stage !== 'ready' || this.authenticatedConnectionId === null) throw new SupplyError('EDGE_NOT_CONNECTED')
    if (Object.keys(observation).sort().join(',') !== 'challengeId,signature'
      || !CHALLENGE_UUID.test(observation.challengeId) || !/^[A-Za-z0-9_-]{86}$/u.test(observation.signature)
      || Buffer.from(observation.signature, 'base64url').toString('base64url') !== observation.signature) {
      throw new SupplyError('EDGE_NATIVE_DEVICE_PROOF_INVALID')
    }
    const key = `native-config:${observation.challengeId}`
    if (this.challengeAcks.size >= 8 || this.challengeAcks.has(key)) throw new SupplyError('EDGE_CHALLENGE_OBSERVATION_BUSY')
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.challengeAcks.delete(key)
        reject(new SupplyError('EDGE_NATIVE_DEVICE_PROOF_ACK_TIMEOUT'))
      }, 10_000)
      timer.unref()
      this.challengeAcks.set(key, { resolve, reject, timer })
      try { this.send('native_h3_device_config_proof', { challenge_id: observation.challengeId, signature: observation.signature }) }
      catch (error) {
        clearTimeout(timer)
        this.challengeAcks.delete(key)
        reject(error instanceof Error ? error : new SupplyError('EDGE_NOT_CONNECTED'))
      }
    })
  }

  /** Read the server-issued UUID for this exact ready socket; old handshakes have no presence authority.
   * @returns The current server UUID, or null before authentication or after disconnect.
   */
  acknowledgedConnectionId(): string | null {
    return this.stage === 'ready' ? this.authenticatedConnectionId : null
  }

  /** Current same-socket server-admitted native types; empty before ACK or after withdrawal.
   * @returns Accepted task types for this ready connection only.
   */
  nativeH3AdapterTaskTypes(): readonly string[] {
    return this.stage === 'ready' ? this.nativeAdapterTaskTypes : []
  }

  /** Current reviewed task admitted by this authenticated connection's exact update ACK. */
  reviewedVideoAdapterTaskType(): string | null {
    return this.stage === 'ready' ? this.reviewedVideoTaskType : null
  }

  /** Observe a device presence signature on this exact authenticated server connection.
   * @param observation - Independent canonical 32-byte base64url nonce and device Ed25519 signature.
   * @returns Resolves only after this connection acknowledges the exact presence nonce.
   */
  observeNativeH3DevicePresence(observation: NativeH3DevicePresenceObservation): Promise<void> {
    if (this.stage !== 'ready' || this.authenticatedConnectionId === null) throw new SupplyError('EDGE_NOT_CONNECTED')
    if (Object.keys(observation).sort().join(',') !== 'challengeNonce,signature'
      || !PRESENCE_NONCE.test(observation.challengeNonce)
      || Buffer.from(observation.challengeNonce, 'base64url').toString('base64url') !== observation.challengeNonce
      || !/^[A-Za-z0-9_-]{86}$/u.test(observation.signature)
      || Buffer.from(observation.signature, 'base64url').toString('base64url') !== observation.signature) {
      throw new SupplyError('EDGE_NATIVE_DEVICE_PRESENCE_INVALID')
    }
    const key = `native-presence:${observation.challengeNonce}`
    if (this.challengeAcks.size >= 8 || this.challengeAcks.has(key)) throw new SupplyError('EDGE_CHALLENGE_OBSERVATION_BUSY')
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.challengeAcks.delete(key)
        reject(new SupplyError('EDGE_NATIVE_DEVICE_PRESENCE_ACK_TIMEOUT'))
      }, 10_000)
      timer.unref()
      this.challengeAcks.set(key, { resolve, reject, timer })
      try { this.send('native_h3_device_presence', { challenge_nonce: observation.challengeNonce, signature: observation.signature }) }
      catch (error) {
        clearTimeout(timer)
        this.challengeAcks.delete(key)
        reject(error instanceof Error ? error : new SupplyError('EDGE_NOT_CONNECTED'))
      }
    })
  }

  /** Update only fixed native metadata on the current authenticated connection.
   * @param request - Bounded exact claims and a fresh request UUID; empty claims withdraw native only.
   * @returns Resolves only after this socket acknowledges the exact accepted task set.
   */
  updateNativeH3Adapters(request: { requestId: string; adapters: readonly NativeH3AdapterClaim[] }): Promise<void> {
    const connectionId = this.acknowledgedConnectionId()
    if (connectionId === null) throw new SupplyError('EDGE_NOT_CONNECTED')
    const keys = 'artifact_digest,capability_id,contract_sha256,contract_version,device_proof_sha256,health,input_kinds,installation_state,native_binding,output_kind,package_digest,publication_id,self_test,task_type'
    const rawAdapters: unknown = request.adapters
    if (Object.keys(request).sort().join(',') !== 'adapters,requestId' || !CHALLENGE_UUID.test(request.requestId)
      || !Array.isArray(rawAdapters) || rawAdapters.length > 16) throw new SupplyError('EDGE_NATIVE_ADAPTER_UPDATE_INVALID')
    const rows: readonly unknown[] = rawAdapters
    const adapters: NativeH3AdapterClaim[] = []
    for (const item of rows) {
      const expectedKeys = record(item) && item.contract_version === 'v2'
        ? keys.split(',').concat(['local_owner_config_digest', 'device_binding_revision']).sort().join(',') : keys
      if (!record(item) || Object.keys(item).sort().join(',') !== expectedKeys
        || typeof item.task_type !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(item.task_type)
        || item.capability_id !== 'video.render' || JSON.stringify(item.input_kinds) !== '["inline"]'
        || item.output_kind !== 'artifact_ref' || !['v1', 'v2'].includes(String(item.contract_version))
        || item.installation_state !== 'installed' || item.health !== 'verified' || item.self_test !== 'passed'
        || typeof item.publication_id !== 'string' || !CHALLENGE_UUID.test(item.publication_id)
        || typeof item.artifact_digest !== 'string' || !CHALLENGE_SHA.test(item.artifact_digest)
        || typeof item.package_digest !== 'string' || !CHALLENGE_SHA.test(item.package_digest)
        || typeof item.contract_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.contract_sha256)
        || typeof item.device_proof_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.device_proof_sha256)) {
        throw new SupplyError('EDGE_NATIVE_ADAPTER_UPDATE_INVALID')
      }
      const common = { task_type: item.task_type, capability_id: 'video.render' as const, input_kinds: ['inline'] as const,
        output_kind: 'artifact_ref' as const, artifact_digest: item.artifact_digest, package_digest: item.package_digest,
        installation_state: 'installed' as const, health: 'verified' as const, self_test: 'passed' as const,
        publication_id: item.publication_id, contract_sha256: item.contract_sha256, device_proof_sha256: item.device_proof_sha256 }
      if (item.contract_version === 'v2') {
        const binding = parseNativeH3PortableExecutionBinding(item.native_binding)
        if (item.package_digest !== 'sha256:' + nativeH3LogicalBindingSha256(binding)
          || typeof item.local_owner_config_digest !== 'string' || !CHALLENGE_SHA.test(item.local_owner_config_digest)
          || !Number.isSafeInteger(item.device_binding_revision) || Number(item.device_binding_revision) < 1) {
          throw new SupplyError('EDGE_NATIVE_ADAPTER_UPDATE_INVALID')
        }
        adapters.push({ ...common, contract_version: 'v2', native_binding: binding,
          local_owner_config_digest: item.local_owner_config_digest,
          device_binding_revision: Number(item.device_binding_revision) })
      } else {
        const binding = parseNativeH3ContractBinding(item.native_binding)
        if (binding.ownerConfigDigest !== item.package_digest) throw new SupplyError('EDGE_NATIVE_ADAPTER_UPDATE_INVALID')
        adapters.push({ ...common, contract_version: 'v1', native_binding: binding })
      }
    }
    if (new Set(adapters.map(item => item.task_type)).size !== adapters.length) throw new SupplyError('EDGE_NATIVE_ADAPTER_UPDATE_INVALID')
    const payload = { request_id: request.requestId, adapters }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 32 * 1024) throw new SupplyError('EDGE_NATIVE_ADAPTER_UPDATE_INVALID')
    const key = `native-update:${request.requestId}`
    if (this.challengeAcks.size >= 8 || this.challengeAcks.has(key)) throw new SupplyError('EDGE_CHALLENGE_OBSERVATION_BUSY')
    this.nativeAdapterTaskTypes = []
    this.nativeAdapterV2TaskTypes = []
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.challengeAcks.delete(key)
        reject(new SupplyError('EDGE_NATIVE_ADAPTER_UPDATE_ACK_TIMEOUT'))
      }, 10_000)
      timer.unref()
      this.challengeAcks.set(key, { resolve, reject, timer,
        nativeUpdate: { connectionId, taskTypes: adapters.map(item => item.task_type).sort(),
          v2TaskTypes: adapters.filter(item => item.contract_version === 'v2').map(item => item.task_type) } })
      try { this.send('native_h3_adapter_update', payload) }
      catch (error) {
        clearTimeout(timer); this.challengeAcks.delete(key)
        reject(error instanceof Error ? error : new SupplyError('EDGE_NOT_CONNECTED'))
      }
    })
  }

  /** Submit independently signed Comfy evidence for platform review on this ACK socket.
   * Only an exact accepted ACK admits that task type on this connection.
   */
  updateReviewedVideoAdapter(request: ReviewedVideoAdapterUpdate,
    signal?: AbortSignal): Promise<ReviewedVideoAdapterAck> {
    const connectionId = this.acknowledgedConnectionId()
    if (connectionId === null || signal?.aborted) throw new SupplyError('EDGE_NOT_CONNECTED')
    if (!this.options.protocolCapabilities?.includes('reviewed-video-supply.v1')
      || !record(request) || Object.keys(request).sort().join(',') !==
        'connection_id,device_key_id,device_signature_b64u,probe_payload_b64u,publication_id,request_id,sample_attestation,worker_id'
      || !CHALLENGE_UUID.test(request.request_id) || !CHALLENGE_UUID.test(request.publication_id)
      || request.connection_id !== connectionId || request.worker_id !== this.workerId
      || typeof request.device_key_id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(request.device_key_id)
      || typeof request.probe_payload_b64u !== 'string' || typeof request.device_signature_b64u !== 'string') {
      throw new SupplyError('EDGE_REVIEWED_VIDEO_UPDATE_INVALID')
    }
    let probe: Record<string, unknown>
    let probeBytes: Buffer
    try {
      probeBytes = Buffer.from(request.probe_payload_b64u, 'base64url')
      probe = JSON.parse(probeBytes.toString('utf8')) as Record<string, unknown>
    } catch { throw new SupplyError('EDGE_REVIEWED_VIDEO_UPDATE_INVALID') }
    const attestation = request.sample_attestation
    if (probeBytes.byteLength < 1 || probeBytes.byteLength > 16 * 1024
      || probeBytes.toString('base64url') !== request.probe_payload_b64u
      || !record(probe) || probe.schema !== 'qianshou.reviewed-video-host-probe.v1'
      || probe.worker_id !== this.workerId || probe.connection_id !== connectionId
      || probe.owner_account_id !== this.options.expectedOwnerId
      || probe.publication_id !== request.publication_id
      || probe.device_key_id !== request.device_key_id
      || probe.capability_id !== 'video.render' || probe.input_kind !== 'multi_file'
      || probe.output_kind !== 'artifact_ref'
      || typeof probe.task_type !== 'string' || !SAFE_NAME.test(probe.task_type)
      || typeof probe.approved_contract_digest !== 'string'
      || !CHALLENGE_SHA.test(probe.approved_contract_digest)
      || Buffer.from(request.device_signature_b64u, 'base64url').length !== 64
      || Buffer.from(request.device_signature_b64u, 'base64url').toString('base64url') !== request.device_signature_b64u
      || !record(attestation) || !record(attestation.payload)
      || attestation.payload.schema !== 'qianshou.reviewed-video-sample-attestation.v1'
      || attestation.payload.purpose !== 'qianshou.reviewed-video-sample-attestation.v1'
      || attestation.payload.probe_sha256 !== `sha256:${createHash('sha256').update(probeBytes).digest('hex')}`
      || attestation.payload.task_type !== probe.task_type
      || attestation.payload.device_key_id !== probe.device_key_id
      || typeof attestation.key_id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(attestation.key_id)
      || typeof attestation.signature !== 'string'
      || Buffer.from(attestation.signature, 'base64url').length !== 64
      || Buffer.from(attestation.signature, 'base64url').toString('base64url') !== attestation.signature
      || this.reviewedVideoAcks.size >= 8 || this.reviewedVideoAcks.has(request.request_id)
      || Buffer.byteLength(JSON.stringify(request), 'utf8') > 32 * 1024) {
      throw new SupplyError('EDGE_REVIEWED_VIDEO_UPDATE_INVALID')
    }
    this.reviewedVideoTaskType = null
    return new Promise<ReviewedVideoAdapterAck>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      const abort = (): void => { this.reviewedVideoAcks.delete(request.request_id)
        cleanup(); reject(new SupplyError('EDGE_REVIEWED_VIDEO_UPDATE_UNKNOWN')) }
      const timer = setTimeout(() => { this.reviewedVideoAcks.delete(request.request_id)
        cleanup(); reject(new SupplyError('EDGE_REVIEWED_VIDEO_UPDATE_ACK_TIMEOUT')) }, 10_000)
      timer.unref()
      signal?.addEventListener('abort', abort, { once: true })
      this.reviewedVideoAcks.set(request.request_id, {
        resolve: (ack) => { cleanup(); resolve(ack) }, reject: (error) => { cleanup(); reject(error) }, timer,
        connectionId, publicationId: request.publication_id, taskType: probe.task_type as string,
        approvedContractDigest: probe.approved_contract_digest as string,
      })
      try { this.send('reviewed_video_adapter_update', request) }
      catch (error) { this.reviewedVideoAcks.delete(request.request_id)
        cleanup(); reject(error instanceof Error ? error : new SupplyError('EDGE_NOT_CONNECTED')) }
    })
  }

  /** Send bounded progress with the exact stored server lease and authenticated identity tuple.
   * @param identity - Exact identity tuple received in the task offer.
   * @param fraction - Finite task progress between zero and one.
   */
  reportProgress(identity: EdgeTaskIdentity, fraction: number): void {
    const lease = this.lease(identity)
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new SupplyError('EDGE_PROGRESS_INVALID')
    const identityKey = key(identity)
    const previous = this.#progress.get(identityKey) ?? 0
    if (fraction < previous) throw new SupplyError('EDGE_PROGRESS_REGRESSION')
    this.#progress.set(identityKey, fraction)
    this.send('shard_progress', { shard_id: identity.shardId, attempt: identity.attempt, lease_token: lease.token, pct: fraction })
  }

  /** Submit the existing raw inline result form; query the core separately for actual acceptance.
   * @param identity - Exact identity tuple received in the task offer.
   * @param result - Raw UTF-8 text result and measured execution duration.
   * @returns A local send receipt that does not establish server acceptance.
   */
  complete(identity: EdgeTaskIdentity, result: EdgeInlineResult): EdgeResultSent {
    const lease = this.lease(identity)
    if (typeof result.inlineOutputUtf8 !== 'string' || Buffer.byteLength(result.inlineOutputUtf8) > this.options.maxOutputBytes
      || !Number.isSafeInteger(result.elapsedMs) || result.elapsedMs < 0) throw new SupplyError('EDGE_RESULT_INVALID')
    this.send('shard_result', { shard_id: identity.shardId, workload_id: identity.workloadId, worker_id: identity.workerId,
      attempt: identity.attempt, lease_token: lease.token, ok: true, inline_output: result.inlineOutputUtf8, elapsed_ms: result.elapsedMs })
    this.#progress.delete(key(identity))
    this.#leases.delete(key(identity))
    return { state: 'sent-awaiting-verification' }
  }

  /** Metadata goes to the platform; file bytes go directly to its signed object-store URL. */
  async uploadArtifact(identity: EdgeTaskIdentity, input: {
    readonly filename: string
    readonly contentType: 'image/gif' | 'video/mp4'
    readonly bytes: Uint8Array
  }, signal?: AbortSignal): Promise<EdgeArtifactManifest> {
    const lease = this.lease(identity)
    const token = this.options.tokenProvider()
    if (!token) throw new SupplyError('EDGE_AUTH_REQUIRED')
    const manifest = await uploadEdgeArtifact({
      origin: this.origin, token, leaseToken: lease.token, identity,
      ...input,
      ...(signal === undefined ? {} : { signal }),
      ...(this.options.artifactFetch === undefined ? {} : { fetch: this.options.artifactFetch }),
    })
    // The lease may have been cancelled while the PUT was in flight.
    this.lease(identity)
    this.#uploadedArtifacts.set(key(identity), manifest)
    return manifest
  }

  /**
   * Reviewed video only: one streamed PUT, exact-version Shanghai complete, then
   * store the manifest on this authenticated socket for `completeArtifact`.
   * The caller must be the signed-order resident route; buyer params are never a grant.
   */
  async uploadReviewedVideoFile(identity: EdgeTaskIdentity, input: {
    readonly sourcePath: string
    readonly expectedBytes: number
    readonly expectedSha256: string
    readonly resultId: string
    readonly storageOrigin: URL
  }, signal?: AbortSignal): Promise<EdgeArtifactManifest> {
    const lease = this.lease(identity)
    const offer = lease.identity as EdgeTaskOffer
    const identityKey = key(identity)
    if (offer.reviewedVideoOrder === undefined || this.#uploadedArtifacts.has(identityKey)
      || this.#reviewedVideoUploads.has(identityKey)) {
      throw new SupplyError('EDGE_REVIEWED_VIDEO_UPLOAD_DENIED')
    }
    this.#reviewedVideoUploads.add(identityKey)
    const controls = createShanghaiReviewedVideoFileControl({ origin: this.origin,
      tokenProvider: this.options.tokenProvider,
      ...(this.options.artifactFetch === undefined ? {} : { fetch: this.options.artifactFetch }),
      ...(signal === undefined ? {} : { signal }) })
    const assertLeaseActive = () => {
      if (this.lease(identity).token !== lease.token) throw new SupplyError('EDGE_LEASE_EXPIRED')
      return Promise.resolve()
    }
    const manifest = await uploadEdgeVideoFile({ ...input, identity, leaseToken: lease.token,
      controlOrigin: this.origin, assertLeaseActive,
      issueUpload: controls.issueUpload, completeUpload: controls.completeUpload,
      ...(signal === undefined ? {} : { signal }),
      ...(this.options.artifactFetch === undefined ? {} : { fetch: this.options.artifactFetch }) })
    await assertLeaseActive()
    this.#uploadedArtifacts.set(identityKey, manifest)
    return manifest
  }

  /** Read only a server-frozen slot belonging to the current authenticated file assignment. */
  async readFileAttachment(identity: EdgeTaskIdentity, input: {
    readonly slot: string
    readonly maxBytes: number
    readonly contentTypes: readonly string[]
    readonly contractSha256: string
    readonly fileSchemaSha256: string
    readonly trustedStorageHostname: string
  }, signal?: AbortSignal): Promise<{ contentType: string; sha256: string; bytes: Uint8Array }> {
    const lease = this.lease(identity)
    const offer = lease.identity as EdgeTaskOffer
    const contract = offer.fileContract
    const artifact = contract?.attachments[input.slot]?.artifact
    const token = this.options.tokenProvider()
    if (!token || contract === undefined || artifact === undefined || contract.contract_sha256 !== input.contractSha256
      || contract.file_schema_sha256 !== input.fileSchemaSha256) throw new SupplyError('EDGE_ATTACHMENT_READ_DENIED')
    const result = await readPinnedFileAttachment({ coreOrigin: this.origin, trustedStorageHostname: input.trustedStorageHostname,
      pinned: { objectKey: artifact.object_key, objectVersionId: artifact.object_version_id, sha256: artifact.sha256,
        sizeBytes: artifact.size_bytes, contentType: artifact.content_type }, maxBytes: input.maxBytes, contentTypes: input.contentTypes,
      authorize: () => requestAttachmentReadCredential({ origin: this.origin, token, leaseToken: lease.token, identity,
        fileContract: contract, slot: input.slot, ...(signal === undefined ? {} : { signal }),
        ...(this.options.artifactFetch === undefined ? {} : { fetch: this.options.artifactFetch }) }),
      ...(signal === undefined ? {} : { signal }),
      ...(this.options.artifactFetch === undefined ? {} : { fetch: this.options.artifactFetch }) })
    this.lease(identity)
    return result
  }

  /** Upload bounded file output under this same current lease, then remember its exact manifest. */
  async uploadFileArtifact(identity: EdgeTaskIdentity, input: {
    readonly filename: string
    readonly contentType: string
    readonly bytes: Uint8Array
    readonly contractSha256: string
    readonly fileSchemaSha256: string
  }, signal?: AbortSignal): Promise<EdgeArtifactManifest> {
    const lease = this.lease(identity)
    const contract = (lease.identity as EdgeTaskOffer).fileContract
    const token = this.options.tokenProvider()
    if (!token || contract === undefined || contract.contract_sha256 !== input.contractSha256
      || contract.file_schema_sha256 !== input.fileSchemaSha256 || input.bytes.byteLength < 1 || input.bytes.byteLength > 16 * 1024) {
      throw new SupplyError('EDGE_FILE_CONTRACT_INVALID')
    }
    const manifest = await uploadEdgeArtifact({ origin: this.origin, token, leaseToken: lease.token, identity,
      filename: input.filename, contentType: input.contentType, bytes: input.bytes,
      ...(signal === undefined ? {} : { signal }),
      ...(this.options.artifactFetch === undefined ? {} : { fetch: this.options.artifactFetch }) })
    this.lease(identity)
    if (manifest.account_id !== contract.account_id) throw new SupplyError('EDGE_FILE_CONTRACT_INVALID')
    this.#uploadedArtifacts.set(key(identity), manifest)
    return manifest
  }

  /** Submit only a reference this connection uploaded for the same active lease. */
  completeArtifact(identity: EdgeTaskIdentity, result: EdgeArtifactResult): EdgeResultSent {
    const lease = this.lease(identity)
    const uploaded = this.#uploadedArtifacts.get(key(identity))
    if (!uploaded || !Number.isSafeInteger(result.elapsedMs) || result.elapsedMs < 0
      || JSON.stringify(uploaded) !== JSON.stringify(result.artifact)) {
      throw new SupplyError('EDGE_ARTIFACT_RESULT_INVALID')
    }
    const artifact = uploaded
    this.send('shard_result', {
      shard_id: identity.shardId, workload_id: identity.workloadId, worker_id: identity.workerId,
      attempt: identity.attempt, lease_token: lease.token, ok: true,
      output_ref: JSON.stringify(artifact), artifact, elapsed_ms: result.elapsedMs,
    })
    this.#uploadedArtifacts.delete(key(identity))
    this.#reviewedVideoUploads.delete(key(identity))
    this.#progress.delete(key(identity))
    this.#leases.delete(key(identity))
    return { state: 'sent-awaiting-verification' }
  }

  /** Report a refusal on the result frame the server already parses for failures.
   *
   * The server's `shard_result` contract accepts `ok: false` with the lease token and
   * the error fields as its only requirements, and that is the only failure form the
   * wire can express — there is no separate rejection frame type. Sending it is what
   * lets the scheduler stop waiting for a lease that will never be fulfilled.
   * @param identity - Exact identity tuple received in the task offer.
   * @param failure - Stable machine code plus a bounded human reason.
   */
  reject(identity: EdgeTaskIdentity, failure: EdgeTaskFailure): void {
    const lease = this.lease(identity)
    this.sendReject(identity, lease.token, failure)
    // Forget the tuple as well as the lease: the server has been told this node will
    // not run it, so a re-issued delivery of the same tuple is a new decision, not a
    // duplicate of one already answered.
    this.#progress.delete(key(identity))
    this.#uploadedArtifacts.delete(key(identity))
    this.#reviewedVideoUploads.delete(key(identity))
    this.#leases.delete(key(identity))
    this.#seen.delete(key(identity))
  }

  /** Encode one refusal with an already-known lease token.
   *
   * Split out because the pre-admission gates (scope, supply mode) refuse an offer
   * that never entered the lease table, and those are exactly the refusals the
   * scheduler most needs to hear about.
   */
  private sendReject(identity: EdgeTaskIdentity, token: string, failure: EdgeTaskFailure): void {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(failure.code)) throw new SupplyError('EDGE_REJECT_CODE_INVALID')
    const message = failure.message.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 512)
    this.send('shard_result', { shard_id: identity.shardId, workload_id: identity.workloadId, worker_id: identity.workerId,
      attempt: identity.attempt, lease_token: token, ok: false,
      error: message === '' ? failure.code : `${failure.code}: ${message}`, failure_class: failure.code })
  }

  /** Stop networking and abort/drain Host callbacks that honor their connection AbortSignal.
   * @returns Completion after all active Host callbacks settle.
   */
  async close(): Promise<void> {
    this.fail('EDGE_CLOSED')
    await Promise.allSettled([...this.callbacks])
  }

  private receive(data: unknown, token: string): void {
    if (typeof data !== 'string' || Buffer.byteLength(data) > this.options.maxFrameBytes) throw new Error('invalid frame size')
    const frame: unknown = JSON.parse(data)
    // 信封校验刻意保持原样：`v`/`type`/`payload` 三者不成立就是**真正非法**的帧，
    // 仍走既有边界（`EDGE_PROTOCOL_INVALID`）。工单 2 只放宽"不认识的帧类型"，没有放宽信封。
    if (!record(frame) || frame.v !== '8.0' || !record(frame.payload) || typeof frame.type !== 'string') throw new Error('invalid frame')
    const payload = frame.payload
    const type = frame.type
    if (type === 'err') { this.fail('EDGE_SERVER_REJECTED'); return }
    if (this.stage === 'welcome') {
      // 不认识的帧类型（以及认识的类型出现在错误阶段）一律**忽略 + 留痕**，绝不因此拆会话。
      // 握手仍由 `handshakeTimeoutMs` 兜底：没有真 welcome 就永远走不到 auth。
      if (type !== 'welcome') { this.ignoreFrame(type); return }
      if (!integer(payload.hb_interval_s, 1) || payload.hb_interval_s > 3600) throw new Error('invalid welcome')
      this.intervalSeconds = payload.hb_interval_s
      // The server's own ack tolerance is the only non-invented liveness bound. It is read
      // when present; otherwise the interval is used with the same slack.
      this.ackTimeoutMs = integer(payload.hb_timeout_s, 1) && payload.hb_timeout_s <= 86_400
        ? payload.hb_timeout_s * 1000
        : this.intervalSeconds * 1000 * 3
      this.readFeatures(payload.features)
      this.stage = 'auth'
      this.send('auth', { access_token: token, name: this.options.name }); return
    }
    if (this.stage === 'auth') {
      if (type !== 'auth_ok') { this.ignoreFrame(type); return }
      if (!identifier(payload.worker_id) || payload.owner_id !== this.options.expectedOwnerId) throw new Error('identity mismatch')
      if (payload.connection_id !== undefined && (typeof payload.connection_id !== 'string'
        || !CHALLENGE_UUID.test(payload.connection_id))) throw new Error('invalid connection identity')
      this.authenticatedConnectionId = typeof payload.connection_id === 'string' ? payload.connection_id : null
      this.workerId = payload.worker_id; this.stage = 'ready'; clearTimeout(this.deadline)
      this.options.onEvent({ type: 'authenticated', workerId: this.workerId, ownerId: this.options.expectedOwnerId })
      this.sendHeartbeat()
      if (this.lifetime.signal.aborted) return
      this.heartbeat = setInterval(() =>{  this.sendHeartbeat() }, this.intervalSeconds * 1000)
      this.resolveConnect?.(); return
    }
    if (this.stage !== 'ready') return
    if (type === 'hb_ack') {
      this.lastHeartbeatAckAt = this.clockNow()
      this.cancelWatchdog(); this.options.onEvent({ type: 'heartbeat-acknowledged' }); return
    }
    if (type === 'order_adapter_challenge_ack') {
      const nonce = payload.challenge_nonce
      if (typeof nonce !== 'string' || !CHALLENGE_UUID.test(nonce)) throw new Error('invalid challenge ack')
      const pending = this.challengeAcks.get(nonce)
      if (pending === undefined) { this.ignoreFrame(type); return }
      this.challengeAcks.delete(nonce); clearTimeout(pending.timer); pending.resolve(); return
    }
    if (type === 'native_h3_device_key_proof_ack') {
      const challengeId = payload.challenge_id
      if (Object.keys(payload).length !== 1 || typeof challengeId !== 'string' || !CHALLENGE_UUID.test(challengeId)) {
        throw new Error('invalid native device proof ack')
      }
      const key = `native:${challengeId}`
      const pending = this.challengeAcks.get(key)
      if (pending === undefined) { this.ignoreFrame(type); return }
      this.challengeAcks.delete(key); clearTimeout(pending.timer); pending.resolve(); return
    }    if (type === 'native_h3_device_config_proof_ack') {
      const challengeId = payload.challenge_id
      if (Object.keys(payload).length !== 1 || typeof challengeId !== 'string' || !CHALLENGE_UUID.test(challengeId)) {
        throw new Error('invalid native device proof ack')
      }
      const key = `native-config:${challengeId}`
      const pending = this.challengeAcks.get(key)
      if (pending === undefined) { this.ignoreFrame(type); return }
      this.challengeAcks.delete(key); clearTimeout(pending.timer); pending.resolve(); return
    }
    if (type === 'native_h3_device_presence_ack') {
      const nonce = payload.challenge_nonce
      if (Object.keys(payload).length !== 1 || typeof nonce !== 'string' || !PRESENCE_NONCE.test(nonce)
        || Buffer.from(nonce, 'base64url').toString('base64url') !== nonce) {
        throw new Error('invalid native device presence ack')
      }
      const key = `native-presence:${nonce}`
      const pending = this.challengeAcks.get(key)
      if (pending === undefined) { this.ignoreFrame(type); return }
      this.challengeAcks.delete(key); clearTimeout(pending.timer); pending.resolve(); return
    }
    if (type === 'native_h3_adapter_update_ack') {
      const requestId = payload.request_id
      if (Object.keys(payload).sort().join(',') !== 'connection_id,request_id,status,task_types'
        || typeof requestId !== 'string' || !CHALLENGE_UUID.test(requestId)
        || typeof payload.connection_id !== 'string' || !CHALLENGE_UUID.test(payload.connection_id)
        || !['accepted', 'rejected'].includes(String(payload.status)) || !Array.isArray(payload.task_types)
        || payload.task_types.length > 16 || payload.task_types.some(type => typeof type !== 'string')) {
        throw new Error('invalid native adapter update ack')
      }
      const key = `native-update:${requestId}`
      const pending = this.challengeAcks.get(key)
      if (pending?.nativeUpdate === undefined) { this.ignoreFrame(type); return }
      this.challengeAcks.delete(key); clearTimeout(pending.timer)
      if (payload.connection_id !== this.acknowledgedConnectionId()
        || payload.connection_id !== pending.nativeUpdate.connectionId
        || payload.status !== 'accepted'
        || JSON.stringify([...(payload.task_types as string[])].sort()) !== JSON.stringify(pending.nativeUpdate.taskTypes)) {
        pending.reject(new SupplyError('EDGE_NATIVE_ADAPTER_UPDATE_REJECTED')); return
      }
      this.nativeAdapterTaskTypes = Object.freeze([...pending.nativeUpdate.taskTypes])
      this.nativeAdapterV2TaskTypes = Object.freeze([...pending.nativeUpdate.v2TaskTypes])
      pending.resolve(); return
    }
    if (type === 'reviewed_video_adapter_update_ack') {
      if (Object.keys(payload).sort().join(',') !==
        'approved_contract_digest,connection_id,publication_id,request_id,status,task_type'
        || typeof payload.request_id !== 'string' || !CHALLENGE_UUID.test(payload.request_id)
        || typeof payload.connection_id !== 'string' || !CHALLENGE_UUID.test(payload.connection_id)
        || typeof payload.publication_id !== 'string' || !CHALLENGE_UUID.test(payload.publication_id)
        || typeof payload.task_type !== 'string' || !SAFE_NAME.test(payload.task_type)
        || typeof payload.approved_contract_digest !== 'string'
        || !CHALLENGE_SHA.test(payload.approved_contract_digest)
        || payload.status !== 'accepted' && payload.status !== 'rejected') {
        throw new Error('invalid reviewed video adapter update ack')
      }
      const pending = this.reviewedVideoAcks.get(payload.request_id)
      if (pending === undefined) { this.ignoreFrame(type); return }
      this.reviewedVideoAcks.delete(payload.request_id)
      if (payload.connection_id !== this.acknowledgedConnectionId()
        || payload.connection_id !== pending.connectionId || payload.status !== 'accepted'
        || payload.publication_id !== pending.publicationId || payload.task_type !== pending.taskType
        || payload.approved_contract_digest !== pending.approvedContractDigest) {
        pending.reject(new SupplyError('EDGE_REVIEWED_VIDEO_UPDATE_REJECTED')); return
      }
      this.reviewedVideoTaskType = pending.taskType
      pending.resolve(payload as unknown as ReviewedVideoAdapterAck); return
    }
    if (type === 'control') { this.handleMarketplaceControl(payload); return }
    if (type === 'shard_cancel') { this.fail('EDGE_CANCEL_RECONCILIATION_REQUIRED'); return }
    if (type !== 'shard_assign') {
      // 未知帧的第二条去路：协商过的可选帧交给处理器；其余仍然只是忽略 + 留痕。
      if (this.interpretOptionalFrame(type, payload)) return
      this.ignoreFrame(type); return
    }
    const offer = parseOffer(payload, this.workerId, this.options.expectedOwnerId, this.acknowledgedConnectionId())
    if (this.nativeAdapterV2TaskTypes.includes(offer.taskType) && offer.nativeDeviceLease === undefined) {
      this.sendReject(offer, String(payload.lease_token), {
        code: 'H3_NATIVE_TASK_LEASE_INVALID', message: 'server-frozen native device lease is required',
      })
      return
    }
    // Both gates below refuse one assignment instead of tearing the session down.
    //
    // Measured against the real scheduler (2026-09-17): when the node sent the refusal
    // and closed the socket 5 ms later, the server reset the shard to `PENDING` with
    // `worker_id: null` and `error: ""` — the reason was discarded and the shard was
    // re-queued. Sending the same refusal with the socket still open left the shard
    // `FAILED` carrying our `error`/`failure_class` verbatim, and the developer task
    // reported `1/1 个分片失败: <code>: <reason>`. Closing also kills this node's other
    // in-flight work, so keeping the session is both more informative and less lossy.
    if (!this.options.allowedTaskTypes.includes(offer.taskType) && !this.nativeAdapterTaskTypes.includes(offer.taskType)
      && this.reviewedVideoTaskType !== offer.taskType) {
      this.sendReject(offer, String(payload.lease_token), {
        code: 'EDGE_TASK_SCOPE_DENIED',
        message: `task type ${offer.taskType} is not advertised by this node`,
      })
      return
    }
    if (this.mode !== 'running') {
      this.sendReject(offer, String(payload.lease_token), {
        code: 'EDGE_SUPPLY_WITHDRAWN',
        message: `local supply policy is ${this.mode}`,
      })
      return
    }
    const leaseKey = key(offer)
    if (this.#seen.has(leaseKey)) {
      const active = this.#leases.get(leaseKey)
      if (active) active.token = payload.lease_token as string
      return // One callback per delivered tuple, including after a result was sent.
    }
    for (const lease of this.#leases.values()) {
      if (lease.identity.shardId === offer.shardId) { this.fail('EDGE_ATTEMPT_RECONCILIATION_REQUIRED'); return }
    }
    this.#seen.add(leaseKey); this.#leases.set(leaseKey, { identity: offer, token: payload.lease_token as string })
    const callback = Promise.resolve().then(() => {
      this.lifetime.signal.throwIfAborted()
      return this.options.onOffer(offer, this.lifetime.signal)
    })
      .catch(() =>{  this.fail('EDGE_EXECUTION_CALLBACK_FAILED') })
    this.callbacks.add(callback); void callback.finally(() => this.callbacks.delete(callback))
  }

  /**
   * Resolve marketplace provisioning with an honest failure receipt. The server's
   * current bundle fields are publisher-supplied URLs, a SHA and a `signed` flag;
   * none establishes a verified publisher signature or an executable package
   * compatible with this Host. Never fetch, install or claim success from them.
   * Other control actions belong to a different executor and remain ignored.
   */
  private handleMarketplaceControl(payload: Record<string, unknown>): void {
    const action = payload.action
    if (action !== 'install_app' && action !== 'uninstall_app') { this.ignoreFrame('control'); return }
    const controlId = payload.control_id
    // Shanghai currently issues uuid4.hex. An invalid ID cannot match a stored
    // attempt, so do not reflect it back as a purported provisioning receipt.
    if (typeof controlId !== 'string' || !/^[0-9a-f]{32}$/u.test(controlId)) {
      this.ignoreFrame('control'); return
    }
    const expiresAt = payload.expires_at_ms
    const detail = typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt)
      && expiresAt > 0 && expiresAt < this.clockNow()
      ? 'APP_CONTROL_EXPIRED: marketplace instruction has expired'
      : action === 'install_app'
        ? 'APP_PACKAGE_VERIFICATION_UNAVAILABLE: no verified publisher signature or trusted bundle contract'
        : 'APP_UNINSTALL_EXECUTOR_UNAVAILABLE: no verified marketplace installation registry'
    this.send('control_result', { control_id: controlId, action, ok: false, detail, elapsed_ms: 0 })
  }

  private sendHeartbeat(): void {
    if (this.stage !== 'ready') return
    try { this.send('hb', { load: this.options.readLoad(), active_shards: this.#leases.size, mode: this.mode,
      throttle_pct: this.mode === 'running' ? 100 : 0 }) } catch { this.fail('EDGE_HEARTBEAT_FAILED'); return }
    this.lastHeartbeatSentAt = this.clockNow()
    this.armWatchdog()
  }

  /**
   * 忽略一个入站帧并留痕：类型、次数、首次/最近时刻。
   *
   * 留痕表有界（最多 `MAX_IGNORED_FRAME_TYPES` 条），超出的只进总数——未知帧可以无限来，
   * 内存不能被对端牵着走。这条路**永不**调用 `fail`。
   * @param type - 入站帧的类型名（原样，只在留痕时做字符净化与截断）。
   */
  private ignoreFrame(type: string): void {
    const at = this.clockNow()
    const classification: 'unknown-type' | 'out-of-stage' = KNOWN_FRAME_TYPES.has(type) ? 'out-of-stage' : 'unknown-type'
    const frameType = type.replace(CONTROL_CHARACTERS, ' ').slice(0, 64)
    const existing = this.ignored.get(frameType)
    this.ignoredTotal += 1
    let record: EdgeIgnoredFrameRecord
    if (existing) {
      existing.count += 1; existing.lastSeenAt = at
      record = { ...existing }
    } else if (this.ignored.size < MAX_IGNORED_FRAME_TYPES) {
      const created = { frameType, count: 1, firstSeenAt: at, lastSeenAt: at, classification }
      this.ignored.set(frameType, created)
      record = { ...created }
    } else {
      this.ignoredOverflow += 1
      record = { frameType, count: 1, firstSeenAt: at, lastSeenAt: at, classification }
    }
    try { this.options.onIgnoredFrame?.(record) } catch { /* 留痕回调不得反过来拆会话。 */ }
  }

  /**
   * 读 `welcome.features`（能力协商，工单 2 第 2 项）。
   *
   * 缺省即关闭：形状不是字符串数组 ⇒ 当作"平台什么都没声明"；本节点没声明 ⇒ 同样不解释。
   * 于是「平台声明 ∩ 节点声明 ∩ 本构建有处理器」三件同时成立才有一帧可选帧被解释。
   * @param value - `welcome.payload.features` 的原始值。
   */
  private readFeatures(value: unknown): void {
    this.platformFeatures = Object.freeze(Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string' && SAFE_NAME.test(item)))]
      : [])
    this.negotiated = new Set(this.platformFeatures.filter(name => this.supportedFeatures.includes(name)))
  }

  /**
   * 把一帧协商通过的可选帧交给处理器。
   * @param type - 入站帧类型。
   * @param payload - 已确认是对象的帧载荷。
   * @returns 该帧是否已被解释（false ⇒ 调用方按未知帧忽略并留痕）。
   */
  private interpretOptionalFrame(type: string, payload: Record<string, unknown>): boolean {
    const handler = this.options.onOptionalFrame
    if (!handler || !this.negotiated.has(type)) return false
    try { handler(type, payload) } catch { /* 可选帧处理器抛错不得拆会话：协商结果与留痕仍在快照里可查。 */ }
    return true
  }

  /**
   * 握手与链路可观测快照，供节点可见性（工单 5、6 的状态面）读取。
   *
   * 只含状态、计数与时刻：**不含凭据、不含帧体**，因此可以安全地放进本机状态端点响应。
   * @returns 当前握手/心跳/协商/留痕的即时快照。
   */
  observe(): EdgeHandshakeObservability {
    return {
      stage: this.stage,
      closeReason: this.stage === 'closed' ? this.closeReason : null,
      workerId: this.workerId,
      heartbeat: {
        intervalSeconds: this.intervalSeconds,
        ackTimeoutMs: this.ackTimeoutMs,
        lastSentAt: this.lastHeartbeatSentAt,
        lastAckAt: this.lastHeartbeatAckAt,
        awaitingAckSince: this.awaitingAckSince,
        healthy: this.stage === 'ready' && this.awaitingAckSince === null,
      },
      features: {
        platform: this.platformFeatures,
        supported: this.supportedFeatures,
        negotiated: Object.freeze([...this.negotiated]),
        interpreted: Object.freeze(this.options.onOptionalFrame ? [...this.negotiated] : []),
      },
      ignoredFrames: {
        total: this.ignoredTotal,
        overflow: this.ignoredOverflow,
        records: Object.freeze([...this.ignored.values()].map(item => Object.freeze({ ...item }))),
      },
    }
  }

  /**
   * Start the post-auth peer-liveness deadline for the heartbeat just sent.
   *
   * Why this exists (measured 2026-09-17 with a real gateway that stopped answering after
   * `auth_ok`): a TCP session can stay open while the peer never answers again — a killed
   * gateway process, a half-dead socket, or a NAT/route change that drops frames silently.
   * Outbound `hb` frames keep succeeding into that socket, so without a deadline this node
   * reported a live session for as long as it was observed (30 s / 35 `hb` frames, zero
   * reconnects) while the platform had already stopped routing to it.
   *
   * The bound is the server's own `welcome.hb_timeout_s`, measured from the last `hb_ack` —
   * not from this send. Measuring from the send would restart the deadline on every heartbeat
   * and, at the production cadence (hb_interval_s 15 / hb_timeout_s 45), the timer would then
   * never fire at all.
   */
  private armWatchdog(): void {
    clearTimeout(this.watchdog)
    if (this.ackTimeoutMs < 1) { this.fail('EDGE_HEARTBEAT_TIMEOUT'); return }
    this.awaitingAckSince ??= this.clockNow()
    const remaining = this.awaitingAckSince + this.ackTimeoutMs - this.clockNow()
    if (remaining <= 0) { this.fail('EDGE_HEARTBEAT_TIMEOUT'); return }
    this.watchdog = setTimeout(() =>{  this.fail('EDGE_HEARTBEAT_TIMEOUT') }, remaining)
  }

  private cancelWatchdog(): void {
    this.awaitingAckSince = null
    clearTimeout(this.watchdog)
  }

  private send(type: string, payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new SupplyError('EDGE_NOT_CONNECTED')
    this.socket.send(JSON.stringify({ v: '8.0', type, payload }))
  }
  private lease(identity: EdgeTaskIdentity) {
    this.assertReady()
    const lease = this.#leases.get(key(identity))
    if (!lease) throw new SupplyError('EDGE_LEASE_NOT_ACTIVE')
    return lease
  }
  private assertReady(): void { if (this.stage !== 'ready') throw new SupplyError(this.closeReason) }
  private fail(reason: string): void {
    if (this.stage === 'closed') return
    this.stage = 'closed'; this.closeReason = reason; clearTimeout(this.deadline); clearInterval(this.heartbeat)
    // 定时器必须清掉，但 `awaitingAckSince` 要**留着**：它记的是"最后一拍没被应答的心跳发出的时刻"，
    // 而关链之后正是可见性最需要读它的时刻（`observe().heartbeat`）。清掉它等于把手里的证据丢掉。
    clearTimeout(this.watchdog)
    for (const pending of this.challengeAcks.values()) {
      clearTimeout(pending.timer); pending.reject(new SupplyError(reason))
    }
    this.challengeAcks.clear()
    for (const pending of this.reviewedVideoAcks.values()) {
      clearTimeout(pending.timer); pending.reject(new SupplyError(reason))
    }
    this.reviewedVideoAcks.clear()
    this.reviewedVideoTaskType = null
    this.lifetime.abort(); this.#leases.clear(); this.#uploadedArtifacts.clear(); this.#reviewedVideoUploads.clear(); this.#seen.clear()
    this.#progress.clear(); this.socket?.close()
    this.rejectConnect?.(new SupplyError(reason)); this.options.onEvent({ type: 'closed', reason })
  }
}

function parseOffer(value: Record<string, unknown>, workerId: string, ownerId?: number, connectionId: string | null = null): EdgeTaskOffer {
  if (!identifier(value.workload_id) || !identifier(value.shard_id) || !integer(value.attempt, 0)
    || !text(value.task_type) || !text(value.runtime) || !text(value.input_kind)
    || !(value.inline_input === null || typeof value.inline_input === 'string') || typeof value.input_ref !== 'string'
    || !Array.isArray(value.input_refs) || !value.input_refs.every(item => typeof item === 'string')
    || (value.params !== undefined && !record(value.params))
    || typeof value.code_url !== 'string' || typeof value.code_sha256 !== 'string' || !integer(value.timeout_s, 1)
    || !['semantic', 'artifact', 'quarantine'].includes(String(value.verification_policy))
    || typeof value.execution_model !== 'string' || typeof value.capability !== 'string' || typeof value.capability_version !== 'string'
    || !text(value.lease_token)) throw new Error('invalid assignment')
  const nativeDeviceLease = value.native_device_lease === undefined || value.native_device_lease === null ? undefined
    : parseNativeH3TaskLeaseV2(value.native_device_lease, { ownerId: ownerId ?? -1, deviceId: workerId,
      connectionId: connectionId ?? '', taskType: value.task_type, workloadId: value.workload_id,
      shardId: value.shard_id, attempt: value.attempt })
  if (nativeDeviceLease !== undefined && !integer(value.account_id, 1)) throw new Error('invalid native buyer')
  return Object.freeze({ workerId, workloadId: value.workload_id, shardId: value.shard_id, attempt: value.attempt,
    taskType: value.task_type, runtime: value.runtime, inputKind: value.input_kind, inlineInput: value.inline_input,
    inputRef: value.input_ref, inputRefs: Object.freeze([...value.input_refs]),
    ...nativeDeviceLease === undefined ? {} : { nativeDeviceLease },
    params: Object.freeze({ ...(record(value.params) ? value.params : {}) }),
    codeUrl: value.code_url, codeSha256: value.code_sha256,
    timeoutSeconds: value.timeout_s, verificationPolicy: value.verification_policy as EdgeTaskOffer['verificationPolicy'],
    executionModel: value.execution_model, capability: value.capability, capabilityVersion: value.capability_version,
    runtimeApi: typeof value.runtime_api === 'string' ? value.runtime_api : '',
    leaseTokenSha256: createHash('sha256').update(value.lease_token).digest('hex'),
    ...(value.reviewed_video_order === undefined ? {} : { reviewedVideoOrder: value.reviewed_video_order }),
    ...(value.file_contract === undefined || value.file_contract === null ? {} : {
      fileContract: parseEdgeFileContract(value.file_contract, value.task_type, value.account_id as number),
    }) })
}
function key(value: EdgeTaskIdentity): string { return JSON.stringify([value.workerId, value.workloadId, value.shardId, value.attempt]) }

function identifier(value: unknown): value is string { return typeof value === 'string' && /^[\w-]{1,256}$/.test(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function integer(value: unknown, minimum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum }

/**
 * 有上限、有抖动、可审计的重连退避（工单 2 第 4 项）。
 *
 * 为什么这不是"顺手加个 Math.min"：恒定或不受限的重试会把节点变成对网关的持续压力源，
 * 而**同时**重连的一群节点（网关刚重启）会把流量汇成一堵齐步高峰。所以这里三件事缺一不可：
 *
 * 1. **指数 + 封顶**：`min(maxMs, baseMs · 2^(attempt-1))`，延迟恒在 `[1, maxMs]`；
 * 2. **抖动**：乘以 `1 - r + 2r·random()`，把"齐步重连"摊开；`random` 可注入 ⇒ 可确定性回归；
 * 3. **审计**：每次重连记下**原因**与**上一次会话活了多久**，断线趋势才有证据可查。
 *
 * 本类只做决策与留痕，不碰网络也不碰定时器：真正的等待与连接由调用方（节点守护进程）执行，
 * 这样策略本身可以在毫秒内被时间推进验证（见 `tests/edge-worker/connection-tolerance.spec.ts`）。
 */
export class EdgeReconnectBackoff {
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly jitterRatio: number
  private readonly random: () => number
  private readonly clock: () => number
  private attempts = 0
  private readonly plans: EdgeReconnectPlan[] = []

  /** @param options - 起始延迟、上限、抖动比例，以及可注入的随机源与时钟。
   */
  constructor(options: EdgeReconnectBackoffOptions = {}) {
    const baseMs = options.baseMs ?? 1_000
    const maxMs = options.maxMs ?? 60_000
    const jitterRatio = options.jitterRatio ?? 0.25
    if (!Number.isSafeInteger(baseMs) || baseMs < 1 || !Number.isSafeInteger(maxMs) || maxMs < baseMs
      || !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new SupplyError('EDGE_RECONNECT_CONFIG_INVALID')
    this.baseMs = baseMs; this.maxMs = maxMs; this.jitterRatio = jitterRatio
    this.random = options.random ?? (() => Math.random())
    this.clock = options.clock ?? (() => Date.now())
  }

  /** @returns 已计划过的重连次数（`reset` 之后归零）。
   */
  get attempt(): number { return this.attempts }

  /**
   * 计划下一次重连。
   * @param reason - 上一次断开/失败的原因码，原样进审计轨迹。
   * @param lastSessionMs - 上一次连接从头到尾持续了多久（毫秒）。
   * @returns 冻结的本次计划（含延迟、原因、上次会话耗时与时刻）。
   */
  next(reason: string, lastSessionMs = 0): EdgeReconnectPlan {
    this.attempts += 1
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.attempts - 1, 30))
    const draw = Math.min(1, Math.max(0, this.random()))
    const jittered = Math.round(ceiling * (1 - this.jitterRatio + 2 * this.jitterRatio * draw))
    const plan = Object.freeze({ attempt: this.attempts, delayMs: Math.max(1, Math.min(this.maxMs, jittered)),
      reason: reason.trim() === '' ? 'EDGE_RECONNECT_UNSPECIFIED' : reason.trim().slice(0, 128),
      lastSessionMs: Number.isFinite(lastSessionMs) && lastSessionMs > 0 ? Math.round(lastSessionMs) : 0,
      at: this.clock() })
    this.plans.push(plan)
    return plan
  }

  /** 连接成功上线后清零重连计数；审计轨迹保留（它是记录，不是计数器）。 */
  reset(): void { this.attempts = 0 }

  /** @returns 按时间顺序的重连审计轨迹副本。 */
  history(): readonly EdgeReconnectPlan[] { return [...this.plans] }
}
