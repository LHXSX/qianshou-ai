/** Private Host data and the redacted two-mode compute-sharing response. */
import type { MediaNodeCapability, MediaNodeDelivery } from './media-node-channel.ts'

/** The product offers two independently saved supply choices. */
export type SharingMode = 'image' | 'video'
/** Explicit versioned permission; old saved intent conveys neither permission. */
export interface SharingConsent {
  readonly version: 'qianshou.media-sharing-consent.v1'
  readonly connection: true
  readonly execution: 'disabled' | 'idle_only'
}
/** Current-device permission projection; identities and private policy records remain in Host. */
export interface SharingAuthorization {
  readonly connection: 'required' | 'granted' | 'revoked'
  readonly execution: 'disabled' | 'idle_only'
  readonly deviceBound: boolean
}
/** Intent commits are reconciled through current-owner GET, never an automatic repeated POST. */
export type SharingAction = 'enable' | 'pause' | 'resume' | 'revoke'
export interface SharingOperation {
  readonly requestId: string
  readonly mode: SharingMode | null
  readonly action: SharingAction | null
  readonly status: 'applied' | 'not_found'
}
/** Observed local preparation and intake state; progress never implies billing. */
export type SharingPhase = 'idle' | 'detecting' | 'matching' | 'downloading' | 'installing' | 'starting'
  | 'connecting' | 'recovering' | 'sharing' | 'paused' | 'blocked' | 'failed'
/** Finite reasons accepted by the existing renderer. */
export type SharingReason = 'catalog_unavailable' | 'hardware_unsupported' | 'disk_space' | 'login_required'
  | 'verification_pending' | 'runtime_unavailable' | 'connection_unavailable' | 'download_failed' | 'owner_policy_blocked'
  | 'consent_required' | 'idle_required' | 'resource_unavailable' | 'execution_disabled'
/** Public gateway reachability and separately observed authenticated device/session evidence. */
export interface SharingConnectionState {
  readonly gateway: 'unknown' | 'unconfigured' | 'checking' | 'reachable' | 'unavailable'
  readonly deviceAuthorization: 'unknown' | 'authorized' | 'unauthorized'
  readonly channel: 'idle' | 'connecting' | 'connected' | 'offline'
  readonly heartbeat: 'unknown' | 'accepted'
  readonly checkedAt: number | null
  readonly heartbeatAt: number | null
}
/** Local inventory is shared machine evidence, not image/video dispatch qualification. */
export interface SharingLocalState {
  readonly inventory: 'unknown' | 'detected' | 'empty' | 'unavailable'
  readonly modelCount: number | null
  readonly runtime: 'unknown' | 'ready' | 'unavailable' | 'unsupported' | 'authentication_required'
  readonly adapter: 'comfyui' | 'qianshou_image' | 'qianshou_media_runtime' | null
  readonly adoption: 'unmatched' | 'verification_required' | 'reusable' | 'reused'
  readonly checkedAt: number | null
}
/** Existing local API evidence is independent from a paid capability or financial settlement. */
export type SharingAPIStatus = 'ready' | 'unavailable' | 'auth_required' | 'unsupported' | 'unknown'
export type SharingAPIAdapter = 'qianshou_image' | 'comfyui' | 'qianshou_media_runtime' | 'unidentified'
export interface SharingAPIIdentity {
  readonly id: string
  readonly sha256: string | null
  readonly version: string | null
}
export interface SharingAPIObservation {
  readonly mode: SharingMode
  readonly adapter: SharingAPIAdapter
  readonly status: SharingAPIStatus
  readonly model: SharingAPIIdentity | null
  readonly workflow: SharingAPIIdentity | null
  readonly observedAt: string
}
/** A Guangzhou challenge contains no URL, path, script, generation or price. */
export interface SharingAPIProbe {
  readonly requestId: string
  readonly mode: SharingMode
  readonly epoch: number
  readonly kind: 'metadata'
  readonly expiresAt: string
}
/** Friendly local names and actual Guangzhou acknowledgement; no private endpoint or model path. */
export interface SharingAPIState {
  readonly status: SharingAPIStatus
  readonly adapter: SharingAPIAdapter | null
  readonly modelName: string | null
  readonly workflowName: string | null
  readonly registration: 'pending' | 'registered' | 'unavailable' | 'unknown'
  readonly lastProbedAt: string | null
  readonly probeStatus: 'passed' | 'failed' | 'pending' | 'unknown'
}
/** The renderer receives neither endpoints, credentials, paths nor task contents. */
export interface SharingModeState {
  readonly api?: SharingAPIState
  readonly local?: SharingLocalState
  readonly authorization?: SharingAuthorization
  readonly mode: SharingMode
  readonly phase: SharingPhase
  readonly operationId: string | null
  readonly modelName: string | null
  readonly downloadedBytes: number | null
  readonly totalDownloadBytes: number | null
  readonly completedSteps: readonly string[]
  readonly reason: SharingReason | null
  readonly completedCalls: number | null
  readonly settledYuan: string | null
}
/** Stable current-owner local status; modes contains image and video exactly once. */
export interface SharingSnapshot {
  readonly schema: 'qianshou.compute-sharing.v1'
  readonly authenticated: boolean
  readonly scopeId?: string | null
  readonly operation?: SharingOperation | null
  readonly hardware: { readonly name: string; readonly memoryMb: number } | null
  readonly connection?: SharingConnectionState
  readonly modes: readonly SharingModeState[]
}
/** Actual machine facts used only in the Host's signed installation request. */
export interface SharingHardware {
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly arch: string
  readonly gpuName: string
  readonly vramMb: number
  readonly freeVramMb: number
  readonly memoryMb: number
}
/** One independently hash-verified file, never an executable browser selection. */
export interface SharingInstallFile {
  readonly path: string
  readonly url: string
  readonly sha256: string
  readonly size_bytes: number
  readonly etag: string
  readonly executable: boolean
}
/** Approved platform-specific package; its signer does not replace a device qualification. */
export interface SharingManifest {
  readonly schema: 'qianshou.media-install-manifest.v1'
  readonly purpose: 'qianshou:media-install-manifest'
  readonly nonce: string
  readonly accountId: number
  readonly deviceId: string
  readonly workerId: string
  readonly mode: SharingMode
  readonly platform: SharingHardware['platform']
  readonly arch: string
  readonly bundle_id: string
  readonly display_name: string
  readonly min_vram_mb: number
  readonly min_memory_mb: number
  readonly supported_gpu_names: readonly string[]
  readonly profiles: readonly MediaNodeCapability[]
  readonly executor_sha256: string
  readonly files: readonly SharingInstallFile[]
  readonly entrypoint: string
  readonly args: readonly string[]
  readonly health_path: '/health'
  readonly storage_bytes: number
  readonly abi: 'qianshou.media-runtime.v1'
  readonly issued_at: number
  readonly expires_at: number
}
/** A purpose-pinned canonical Ed25519 envelope retained for replay checks. */
export interface SharingSigned { readonly key_id: string; readonly payload: Readonly<Record<string, unknown>>; readonly signature: string }
/** Authenticated node operations expose purpose-scoped requests, not device tokens. */
export interface SharingNodeSession {
  readonly deviceId: string
  readonly connectionEpoch: number
  /** Upload only the original bounded PNG using the private device credential. */
  uploadResearch?(tuple: { taskId: string; attemptId: string; leaseEpoch: 1 }, sha256: string, bytes: Buffer,
    signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  /** Send one immutable task event using the channel-owned credential. */
  post(path: 'events' | 'media/result-ticket' | 'media/result-status' | 'media/input-ticket' | 'media/order-current' | 'media/task-status' | 'api-observations' | 'api-probe-result'
    | 'research/channel' | 'research/claim' | 'research/events' | 'research/task-status' | 'research/execution' | 'device-info', body: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>
}
/** Local journal values; a dispatched attempt never obtains another POST right. */
export interface SharingAttempt {
  readonly task: MediaNodeDelivery
  readonly owner: string
  readonly mode: SharingMode
  readonly state: 'admitted' | 'submitting' | 'unknown' | 'running' | 'generated' | 'uploading' | 'awaiting_settlement' | 'settled' | 'rejected'
  readonly assetId: string
  readonly outputPath: string
  readonly eventSequence: number
  readonly result: Readonly<Record<string, unknown>> | null
}
