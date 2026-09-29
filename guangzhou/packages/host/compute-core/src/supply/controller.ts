/** Serialize local policy commits and advertisement replacement; no remote scheduler or ledger is created. */
import { parseSupplyPolicy, SupplyError, type SupplyPolicyStore } from './policy.ts'
import type { SupplyAdvertisementPort, SupplyClient, SupplyPolicy, SupplyProbeResult, SupplySnapshot } from './types.ts'

/** Composition-owned ports. Missing task counts or authentication fail closed for contribution. */
export interface SupplyControllerOptions {
  readonly initialPolicy: SupplyPolicy
  readonly policyStore: SupplyPolicyStore
  readonly probe: (signal: AbortSignal) => Promise<SupplyProbeResult>
  readonly activeTaskCount: () => number | null
  readonly operationTimeoutMs: number
  readonly advertisement?: SupplyAdvertisementPort
  readonly now?: () => string
}

/** Local supply lifecycle. Admission readiness is separate from acknowledged server advertisement. */
export class SupplyController implements SupplyClient {
  private policy: SupplyPolicy
  private serial: Promise<unknown> = Promise.resolve()
  private current = new AbortController()
  private readonly lifetime = new AbortController()
  private closing: Promise<void> | undefined
  private advertised: readonly string[] = []
  private loaded = false
  /** Bind deployment-owned ports; constructing the controller does not probe or publish. */
  constructor(private readonly options: SupplyControllerOptions) {
    this.policy = parseSupplyPolicy(options.initialPolicy)
    if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 1
      || options.operationTimeoutMs > 2147483647) throw new SupplyError('SUPPLY_CONFIG_INVALID')
  }
  /** Observe resources and reconcile future offers with current owner/activity authority. */
  querySupplySnapshot(signal?: AbortSignal): Promise<SupplySnapshot> {
    return this.enqueue(async scoped => { await this.load(); return this.observe(scoped) }, signal)
  }
  /** Save a complete validated policy after withdrawing; a later probe failure does not undo the save. */
  updateSupplyPolicy(policy: SupplyPolicy, signal?: AbortSignal): Promise<SupplySnapshot> {
    const parsed = parseSupplyPolicy(policy)
    this.current.abort()
    this.current = new AbortController()
    return this.enqueue(async scoped => {
      await this.load()
      scoped.throwIfAborted()
      // Withdraw before changing saved authority; a failed save cannot enable new offers.
      await this.withdraw(scoped)
      await this.options.policyStore.save(parsed)
      this.policy = parsed
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
    const saved = await this.options.policyStore.load()
    if (saved) this.policy = parseSupplyPolicy(saved)
    this.loaded = true
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
  private async observe(signal: AbortSignal): Promise<SupplySnapshot> {
    const facts = await this.options.probe(signal)
    signal.throwIfAborted()
    const services = facts.localServices.filter(service => service.verification === 'verified' && this.policy.enabledServiceIds.includes(service.id))
    const reasons: string[] = []
    const count = this.options.activeTaskCount()
    if (this.policy.mode === 'off') reasons.push('OWNER_DISABLED')
    if (facts.activity.foregroundTaskActive === null || facts.activity.voiceActive === null) reasons.push('HOST_ACTIVITY_UNKNOWN')
    if (facts.activity.foregroundTaskActive || facts.activity.voiceActive) reasons.push('FOREGROUND_PRIORITY')
    if (this.policy.mode === 'idle') {
      if (facts.activity.idleSeconds === null) reasons.push('IDLE_STATE_UNKNOWN')
      else if (facts.activity.idleSeconds < this.policy.minIdleSeconds) reasons.push('USER_ACTIVE')
    }
    if (count === null || !Number.isSafeInteger(count) || count < 0) reasons.push('TASK_COUNT_UNKNOWN')
    else if (count >= this.policy.maxConcurrency) reasons.push('CONCURRENCY_LIMIT')
    if (facts.hardware.freeMemoryBytes < this.policy.minFreeMemoryBytes) reasons.push('MEMORY_LIMIT')
    if (!services.length) reasons.push('NO_VERIFIED_ENABLED_SERVICE')
    const ready = reasons.length === 0
    const transport = this.options.advertisement
    let advertisingState: SupplySnapshot['advertisingState'] = 'not-connected'
    if (transport?.connected()) {
      if (ready) {
        this.advertised = await transport.publish(services, signal)
        signal.throwIfAborted()
        advertisingState = 'advertising'
      } else { await this.withdraw(signal); advertisingState = 'withdrawn' }
    } else this.advertised = []
    return { ...facts, version: 'qianshou.local-supply.v1', observedAt: this.options.now?.() ?? new Date().toISOString(),
      ownerPolicy: this.policy, eligibility: { state: this.policy.mode === 'off' ? 'disabled' : ready ? 'ready' : 'blocked', reasons },
      advertisingState, advertisedCapabilityIds: [...this.advertised] }
  }
  private async withdraw(signal: AbortSignal): Promise<void> {
    if (this.options.advertisement?.connected()) await this.options.advertisement.withdraw(signal)
    this.advertised = []
  }
}
