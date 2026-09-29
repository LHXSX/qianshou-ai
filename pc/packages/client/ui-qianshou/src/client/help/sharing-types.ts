/** Owner-scoped, redacted observations from the local sharing coordinator. */
export type SharingMode = 'image' | 'video'
export type SharingAction = 'enable' | 'pause' | 'resume' | 'revoke'
export const SHARING_CONSENT_VERSION = 'qianshou.media-sharing-consent.v1' as const
export interface SharingAuthorization {
  readonly connection: 'required' | 'granted' | 'revoked'
  readonly execution: 'disabled' | 'idle_only'
  readonly deviceBound: boolean
}
export type SharingCommand = {
  readonly mode: SharingMode
  readonly requestId: string
  readonly scopeId: string
} & ({
  readonly action: 'enable' | 'resume'
  readonly consent: { readonly version: typeof SHARING_CONSENT_VERSION; readonly connection: true; readonly execution: 'idle_only' }
} | { readonly action: 'pause' | 'revoke'; readonly consent?: never })
export interface SharingPendingOperation {
  readonly mode: SharingMode
  readonly action: SharingAction
  readonly requestId: string
  readonly scopeId: string
}
export type SharingOperationReceipt = {
  readonly requestId: string
  readonly status: 'applied'
  readonly mode: SharingMode
  readonly action: SharingAction
} | { readonly requestId: string; readonly status: 'not_found'; readonly mode: null; readonly action: null }
export type SharingPhase = 'idle' | 'detecting' | 'matching' | 'downloading' | 'installing'
  | 'starting' | 'connecting' | 'recovering' | 'sharing' | 'paused' | 'blocked' | 'failed'
/** Redacted observations; account login and model readiness are separate. */
export interface SharingConnectionState {
  readonly gateway: 'unknown' | 'unconfigured' | 'checking' | 'reachable' | 'unavailable'
  readonly deviceAuthorization: 'unknown' | 'authorized' | 'unauthorized'
  readonly channel: 'idle' | 'connecting' | 'connected' | 'offline'
  readonly heartbeat: 'unknown' | 'accepted'
  readonly checkedAt: number | null
  readonly heartbeatAt: number | null
}
/** Generic local inventory does not establish a mode's eligibility for shared paid tasks. */
export interface SharingLocalState {
  readonly inventory: 'unknown' | 'detected' | 'empty' | 'unavailable'
  readonly modelCount: number | null
  readonly runtime: 'unknown' | 'ready' | 'unavailable' | 'unsupported' | 'authentication_required'
  readonly adapter: 'comfyui' | 'qianshou_image' | 'qianshou_media_runtime' | null
  readonly adoption: 'unmatched' | 'verification_required' | 'reusable' | 'reused'
  readonly checkedAt: number | null
}
/** Public labels and actual metadata roundtrip receipts; no private service addresses or credentials. */
export interface SharingApiState {
  readonly status: 'ready' | 'unavailable' | 'auth_required' | 'unsupported' | 'unknown'
  readonly adapter: 'qianshou_image' | 'comfyui' | 'qianshou_media_runtime' | null
  readonly modelName: string | null
  readonly workflowName: string | null
  readonly registration: 'pending' | 'registered' | 'unavailable' | 'unknown'
  readonly lastProbedAt: string | null
  readonly probeStatus: 'passed' | 'failed' | 'pending' | 'unknown'
}
export interface SharingModeState {
  readonly local?: SharingLocalState
  readonly api?: SharingApiState
  readonly authorization?: SharingAuthorization
  readonly mode: SharingMode
  readonly phase: SharingPhase
  readonly operationId: string | null
  readonly modelName: string | null
  readonly downloadedBytes: number | null
  readonly totalDownloadBytes: number | null
  readonly completedSteps: readonly string[]
  readonly reason: 'catalog_unavailable' | 'hardware_unsupported' | 'disk_space' | 'login_required'
    | 'verification_pending' | 'runtime_unavailable' | 'connection_unavailable' | 'download_failed' | 'owner_policy_blocked'
    | 'consent_required' | 'idle_required' | 'resource_unavailable' | 'execution_disabled' | null
  readonly completedCalls: number | null
  readonly settledYuan: string | null
}
export interface SharingSnapshot {
  readonly schema: 'qianshou.compute-sharing.v1'
  readonly authenticated: boolean
  readonly scopeId?: string | null
  readonly operation?: SharingOperationReceipt | null
  readonly hardware: { readonly name: string; readonly memoryMb: number } | null
  readonly connection?: SharingConnectionState
  readonly modes: readonly SharingModeState[]
}
export interface SharingViewState {
  readonly phase: 'loading' | 'ready' | 'unavailable'
  /** A bounded diagnosis from the local Host status read; never contains server text or addresses. */
  readonly readFailure: 'timeout' | 'host_missing' | 'host_unavailable' | 'login' | 'response_invalid' | 'unknown' | null
  readonly snapshot: SharingSnapshot | null
  readonly busyMode: SharingMode | null
  readonly actionFailed: boolean
  readonly confirmation: SharingPendingOperation | null
  readonly pendingOperation: SharingPendingOperation | null
}
