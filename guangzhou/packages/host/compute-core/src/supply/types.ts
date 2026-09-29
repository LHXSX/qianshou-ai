/** Public local-supply facts. No credentials, account balances or server leases enter this projection. */
export interface SupplyGpu {
  readonly name: string
  readonly vendor: string | null
  readonly memoryBytes: number | null
}

/** A successfully executed tool check is distinct from an installed model awaiting inference self-test. */
export interface LocalSupplyService {
  readonly id: string
  readonly kind: 'tool' | 'local-model'
  readonly name: string
  readonly version: string | null
  readonly verification: 'verified' | 'pending' | 'unavailable'
  readonly reason: string | null
}

/** Owner-entered local preference, never a platform quote or a reservation. */
export interface NodeRateSetting {
  readonly localServiceId: string
  readonly amountMinor: number
  readonly unit: string
  readonly currency: string
}

/** All policy values are explicit; only an authenticated host may update the persisted owner policy. */
export interface SupplyPolicy {
  readonly mode: 'off' | 'idle' | 'allowed'
  readonly maxConcurrency: number
  readonly minFreeMemoryBytes: number
  readonly minIdleSeconds: number
  readonly enabledServiceIds: readonly string[]
  readonly nodeRates: readonly NodeRateSetting[]
}

/** Host-owned task/voice facts remain unknown until their real runtime supplies them. */
export interface SupplyActivity {
  readonly idleSeconds: number | null
  readonly foregroundTaskActive: boolean | null
  readonly voiceActive: boolean | null
}

/** Fresh local observations. Empty GPU results and explicit probe errors never imply a GPU exists. */
export interface SupplyProbeResult {
  readonly hardware: {
    readonly platform: string
    readonly arch: string
    readonly cpuModel: string
    readonly logicalCores: number
    readonly totalMemoryBytes: number
    readonly freeMemoryBytes: number
    readonly gpus: readonly SupplyGpu[]
    readonly probeErrors: readonly string[]
  }
  readonly localServices: readonly LocalSupplyService[]
  readonly activity: SupplyActivity
}

/** Serializable response shared by the authenticated Host facade and the supply UI. */
export interface SupplySnapshot extends SupplyProbeResult {
  readonly version: 'qianshou.local-supply.v1'
  readonly observedAt: string
  readonly ownerPolicy: SupplyPolicy
  readonly eligibility: {
    readonly state: 'disabled' | 'blocked' | 'ready'
    readonly reasons: readonly string[]
  }
  readonly advertisingState: 'not-connected' | 'withdrawn' | 'advertising'
  readonly advertisedCapabilityIds: readonly string[]
}

/** A real authenticated transport owns mapping local services to server capability identifiers. */
export interface SupplyAdvertisementPort {
  /** True only after the deployment's worker authentication succeeds. */
  readonly connected: () => boolean
  /** Replace advertised services; return only identifiers acknowledged by the authenticated transport. */
  readonly publish: (services: readonly LocalSupplyService[], signal: AbortSignal) => Promise<readonly string[]>
  /** Withdraw future offers without claiming to cancel an executing server lease. */
  readonly withdraw: (signal: AbortSignal) => Promise<void>
}

/** The host maps these methods onto its existing authenticated compute service. */
export interface SupplyClient {
  /** Return a fresh observation after applying current admission and advertisement policy. */
  querySupplySnapshot(signal?: AbortSignal): Promise<SupplySnapshot>
  /** Validate and persist a complete policy; return a fresh snapshot or reject with a stable error code. */
  updateSupplyPolicy(policy: SupplyPolicy, signal?: AbortSignal): Promise<SupplySnapshot>
  /** Abort probing and advertising, drain work, and withdraw future offers. */
  close(): Promise<void>
}
