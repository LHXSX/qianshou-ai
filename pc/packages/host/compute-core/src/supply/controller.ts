/** Serialize local policy commits and advertisement replacement; no remote scheduler or ledger is created. */
import { parseSupplyPolicy, SupplyError, type BoundSupplyPolicyStore, type SupplyOwnerBinding, type SupplyPolicyStore } from './policy.ts'
import { projectCapabilityDeclaration } from './capability-declaration.ts'
import { recordProbeWatch, type ProbeWatchStore } from './probe-watch.ts'
import type { ObservedSupplyServices, OwnerSupplyCommand, ProbeWatchState, SupplyAdvertisementPort, SupplyClient, SupplyPolicy, SupplyPolicyWriteAuthority, SupplyProbeResult, SupplySnapshot } from './types.ts'

/** Composition-owned ports. Missing task counts or authentication fail closed for contribution. */
export interface SupplyControllerOptions {
  readonly initialPolicy: SupplyPolicy
  readonly policyStore: SupplyPolicyStore
  /** Present for account-bound product supply; absent for standalone local-supply clients. */
  readonly ownerBinding?: {
    /** Cheap current authenticated account and installed node; never contacts the network on resident ticks. */
    current(): Promise<SupplyOwnerBinding | null>
    /** May restore a signed-in account before a user-initiated policy write. */
    forWrite(): Promise<SupplyOwnerBinding | null>
  }
  readonly probe: (signal: AbortSignal) => Promise<SupplyProbeResult>
  readonly activeTaskCount: () => number | null
  readonly operationTimeoutMs: number
  readonly advertisement?: SupplyAdvertisementPort
  readonly now?: () => string
  /** Optional local probe history. Missing means in-memory only for this process. */
  readonly watchStore?: ProbeWatchStore
}

/** Local supply lifecycle. Admission readiness is separate from acknowledged server advertisement. */
export class SupplyController implements SupplyClient {
  private policy: SupplyPolicy
  private binding: SupplyOwnerBinding | null = null
  private serial: Promise<unknown> = Promise.resolve()
  private current = new AbortController()
  private readonly lifetime = new AbortController()
  private closing: Promise<void> | undefined
  private advertised: readonly string[] = []
  private lastObserved: ObservedSupplyServices | null = null
  private loaded = false
  private watch: ProbeWatchState | null = null
  private watchLoaded = false
  /** Bind deployment-owned ports; constructing the controller does not probe or publish. */
  constructor(private readonly options: SupplyControllerOptions) {
    this.policy = parseSupplyPolicy(options.initialPolicy)
    if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 1
      || options.operationTimeoutMs > 2147483647) throw new SupplyError('SUPPLY_CONFIG_INVALID')
  }
  /** Read only the most recent completed observation; never starts a probe or reconciles advertisements. */
  lastObservedSupply(): ObservedSupplyServices | null {
    if (this.lifetime.signal.aborted || this.lastObserved === null) return null
    return { observedAt: this.lastObserved.observedAt,
      localServices: this.lastObserved.localServices.map(service => ({ ...service })) }
  }
  /** Observe resources and reconcile future offers with current owner/activity authority. */
  querySupplySnapshot(signal?: AbortSignal): Promise<SupplySnapshot> {
    return this.enqueue(async (scoped) => { await this.load(); return this.observe(scoped) }, signal)
  }
  /** Reconcile a real Host activity transition without waiting for the supply page to be opened.
   * A busy transition cancels any older observation and withdraws before the slower hardware/tool probe. An idle
   * transition queues behind that withdrawal, so a short voice request cannot cancel its own safety signal.
   */
  refreshActivity(active: boolean): Promise<SupplySnapshot> {
    if (active) {
      this.current.abort()
      this.current = new AbortController()
    }
    return this.enqueue(async (scoped) => {
      await this.load()
      scoped.throwIfAborted()
      if (active) await this.withdraw(scoped)
      return this.observe(scoped, active)
    })
  }
  /**
   * Read the committed owner policy without probing hardware or touching advertisement.
   *
   * Uses the same serial queue as every other commit so it can never observe a policy
   * mid-write, but it does not call `observe()`: the resident loop reads this once per
   * tick and a full local probe per tick would be both wasteful and noisy.
   */
  ownerPolicy(signal?: AbortSignal): Promise<SupplyPolicy> {
    return this.enqueue(async (scoped) => { await this.load(); scoped.throwIfAborted(); return this.effectivePolicy() }, signal)
  }
  /** Save a complete validated policy after withdrawing; a later probe failure does not undo the save. */
  updateSupplyPolicy(policy: SupplyPolicy, signal?: AbortSignal): Promise<SupplySnapshot> {
    return this.commitPolicy({ kind: 'complete', policy: parseSupplyPolicy(policy) }, signal)
  }
  /** Commit only the original author's owner binding, with worker/account checks inside this queue. */
  updateBoundSupplyPolicy(policy: SupplyPolicy, authority: SupplyPolicyWriteAuthority, signal?: AbortSignal): Promise<SupplySnapshot> {
    if (!Number.isSafeInteger(authority.expectedOwnerId) || authority.expectedOwnerId < 1
      || typeof authority.assertCurrent !== 'function' || this.options.ownerBinding === undefined) {
      return Promise.reject(new SupplyError('SUPPLY_OWNER_IDENTITY_UNAVAILABLE'))
    }
    return this.commitPolicy({ kind: 'complete', policy: parseSupplyPolicy(policy) }, signal, Object.freeze({ ...authority }))
  }
  /** Merge an explicit switch into saved policy after restoring and rechecking its exact owner/node.
   * @param command - Only the switch fields to change; never a public effective-policy projection.
   * @param authority - Optional original author/worker authority owned by the Host.
   * @param signal - Caller cancellation.
   * @returns Fresh supply observation after the atomic policy commit.
   */
  updateOwnerSupply(command: OwnerSupplyCommand, authority?: SupplyPolicyWriteAuthority, signal?: AbortSignal): Promise<SupplySnapshot> {
    if (authority !== undefined && (!Number.isSafeInteger(authority.expectedOwnerId) || authority.expectedOwnerId < 1
      || typeof authority.assertCurrent !== 'function' || this.options.ownerBinding === undefined)) {
      return Promise.reject(new SupplyError('SUPPLY_OWNER_IDENTITY_UNAVAILABLE'))
    }
    return this.commitPolicy({ kind: 'command', command: Object.freeze({ ...command }) }, signal,
      authority === undefined ? undefined : Object.freeze({ ...authority }))
  }
  private commitPolicy(change: { kind: 'complete'; policy: SupplyPolicy } | { kind: 'command'; command: OwnerSupplyCommand }, signal?: AbortSignal,
    authority?: SupplyPolicyWriteAuthority): Promise<SupplySnapshot> {
    const command = change.kind === 'command' ? change.command : undefined
    this.current.abort()
    this.current = new AbortController()
    return this.enqueue(async (scoped) => {
      await this.load()
      scoped.throwIfAborted()
      let binding: SupplyOwnerBinding | null = null
      if (this.options.ownerBinding !== undefined) {
        try { binding = await this.options.ownerBinding.forWrite() } catch { /* No identity is not an authorization. */ }
        if (binding === null) throw new SupplyError('SUPPLY_OWNER_IDENTITY_UNAVAILABLE')
      }
      let base = this.policy
      if (command !== undefined && binding !== null && (this.binding === null
        || binding.ownerId !== this.binding.ownerId || binding.nodeId !== this.binding.nodeId)) {
        // Only this explicit switch is authorized; legacy or other-identity grants cannot be inherited.
        base = { ...base, mode: 'off', enabledServiceIds: [], nodeRates: [] }
      }
      if (authority !== undefined) {
        if (binding?.ownerId !== authority.expectedOwnerId) throw new SupplyError('SUPPLY_OWNER_IDENTITY_UNAVAILABLE')
        await authority.assertCurrent()
      }
      // Withdraw before changing saved authority; a failed save cannot enable new offers.
      await this.withdraw(scoped)
      if (this.options.ownerBinding !== undefined && (authority !== undefined || (command !== undefined && binding !== null))) {
        const latest = await this.options.ownerBinding.forWrite()
        if (latest?.ownerId !== binding?.ownerId || latest?.nodeId !== binding?.nodeId) {
          throw new SupplyError('SUPPLY_OWNER_IDENTITY_UNAVAILABLE')
        }
        await authority?.assertCurrent()
        scoped.throwIfAborted()
      }
      let parsed: SupplyPolicy
      if (change.kind === 'complete') parsed = change.policy
      else {
        const intent = change.command
        parsed = parseSupplyPolicy(intent.kind === 'mode' ? { ...base, mode: intent.mode }
          : { ...base, enabledServiceIds: intent.enabled
            ? [...new Set([...base.enabledServiceIds, intent.serviceId])]
            : base.enabledServiceIds.filter(id => id !== intent.serviceId),
          nodeRates: intent.enabled ? base.nodeRates : base.nodeRates.filter(rate => rate.localServiceId !== intent.serviceId) })
      }
      if (binding !== null) await this.boundStore().saveBound(parsed, binding)
      else await this.options.policyStore.save(parsed)
      this.policy = parsed
      this.binding = binding
      scoped.throwIfAborted()
      return this.observe(scoped)
    }, signal)
  }
  /** Abort and drain signal-aware ports, then withdraw future offers exactly through their transport. */
  close(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort(); this.current.abort()
      this.closing = this.serial.catch(() => undefined).then(async () => {
        try { await this.withdraw(AbortSignal.timeout(this.options.operationTimeoutMs)) }
        catch { throw new SupplyError('SUPPLY_WITHDRAW_FAILED') }
      })
    }
    return this.closing
  }
  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.options.ownerBinding !== undefined) {
      const saved = await this.boundStore().loadBound()
      if (saved.policy) this.policy = parseSupplyPolicy(saved.policy)
      this.binding = saved.binding
    } else {
      const saved = await this.options.policyStore.load()
      if (saved) this.policy = parseSupplyPolicy(saved)
    }
    this.loaded = true
  }
  private boundStore(): BoundSupplyPolicyStore {
    const store = this.options.policyStore as Partial<BoundSupplyPolicyStore>
    if (typeof store.loadBound !== 'function' || typeof store.saveBound !== 'function') {
      throw new SupplyError('SUPPLY_STORAGE_UNAVAILABLE')
    }
    return store as BoundSupplyPolicyStore
  }
  private async effectivePolicy(): Promise<SupplyPolicy> {
    if (this.options.ownerBinding === undefined) return this.policy
    let current: SupplyOwnerBinding | null = null
    try { current = await this.options.ownerBinding.current() } catch { /* Fail closed on account or node uncertainty. */ }
    if (current !== null && this.binding !== null
      && current.ownerId === this.binding.ownerId && current.nodeId === this.binding.nodeId) return this.policy
    // A legacy file may say ON; without a matching explicit owner/node binding it
    // cannot authorize this account, and its per-service grants cannot be inherited.
    return { ...this.policy, mode: 'off', enabledServiceIds: [], nodeRates: [] }
  }
  private enqueue<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const revision = this.current.signal
    const pending = this.serial.catch(() => undefined).then(async () => {
      if (this.lifetime.signal.aborted) throw new SupplyError('SUPPLY_CLOSED')
      const scoped = AbortSignal.any([this.lifetime.signal, revision, AbortSignal.timeout(this.options.operationTimeoutMs), ...(signal ? [signal] : [])])
      try { scoped.throwIfAborted(); return await operation(scoped) }
      catch (error) {
        if (scoped.aborted) throw new SupplyError('SUPPLY_ABORTED')
        if (error instanceof SupplyError) throw error
        throw new SupplyError('SUPPLY_OPERATION_FAILED')
      }
    })
    this.serial = pending
    return pending
  }
  private async observe(signal: AbortSignal, alreadyWithdrawn = false): Promise<SupplySnapshot> {
    const facts = await this.options.probe(signal)
    signal.throwIfAborted()
    const policy = await this.effectivePolicy()
    signal.throwIfAborted()
    const services = facts.localServices.filter(service => service.verification === 'verified' && policy.enabledServiceIds.includes(service.id))
    const reasons: string[] = []
    const count = this.options.activeTaskCount()
    if (policy.mode === 'off') reasons.push('OWNER_DISABLED')
    if (facts.activity.foregroundTaskActive === null || facts.activity.voiceActive === null) reasons.push('HOST_ACTIVITY_UNKNOWN')
    if (facts.activity.foregroundTaskActive || facts.activity.voiceActive) reasons.push('FOREGROUND_PRIORITY')
    if (policy.mode === 'idle') {
      if (facts.activity.idleSeconds === null) reasons.push('IDLE_STATE_UNKNOWN')
      else if (facts.activity.idleSeconds < policy.minIdleSeconds) reasons.push('USER_ACTIVE')
    }
    if (count === null || !Number.isSafeInteger(count) || count < 0) reasons.push('TASK_COUNT_UNKNOWN')
    else if (count >= policy.maxConcurrency) reasons.push('CONCURRENCY_LIMIT')
    if (facts.hardware.freeMemoryBytes < policy.minFreeMemoryBytes) reasons.push('MEMORY_LIMIT')
    if (!services.length) reasons.push('NO_VERIFIED_ENABLED_SERVICE')
    const ready = reasons.length === 0
    const transport = this.options.advertisement
    let advertisingState: SupplySnapshot['advertisingState'] = 'not-connected'
    if (transport?.connected()) {
      if (ready) {
        this.advertised = await transport.publish(services, signal)
        signal.throwIfAborted()
        advertisingState = 'advertising'
      } else { if (!alreadyWithdrawn) await this.withdraw(signal); advertisingState = 'withdrawn' }
    } else this.advertised = []
    const observedAt = this.options.now?.() ?? new Date().toISOString()
    const declaration = projectCapabilityDeclaration(facts)
    if (!this.watchLoaded) {
      this.watch = this.options.watchStore ? await this.options.watchStore.load() : null
      this.watchLoaded = true
    }
    const clock = new Date(observedAt)
    const now = Number.isFinite(clock.getTime()) ? clock : new Date()
    this.watch = recordProbeWatch(this.watch, declaration.provides.map(row => row.capability), now)
    if (this.options.watchStore) await this.options.watchStore.save(this.watch)
    const snapshot: SupplySnapshot = { ...facts, version: 'qianshou.local-supply.v1', observedAt,
      ownerPolicy: policy, eligibility: { state: policy.mode === 'off' ? 'disabled' : ready ? 'ready' : 'blocked', reasons },
      advertisingState, advertisedCapabilityIds: [...this.advertised],
      declaration, probeWatch: this.watch }
    this.lastObserved = { observedAt: snapshot.observedAt,
      localServices: snapshot.localServices.map(service => ({ ...service })) }
    return snapshot
  }
  private async withdraw(signal: AbortSignal): Promise<void> {
    if (this.options.advertisement?.connected()) await this.options.advertisement.withdraw(signal)
    this.advertised = []
  }
}
