/** Public local-supply facts. No credentials, account balances or server leases enter this projection. */
export interface SupplyGpu {
  readonly name: string
  readonly vendor: string | null
  readonly memoryBytes: number | null
}

/** A successfully executed tool check is distinct from an installed model awaiting inference self-test. */
export interface LocalSupplyService {
  readonly id: string
  readonly kind: 'tool' | 'local-model' | 'package'
  readonly name: string
  readonly version: string | null
  readonly verification: 'verified' | 'pending' | 'unavailable'
  readonly reason: string | null
  /** Copied from the model inventory when present; never invented from a package name. */
  readonly promptStyle?: string
  /** Copied LoRA trigger when the inventory reported one. */
  readonly lorasTrigger?: string
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

/** One `qianshou/capability/v1` implementation binding. Optional fields are omitted when the probe did not report them. */
export interface CapabilityImplBinding {
  readonly runtime: string
  readonly version: string
  readonly path?: string
  readonly prompt_style?: string
  readonly loras?: { readonly trigger: string }
}

/** One claimed capability with the concrete binding that satisfies it. */
export interface CapabilityProvide {
  readonly capability: string
  readonly impl: CapabilityImplBinding
  readonly health: 'ok' | 'degraded' | 'missing'
}

/** Node capability declaration projected from a local probe. This is not the 22-name catalog file. */
export interface CapabilityDeclaration {
  readonly contract: 'qianshou/capability/v1'
  readonly provides: readonly CapabilityProvide[]
  readonly native_binaries: readonly string[]
}

/** Day-bounded local probe counter. Defined here so snapshots stay one object. */
export interface ProbeWatchState {
  readonly version: 1
  readonly day: string
  readonly callsToday: number
  readonly lastDigest: string | null
  readonly lastCapabilities: readonly string[]
  readonly lastChangedAt: string | null
  readonly changes: readonly { readonly at: string; readonly added: readonly string[]; readonly removed: readonly string[] }[]
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
  /** Probe landing for `provides[].impl`. Not sent on hello (platform whitelist would drop `provides`). */
  readonly declaration: CapabilityDeclaration
  /** Local probe history for this Host. A later monitor can read zero-call days without probing again. */
  readonly probeWatch: ProbeWatchState
}

/** The last completed observation, held in memory only. Reading it never probes or reconciles advertisement. */
export interface ObservedSupplyServices {
  readonly observedAt: string
  readonly localServices: readonly LocalSupplyService[]
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

/** Host-only author authority; the expectation is frozen before the async installation flow. */
export interface SupplyPolicyWriteAuthority {
  readonly expectedOwnerId: number
  readonly assertCurrent: () => Promise<void>
}

/** Explicit Host switch intent; the controller merges it into committed policy inside its write queue. */
export type OwnerSupplyCommand =
  | { readonly kind: 'mode'; readonly mode: 'off' | 'idle' }
  | { readonly kind: 'local-service'; readonly serviceId: string; readonly enabled: boolean }

/** The host maps these methods onto its existing authenticated compute service. */
export interface SupplyClient {
  /** Return the last completed observation without triggering a probe, publication or policy write. */
  lastObservedSupply(): ObservedSupplyServices | null
  /** Return a fresh observation after applying current admission and advertisement policy. */
  querySupplySnapshot(signal?: AbortSignal): Promise<SupplySnapshot>
  /** Validate and persist a complete policy; return a fresh snapshot or reject with a stable error code. */
  updateSupplyPolicy(policy: SupplyPolicy, signal?: AbortSignal): Promise<SupplySnapshot>
  /** Optional Host-only bound write; absence cannot authorize an author activation fallback. */
  updateBoundSupplyPolicy?(policy: SupplyPolicy, authority: SupplyPolicyWriteAuthority, signal?: AbortSignal): Promise<SupplySnapshot>
  /** Optional Host-only atomic switch; absence never permits a filtered full-policy fallback. */
  updateOwnerSupply?(command: OwnerSupplyCommand, authority?: SupplyPolicyWriteAuthority, signal?: AbortSignal): Promise<SupplySnapshot>
  /**
   * Read the committed owner policy alone.
   *
   * Separate from {@link querySupplySnapshot} on purpose: a snapshot runs the whole local
   * probe (hardware, tools, activity) and reconciles advertisement, which is far too heavy
   * to call on every resident tick. A caller that only needs to mirror the owner's switch
   * reads it here instead.
   */
  ownerPolicy(signal?: AbortSignal): Promise<SupplyPolicy>
  /** Abort probing and advertising, drain work, and withdraw future offers. */
  close(): Promise<void>
}
