/** Owner-authorized preparation, supervised supply and redacted two-mode product routes. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { cpus, release } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { mediaNodeOrigin, type MediaNodeCapability, type MediaNodeHeartbeat } from './media-node-channel.ts'
import type { MediaNodeControl, MediaNodeExecutionPort, MediaNodePresenceLease } from './media-node-routes.ts'
import type { SharingAPIObservation, SharingAPIProbe, SharingAPIState, SharingAction, SharingConsent, SharingConnectionState, SharingHardware, SharingLocalState, SharingManifest, SharingMode, SharingNodeSession, SharingSnapshot } from './sharing-types.ts'
import { SHARING_UUID, parseSharingManifest, sharingCanonical, sharingDigest, sharingEnvelope, sharingFail, sharingObject,
  sharingVerify } from './sharing-protocol.ts'
import { initialSharingMode, SharingStore } from './sharing-store.ts'
import { SharingRuntime, sharingHardware, sharingJSON } from './sharing-runtime.ts'
import { SharingProvider } from './sharing-provider.ts'
import { NodeContributorError } from './errors.ts'
import { discoverSharingLocal, initialSharingLocal, type SharingLocalOptions } from './sharing-local.ts'
import { sharingAPIObservation } from './sharing-api-observations.ts'
import { SharingPilot } from './sharing-pilot.ts'
import { ResearchConsumer, type ResearchSession, type ResearchPilot } from './research-consumer.ts'
import { exact, type ResearchLease } from './research-contract.ts'

/** Deployment-owned roots and true authenticated control-plane identity. */
export interface SharingCoordinatorOptions {
  readonly directory: string
  readonly gatewayOrigin: string
  readonly metadataPublicKey: string
  readonly metadataKeyId: string
  /** Formal result verdict trust never accepts an installation/qualification signer. */
  readonly guangzhouPublicKey: string
  readonly guangzhouKeyId: string
  readonly uploadPublicKey: string
  readonly uploadKeyId: string
  readonly authorizationPublicKey: string
  readonly authorizationKeyId: string
  readonly orderPublicKey: string
  readonly orderKeyId: string
  readonly downloadOrigins: readonly string[]
  readonly owner: () => Promise<string | null>
  readonly token: () => Promise<string | undefined>
  readonly workerId: () => string | null
  readonly coreOrigin: () => string | null
  readonly channel: () => MediaNodeControl
  readonly admission: <T>(operation: () => Promise<T>) => Promise<T>
  readonly occupancyChanged: () => void
  readonly legacyBusy: () => boolean
  /** Test/operator deadline for the safe public probe; no credentials are sent. */
  readonly probeTimeoutMs?: number
  /** Read-only loopback inventory; omitted leaves this observation unconfigured. */
  readonly localDiscovery?: SharingLocalOptions
  /** Private fixed-workflow API factory limits; absence disables automatic wrapping. */
  readonly pilot?: { readonly timeoutMs: number; readonly maximumResultBytes: number }
  /** Separate non-billable task inbox and bounded original-attempt journal. */
  readonly research?: { readonly waitMs: number; readonly maximumRecords: number; readonly executionIntervalMs: number }
  /** Optional operator veto; explicit current-owner device permission is still mandatory. */
  readonly presenceAllowed?: () => Promise<boolean>
  /** Measured idle-only execution admission; unavailable observers fail closed. */
  readonly executionState?: () => Promise<'idle' | 'busy' | 'unknown' | 'disabled'>
  /** Local channel-start deadline; a failed connection cannot hold status reads. */
  readonly presenceConnectTimeoutMs?: number
  /** Finite status identity/journal deadline; observations are refreshed separately. */
  readonly statusTimeoutMs?: number
}
interface Qualified { until: number; maxSeconds: number; capabilities: readonly MediaNodeCapability[] }
const MODES = ['image', 'video'] as const
/** Automatic execution remains blocked until real approved packages and device receipts are available. */
export class SharingCoordinator {
  private store: SharingStore | undefined
  private updateLocked = false
  private provider: SharingProvider | undefined
  private currentOwner: string | null = null
  private scopeId: string | null = null
  private currentDeviceId: string | null = null
  private executionState: 'idle' | 'busy' | 'unknown' | 'disabled' = 'unknown'
  private executionAt = 0
  private readonly retainedRuntimes = new Map<string, Map<SharingMode, { manifest: SharingManifest; runtime: SharingRuntime }>>()
  private hardware: SharingHardware | null = null
  private readonly runtimes = new Map<SharingMode, { manifest: SharingManifest; runtime: SharingRuntime }>()
  private readonly runtimeHealth = new Map<SharingMode, { runtime: SharingRuntime; ready: boolean; checkedAt: number }>()
  private readonly runtimeHealthWork = new Map<SharingMode, Promise<void>>()
  private readonly reusable = new Set<SharingMode>()
  private readonly qualifications = new Map<SharingMode, Qualified>()
  private readonly preparationControllers = new Map<SharingMode, AbortController>()
  private readonly preparing = new Map<SharingMode, Promise<void>>()
  private controller = new AbortController()
  private serial: Promise<unknown> = Promise.resolve()
  private live = true
  private hardwareAt = 0
  private hardwareWork: Promise<void> | undefined
  private qualificationAt = 0
  private restoreAt = 0
  private earningsAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private gateway: SharingConnectionState['gateway'] = 'unknown'
  private probeAt = 0
  private probeCheckedAt: number | null = null
  private probeGeneration = 0
  private probeController: AbortController | undefined
  private probeWork: Promise<void> | undefined
  private localState: Readonly<Record<SharingMode, SharingLocalState>> = { image: initialSharingLocal(), video: initialSharingLocal() }
  private discoveredLocal: Readonly<Record<SharingMode, SharingLocalState>> = this.localState
  private localWork: Promise<void> | undefined
  private localController: AbortController | undefined
  private localAt = 0
  private localComfyOrigin: string | null = null
  private localImageOrigin: string | null = null
  private localVideoOrigin: string | null = null
  private localScanAt = 0
  private pilot: { owner: string; device: string; handle: SharingPilot; observation: SharingAPIObservation } | undefined
  private research: ResearchConsumer | undefined
  private researchAdmission: string | undefined
  private readonly researchRecovery = new Map<string, SharingPilot>()
  private researchExecutionAt = 0
  private deviceInfoKey = ''
  private presenceAuthorized = false
  private presenceLease: MediaNodePresenceLease | undefined
  private presenceWork: Promise<void> | undefined
  private advertisedCapabilities: readonly MediaNodeCapability[] = []
  private apiSnapshot: {
    owner: string
    device: string
    epoch: number
    structure: string
    revision: string
    observations: readonly SharingAPIObservation[]
    acknowledged: boolean
  } | undefined
  private readonly apiResults = new Map<SharingMode, {
    device: string
    epoch: number
    structure: string
    status: 'confirmed' | 'failed'
    confirmedAt: string | null
  }>()
  /** Stable provider object: capability revision changes only with actual admitted profile references. */
  readonly executor: MediaNodeExecutionPort = {
    get capabilityRevision() { return sharingDigest(this.capabilities) },
    get capabilities() { return [] }, // Getters are replaced below to capture this coordinator, not a Cordis proxy.
    maxConcurrency: 1,
    readHeartbeat: async () => this.heartbeat(),
    onTask: async (task, signal, session) => {
      if (this.provider === undefined) sharingFail('VERIFICATION_PENDING')
      await this.provider.onTask(task, signal, session)
    },
    onApiProbe: async (probe, signal, session) => this.transaction(async () => this.apiProbe(probe, signal, session)),
  }
  constructor(private readonly options: SharingCoordinatorOptions) {
    Object.defineProperty(this.executor, 'capabilities', { get: () => {
      // An admitted original attempt keeps its channel identity; zero free slots withdraw new intake.
      if (this.currentOwner !== null && this.draining(this.currentOwner)) return this.advertisedCapabilities
      this.advertisedCapabilities = [...this.qualifications.entries()].filter(([mode, q]) => q.until > Date.now()
        && this.live && this.presenceAuthorized && this.currentOwner !== null
        && this.authorized(this.currentOwner, mode)).flatMap(([, q]) => q.capabilities)
      return this.advertisedCapabilities
    } })
  }
  private requireStore(): SharingStore { if (this.store === undefined) sharingFail('STORE_INVALID'); return this.store }
  private requireProvider(): SharingProvider { if (this.provider === undefined) sharingFail('VERIFICATION_PENDING'); return this.provider }
  private transaction<T>(action: () => Promise<T>): Promise<T> { const work = this.serial.then(action)
    this.serial = work.catch(() => undefined); return work }
  private async scope(): Promise<string | null> {
    const owner = await this.options.owner()
    if (owner !== null && !/^[1-9][0-9]*$/u.test(owner)) sharingFail('LOGIN_REQUIRED')
    if (owner === this.currentOwner) return owner
    this.presenceAuthorized = false
    this.probeGeneration++; this.probeController?.abort(); this.probeAt = 0; this.probeCheckedAt = null
    this.localController?.abort(); this.localAt = 0
    this.localComfyOrigin = null; this.localImageOrigin = null; this.localVideoOrigin = null; this.localScanAt = 0
    this.localState = { image: initialSharingLocal(), video: initialSharingLocal() }
    this.discoveredLocal = this.localState
    this.apiSnapshot = undefined; this.apiResults.clear()
    this.gateway = this.options.gatewayOrigin ? 'checking' : 'unconfigured'
    const departing = this.currentOwner
    if (departing !== null) this.store?.revokeOwner(departing)
    this.controller.abort(); await this.closeResearchRecovery(); await this.stopPilot()
    this.controller.abort(); await this.stopPresence(); await this.provider?.close()
    if (departing !== null && this.draining(departing)) this.retainedRuntimes.set(departing, new Map(this.runtimes))
    else await Promise.allSettled([...this.runtimes.values()].map(p => p.runtime.close()))
    this.runtimes.clear(); this.runtimeHealth.clear(); this.reusable.clear(); this.qualifications.clear(); this.advertisedCapabilities = []
    this.provider = undefined; this.hardware = null
    this.currentOwner = owner; this.scopeId = owner === null ? null : randomUUID(); this.currentDeviceId = null
    this.executionState = 'unknown'; this.executionAt = 0
    this.controller = new AbortController(); this.hardwareAt = 0; this.qualificationAt = 0; this.restoreAt = 0; this.earningsAt = 0
    if (owner !== null) {
      this.store ??= await SharingStore.open(this.options.directory)
      if (this.options.research !== undefined && this.options.gatewayOrigin) this.research ??= await ResearchConsumer.open({
        directory: join(this.options.directory, 'research', sharingDigest(this.options.gatewayOrigin)),
        waitMs: this.options.research.waitMs, maximumRecords: this.options.research.maximumRecords,
        session: async () => this.researchSession(), pilot: async (lease, action) => this.researchPilot(lease, action),
        admission: async (lease, operation) => this.options.admission(async () => {
          this.researchAdmission = lease.attemptId
          try { return await operation() } finally { this.researchAdmission = undefined }
        }), occupancyChanged: this.options.occupancyChanged })
      const retained = this.retainedRuntimes.get(owner)
      if (retained !== undefined) { for (const [mode, runtime] of retained) this.runtimes.set(mode, runtime)
        this.retainedRuntimes.delete(owner) }
      this.provider = new SharingProvider({ store: this.store, directory: join(this.options.directory, 'accounts',
        sharingDigest(owner), 'attempts'),
      origin: this.options.gatewayOrigin, authorizationKeyId: this.options.authorizationKeyId,
      authorizationPublicKey: this.options.authorizationPublicKey,
      orderKeyId: this.options.orderKeyId, orderPublicKey: this.options.orderPublicKey,
      guangzhouKeyId: this.options.guangzhouKeyId, guangzhouPublicKey: this.options.guangzhouPublicKey,
      uploadKeyId: this.options.uploadKeyId, uploadPublicKey: this.options.uploadPublicKey,
      owner: this.options.owner, admission: this.options.admission, occupancyChanged: this.options.occupancyChanged,
      enabled: mode => this.executable(owner, mode),
      beforeSubmit: async (mode) => { await this.refreshExecution(); return this.executable(owner, mode) } })
      for (const [mode, installed] of this.runtimes) if (this.store.active(owner).some(a => a.mode === mode)) {
        if (installed.runtime.recoveryOnly) this.provider.bindOriginal(installed.manifest, installed.runtime, owner)
        else this.provider.bind(installed.manifest, installed.runtime)
      }
      for (const mode of MODES) if (this.store.mode(owner, mode).desired) this.store.updateMode(owner, mode, {
        phase: 'recovering', reason: null })
    }
    return owner
  }
  private authorized(owner: string, mode: SharingMode): boolean {
    return this.requireStore().mode(owner, mode).desired
      && this.requireStore().authorization(owner, this.currentDeviceId, mode).connection === 'granted'
  }
  private executionPermission(owner: string, mode: SharingMode): boolean {
    return this.authorized(owner, mode) && this.requireStore().authorization(owner, this.currentDeviceId, mode).execution === 'idle_only'
  }
  private idleExecution(): boolean { return !this.updateLocked && this.executionState === 'idle' && Date.now() - this.executionAt < 5000 }
  private executable(owner: string, mode: SharingMode): boolean {
    return this.live && this.currentOwner === owner && this.presenceAuthorized && this.authorized(owner, mode)
      && this.requireStore().authorization(owner, this.currentDeviceId, mode).execution === 'idle_only'
      && this.idleExecution()
      && !this.options.legacyBusy() && (this.qualifications.get(mode)?.until ?? 0) > Date.now()
  }
  private async refreshExecution(): Promise<void> {
    const owner = this.currentOwner
    let state: typeof this.executionState = 'unknown'
    try { state = await this.options.executionState?.() ?? 'unknown' } catch { /* Unknown cannot authorize execution. */ }
    if (owner === this.currentOwner && await this.options.owner() === owner) {
      this.executionState = state; this.executionAt = Date.now()
    } else { this.executionState = 'unknown'; this.executionAt = 0 }
  }
  private async device(owner: string): Promise<string> {
    const control = this.options.channel(); const device = await control.prepare()
    if (!SHARING_UUID.test(device) || await this.options.owner() !== owner || this.currentOwner !== owner
      || control.ownerId?.() !== owner) sharingFail('OWNER_CHANGED')
    this.currentDeviceId = device; return device
  }
  private probe(force = false): Promise<void> {
    if (this.probeWork !== undefined && !this.probeController?.signal.aborted) return this.probeWork
    if (!this.live || !force && Date.now() - this.probeAt < 15000) return Promise.resolve()
    if (!this.options.gatewayOrigin) { this.gateway = 'unconfigured'; return Promise.resolve() }
    const generation = this.probeGeneration; const nonce = randomUUID(); const local = new AbortController()
    this.probeController = local; this.probeAt = Date.now()
    if (this.probeCheckedAt === null) this.gateway = 'checking'
    const work = (async () => {
      try {
        const origin = mediaNodeOrigin(this.options.gatewayOrigin)
        const data = await sharingJSON(origin + '/v1/nodes/probe?nonce=' + nonce, { method: 'GET', cache: 'no-store',
          credentials: 'omit', signal: AbortSignal.any([local.signal, AbortSignal.timeout(this.options.probeTimeoutMs ?? 3000)]),
          headers: { Accept: 'application/json' } }, 2048)
        if (Object.keys(data).sort().join(',') !== 'nonce,schema,service,time'
          || data.schema !== 'qianshou.media-gateway-probe.v1' || data.service !== 'qianshou-guangzhou-media'
          || data.nonce !== nonce || typeof data.time !== 'number' || !Number.isSafeInteger(data.time)
          || Math.abs(data.time - Math.floor(Date.now() / 1000)) > 60) sharingFail('RESPONSE_INVALID')
        if (this.live && generation === this.probeGeneration && !local.signal.aborted) this.gateway = 'reachable'
      } catch {
        if (this.live && generation === this.probeGeneration && !local.signal.aborted) this.gateway = 'unavailable'
      } finally {
        if (this.live && generation === this.probeGeneration && !local.signal.aborted) this.probeCheckedAt = Math.floor(Date.now() / 1000)
      }
    })().finally(() => { if (this.probeWork === work) this.probeWork = undefined })
    this.probeWork = work; return work
  }
  private connection(owner: string | null): SharingConnectionState {
    const control = this.options.channel()
    const status = owner !== null && control.ownerId?.() === owner ? control.status() : undefined
    const connected = status?.state === 'connected' && status.authorized && status.connectionEpoch > 0
    const heartbeatAt = connected && typeof status.heartbeatAt === 'number' && Date.now() - status.heartbeatAt < 60000
      ? Math.floor(status.heartbeatAt / 1000) : null
    const checkedAt = this.probeCheckedAt !== null && Math.abs(Date.now() - this.probeCheckedAt * 1000) < 60000
      ? this.probeCheckedAt : null
    return { gateway: this.gateway === 'reachable' && checkedAt === null ? 'checking' : this.gateway,
      checkedAt,
      deviceAuthorization: connected ? 'authorized' : status?.state === 'offline' && status.errorCode === 'MEDIA_NODE_AUTH_REJECTED'
        ? 'unauthorized' : 'unknown',
      channel: status?.state === 'closed' || status === undefined ? 'idle' : status.state === 'connected'
        ? connected ? 'connected' : 'connecting' : status.state,
      heartbeat: heartbeatAt === null ? 'unknown' : 'accepted', heartbeatAt }
  }
  private async connectPresence(): Promise<void> {
    const owner = this.currentOwner
    if (this.presenceWork === undefined) {
      const control = this.options.channel()
      if (control.connectOwned === undefined) return
      const work = control.connectOwned().then(async (lease) => {
        if (lease === null) return
        if (!this.live || owner === null || !this.presenceAuthorized && !this.draining(owner)
          || this.currentOwner !== owner || await this.options.owner() !== owner) {
          await this.releasePresence(lease); return
        }
        this.presenceLease = lease
      }).catch(() => undefined).finally(() => { if (this.presenceWork === work) this.presenceWork = undefined })
      this.presenceWork = work
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.presenceWork, new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('PRESENCE_DEADLINE')) }, this.options.presenceConnectTimeoutMs ?? 1000)
      })])
    } catch { /* Gateway reachability and local preparation remain independent of a failed handshake. */ }
    finally { clearTimeout(timer) }
  }
  private async releasePresence(lease: MediaNodePresenceLease): Promise<void> {
    // A handshake may advance its epoch before the serialized withdrawal executes.
    // The private lease checks both the channel start and the observed epoch each time.
    for (let retry = 0; retry < 4; retry++) {
      const status = lease.current()
      if (status === undefined || await lease.disconnect(status.connectionEpoch)) return
    }
  }
  private async stopPresence(): Promise<void> {
    const lease = this.presenceLease; this.presenceLease = undefined
    if (lease !== undefined) await this.releasePresence(lease)
  }
  private draining(owner: string): boolean { return (this.store?.active() ?? []).some(attempt => attempt.owner === owner)
    || this.research?.draining(Number(owner)) === true }
  /** Check a fresh anonymous gateway challenge without enrolling or advertising a device.
   * @returns Completion after a bounded live probe; unreachable gateways remain a finite status.
   */
  async refreshConnection(): Promise<void> {
    await this.transaction(async () => this.scope()); await Promise.all([this.probe(true), this.refreshLocal(true), this.refreshHardware()])
    await this.transaction(async () => { const owner = await this.scope()
      if (owner !== null) {
        if (MODES.some(mode => this.requireStore().mode(owner, mode).desired) || this.draining(owner)) {
          try { await this.device(owner) } catch { this.currentDeviceId = null }
        }
        await this.reconcilePilot(owner)
      }
      await this.publishAPIs() })
  }
  private refreshHardware(force = false): Promise<void> {
    if (this.hardwareWork !== undefined) return this.hardwareWork
    if (!this.live || !force && Date.now() - this.hardwareAt < 10000) return Promise.resolve()
    const work = sharingHardware().then((hardware) => {
      if (this.live) { this.hardware = hardware; this.hardwareAt = Date.now() }
    }).catch(() => {
      if (this.live) { this.hardware = null; this.hardwareAt = Date.now() }
    }).finally(() => { if (this.hardwareWork === work) this.hardwareWork = undefined })
    this.hardwareWork = work; return work
  }
  private refreshLocal(force = false): Promise<void> {
    if (this.localWork !== undefined && !this.localController?.signal.aborted) return this.localWork
    if (!this.live || this.options.localDiscovery === undefined || !force && Date.now() - this.localAt < 15000) return Promise.resolve()
    const owner = this.currentOwner; const controller = new AbortController(); this.localController = controller; this.localAt = Date.now()
    const base = this.options.localDiscovery, autoDiscover = base.autoDiscover === true
      && Date.now() - this.localScanAt >= 60000
    if (autoDiscover) this.localScanAt = Date.now()
    const options = { ...base, autoDiscover, preferredComfyOrigin: this.localComfyOrigin ?? undefined,
      preferredImageOrigin: this.localImageOrigin ?? undefined, preferredVideoOrigin: this.localVideoOrigin ?? undefined }
    const work = discoverSharingLocal(options, controller.signal).then((value) => {
      if (this.live && this.currentOwner === owner && !controller.signal.aborted) {
        this.localState = value.states; this.discoveredLocal = value.states; this.localComfyOrigin = value.comfyOrigin
        this.localImageOrigin = value.imageOrigin; this.localVideoOrigin = value.videoOrigin }
    }).catch(() => {
      if (this.live && this.currentOwner === owner && !controller.signal.aborted) this.localState = {
        image: initialSharingLocal(), video: initialSharingLocal() }
      if (this.live && this.currentOwner === owner && !controller.signal.aborted) {
        this.discoveredLocal = this.localState; this.localComfyOrigin = null
        this.localImageOrigin = null; this.localVideoOrigin = null }
    }).finally(() => { if (this.localWork === work) this.localWork = undefined })
    this.localWork = work; return work
  }
  private freshLocal(mode: SharingMode): SharingLocalState {
    const value = this.localState[mode], at = value.checkedAt
    return at !== null && Math.abs(Date.now() - at * 1000) < 60000 ? value
      : { ...value, runtime: 'unknown', adoption: 'unmatched', checkedAt: null }
  }
  private observation(mode: SharingMode): SharingAPIObservation {
    return mode === 'image' && this.pilot !== undefined
      && Math.abs(Date.now() - Date.parse(this.pilot.observation.observedAt)) < 60000
      ? this.pilot.observation : sharingAPIObservation(mode, this.freshLocal(mode))
  }
  private async stopPilot(): Promise<void> {
    const pilot = this.pilot; this.pilot = undefined
    if (pilot !== undefined) { await pilot.handle.close(); this.localState = { ...this.localState, image: this.discoveredLocal.image } }
  }
  private async pilotAuthorized(owner: string, device: string, action: 'connect' | 'execute' | 'recover'): Promise<boolean> {
    if (!this.pilotScope(owner, device) || await this.options.owner() !== owner
      || this.options.channel().ownerId?.() !== owner
      || (action !== 'recover' || !this.research?.draining(Number(owner), device)) && !this.authorized(owner, 'image')
      || action !== 'recover' && this.options.presenceAllowed !== undefined && !await this.options.presenceAllowed()) return false
    if (action !== 'execute') return true
    await this.refreshExecution()
    if (!await this.comfyIdle()) return false
    return this.pilotScope(owner, device) && await this.options.owner() === owner
      && this.executionPermission(owner, 'image') && this.idleExecution() && !this.options.legacyBusy() && !this.formalBusy()
      && this.research?.busy(this.researchAdmission) !== true
  }
  private async comfyIdle(): Promise<boolean> {
    const discovery = this.options.localDiscovery
    const origin = this.pilot?.handle.comfyOrigin ?? this.localComfyOrigin ?? discovery?.comfyOrigin
    if (origin === undefined || origin === '') return false
    try {
      const queue = await sharingJSON(origin + '/queue', { method: 'GET',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(discovery?.timeoutMs ?? 2000)]) })
      return Array.isArray(queue.queue_running) && Array.isArray(queue.queue_pending)
        && queue.queue_running.length === 0 && queue.queue_pending.length === 0
    } catch { return false /* An unknown Comfy queue is not execution permission. */ }
  }
  private pilotScope(owner: string, device: string): boolean {
    return this.live && this.currentOwner === owner && this.currentDeviceId === device
  }
  private async reconcilePilot(owner: string): Promise<void> {
    const options = this.options.localDiscovery; const limits = this.options.pilot; const device = this.currentDeviceId
    const origin = this.localComfyOrigin ?? options?.comfyOrigin
    const local = this.discoveredLocal.image
    if (options === undefined || limits === undefined || !origin || device === null
      || !await this.pilotAuthorized(owner, device, 'connect')
      || !this.executionPermission(owner, 'image')
      // A response on the conventional image port may be an unrelated service. The private pilot
      // verifies the exact Qwen graph against the selected Comfy source before creating its API.
      || this.pilot === undefined && local.inventory !== 'detected'
      || this.pilot === undefined && this.research?.busy() === true) { await this.stopPilot(); return }
    if (this.pilot !== undefined && (this.pilot.owner !== owner || this.pilot.device !== device)) await this.stopPilot()
    if (this.researchRecovery.size > 0) await this.closeResearchRecovery()
    let opened: SharingPilot | undefined
    try {
      if (this.pilot === undefined) {
        const handle = await SharingPilot.open({ directory: join(this.options.directory, 'accounts', sharingDigest(owner),
          'devices', sharingDigest(device), 'image-pilot'), comfyOrigin: origin,
        legacyComfyOrigin: options.comfyOrigin,
        timeoutMs: limits.timeoutMs, maximumResultBytes: limits.maximumResultBytes,
        authorize: async action => this.pilotAuthorized(owner, device, action) })
        opened = handle
        if (!await this.pilotAuthorized(owner, device, 'connect')) { await handle.close(); return }
        const observation = await handle.observe(this.controller.signal)
        if (!await this.pilotAuthorized(owner, device, 'connect')) { await handle.close(); return }
        this.pilot = { owner, device, handle, observation }
        opened = undefined
      } else this.pilot.observation = await this.pilot.handle.observe(this.controller.signal)
      if (!await this.pilotAuthorized(owner, device, 'connect')) { await this.stopPilot(); return }
      const observed = this.pilot.observation
      this.localState = { ...this.localState, image: { ...local, adapter: 'comfyui',
        runtime: observed.status === 'ready' ? 'ready' : observed.status === 'auth_required' ? 'authentication_required' : observed.status,
        adoption: 'verification_required', checkedAt: Math.floor(Date.parse(observed.observedAt) / 1000) } }
    } catch { await opened?.close(); await this.stopPilot() /* Existing Comfy and other APIs remain owned by their original processes. */ }
  }
  private async publicPost(path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const owner = this.currentOwner; const token = await this.options.token()
    if (owner === null || !token || await this.options.owner() !== owner) sharingFail('LOGIN_REQUIRED')
    const response = await sharingJSON(this.options.gatewayOrigin + '/v1/media/' + path, { method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json' },
      body: sharingCanonical(body).toString() })
    if (await this.options.owner() !== owner) sharingFail('OWNER_CHANGED')
    return response
  }
  private async closeResearchRecovery(): Promise<void> {
    const handles = [...this.researchRecovery.values()]; this.researchRecovery.clear()
    await Promise.allSettled(handles.map(handle => handle.close()))
  }
  private async researchSession(): Promise<ResearchSession | null> {
    const owner = this.currentOwner; const control = this.options.channel(); const state = control.status()
    if (!this.live || owner === null || await this.options.owner() !== owner || control.ownerId?.() !== owner
      || state?.state !== 'connected' || !state.authorized || state.deviceId === null
      || this.currentDeviceId !== state.deviceId || !this.authorized(owner, 'image') && !this.draining(owner)) return null
    const session = control.session()
    if (session === undefined || session.uploadResearch === undefined || session.deviceId !== state.deviceId
      || session.connectionEpoch !== state.connectionEpoch) return null
    const upload = session.uploadResearch.bind(session)
    return { accountId: Number(owner), deviceId: session.deviceId, connectionEpoch: session.connectionEpoch,
      post: (path, body, signal) => session.post(path, body as Readonly<Record<string, unknown>>, signal),
      upload: (tuple, sha256, bytes, signal) => upload(tuple, sha256, bytes, signal) }
  }
  private async researchPilot(lease: ResearchLease, action: 'execute' | 'recover'): Promise<ResearchPilot | null> {
    const owner = String(lease.accountId); const device = lease.deviceId
    if (!await this.pilotAuthorized(owner, device, action)) return null
    if (action === 'execute') {
      const snapshot = this.apiSnapshot
      if (this.pilot?.owner !== owner || this.pilot.device !== device || snapshot?.owner !== owner
        || snapshot.device !== device || snapshot.epoch !== lease.connectionEpoch || !snapshot.acknowledged
        || snapshot.revision !== lease.observationRevision || this.options.channel().status()?.connectionEpoch !== lease.connectionEpoch
        || this.pilot.observation.workflow?.id !== lease.workflowId || this.pilot.observation.model?.id !== lease.modelId
        || this.apiState(owner, 'image').probeStatus !== 'passed') return null
      return this.pilot.handle
    }
    if (this.pilot?.owner === owner && this.pilot.device === device) return this.pilot.handle
    const key = owner + ':' + device
    const known = this.researchRecovery.get(key); if (known !== undefined) return known
    const local = this.options.localDiscovery; const limits = this.options.pilot
    if (local?.comfyOrigin === undefined || local.comfyOrigin === '' || limits === undefined) return null
    try {
      const handle = await SharingPilot.open({ directory: join(this.options.directory, 'accounts', sharingDigest(owner),
        'devices', sharingDigest(device), 'image-pilot'), comfyOrigin: this.localComfyOrigin ?? local.comfyOrigin,
      legacyComfyOrigin: local.comfyOrigin, timeoutMs: limits.timeoutMs,
      maximumResultBytes: limits.maximumResultBytes, recoveryOnly: true,
      authorize: async requested => requested === 'recover' && await this.pilotAuthorized(owner, device, 'recover') })
      if (!await this.pilotAuthorized(owner, device, 'recover')) { await handle.close(); return null }
      this.researchRecovery.set(key, handle); return handle
    } catch { return null /* Missing original identity remains unknown; no replacement API or task is created. */ }
  }
  private async researchExecution(): Promise<void> {
    const config = this.options.research; const session = await this.researchSession(); const snapshot = this.apiSnapshot
    if (config === undefined || session === null || !snapshot?.acknowledged || snapshot.owner !== String(session.accountId)
      || snapshot.device !== session.deviceId || snapshot.epoch !== session.connectionEpoch
      || Date.now() - this.researchExecutionAt < config.executionIntervalMs) return
    this.researchExecutionAt = Date.now(); await this.refreshExecution()
    const owner = String(session.accountId)
    let idle: boolean | null = this.executionState === 'unknown' ? null : this.executionState === 'idle'
    if (this.options.legacyBusy() || this.busy() || this.preparing.size > 0) idle = false
    const allowed = this.executionPermission(owner, 'image') && this.presenceAuthorized
      && !this.updateLocked && this.executionState !== 'disabled'
    if (idle === true && !await this.comfyIdle()) idle = null
    const resourceAllowed = this.executionState === 'unknown' ? null : allowed
    const current = this.options.channel().session()
    if (current === undefined || current.deviceId !== session.deviceId || current.connectionEpoch !== session.connectionEpoch
      || await this.options.owner() !== owner || this.apiSnapshot !== snapshot) return
    const reply = exact(await current.post('research/execution', {
      observationRevision: snapshot.revision, mode: 'image', idle, resourceAllowed }, this.controller.signal),
    ['ok', 'deviceId', 'connectionEpoch', 'observationRevision', 'mode', 'observedAt'])
    if (reply.ok !== true || reply.deviceId !== session.deviceId || reply.connectionEpoch !== session.connectionEpoch
      || reply.observationRevision !== snapshot.revision || reply.mode !== 'image' || typeof reply.observedAt !== 'string'
      || !Number.isFinite(Date.parse(reply.observedAt))) sharingFail('RESPONSE_INVALID')
  }

  private async publishDeviceInfo(): Promise<void> {
    const owner = this.currentOwner; const state = this.options.channel().status(); const hardware = this.hardware
    if (owner === null || hardware === null || state?.state !== 'connected' || !state.authorized
      || state.deviceId === null || this.options.channel().ownerId?.() !== owner || await this.options.owner() !== owner) return
    const key = owner + ':' + state.deviceId + ':' + String(state.connectionEpoch)
    if (key === this.deviceInfoKey) return
    const session = this.options.channel().session()
    if (session === undefined || session.deviceId !== state.deviceId || session.connectionEpoch !== state.connectionEpoch) return
    const caption = (value: string | undefined): string | null => typeof value === 'string' && value.length > 0
      && value.length <= 256 && !/[\u0000-\u001f\u007f\\/]/u.test(value) && !/https?:|localhost/iu.test(value)
      ? value : null
    this.deviceInfoKey = key
    const reply = exact(await session.post('device-info', { deviceInfo: { os: hardware.platform,
      osVersion: hardware.platform === 'darwin' ? null : caption(release()),
      arch: hardware.arch, deviceName: null, cpu: caption(cpus()[0]?.model), gpu: hardware.gpuName === 'Unknown GPU' ? null : caption(hardware.gpuName),
      memoryMb: hardware.memoryMb, vramMb: hardware.vramMb > 0 ? hardware.vramMb : null } }, this.controller.signal),
    ['ok', 'deviceId', 'connectionEpoch'])
    if (reply.ok !== true || reply.deviceId !== state.deviceId || reply.connectionEpoch !== state.connectionEpoch) sharingFail('RESPONSE_INVALID')
  }
  private apiStructure(observations: readonly SharingAPIObservation[]): string {
    return sharingDigest(observations.map(({ observedAt: _observedAt, ...identity }) => identity))
  }
  private async publishAPIs(): Promise<void> {
    const owner = this.currentOwner; const control = this.options.channel()
    const status = control.ownerId?.() === owner ? control.status() : undefined
    if (owner === null || status?.state !== 'connected' || !status.authorized || status.deviceId === null
      || await this.options.owner() !== owner) return
    let snapshot = this.apiSnapshot
    // Only unacknowledged metadata expires: a lost GPU submission never uses this retry policy.
    if (snapshot !== undefined && !snapshot.acknowledged && snapshot.observations.length > 0
      && Date.now() - Math.min(...snapshot.observations.map(o => Date.parse(o.observedAt))) >= 60000) {
      await this.refreshLocal(true)
      if (await this.options.owner() !== owner || this.currentOwner !== owner || control.ownerId?.() !== owner
        || control.status()?.connectionEpoch !== status.connectionEpoch) return
      snapshot = undefined
    }
    const observations = MODES.filter(mode => this.presenceAuthorized && this.authorized(owner, mode))
      .map(mode => this.observation(mode))
    // A manual channel without sharing intent is owned by its original consumer.
    if (observations.length === 0 && (this.apiSnapshot === undefined || this.apiSnapshot.owner !== owner
      || this.apiSnapshot.device !== status.deviceId || this.apiSnapshot.epoch !== status.connectionEpoch)) return
    const structure = this.apiStructure(observations)
    if (snapshot === undefined || snapshot.owner !== owner || snapshot.device !== status.deviceId
      || snapshot.epoch !== status.connectionEpoch || snapshot.structure !== structure) {
      snapshot = { owner, device: status.deviceId, epoch: status.connectionEpoch, structure,
        revision: sharingDigest({ epoch: status.connectionEpoch, observations }), observations, acknowledged: false }
      this.apiSnapshot = snapshot; this.apiResults.clear()
    }
    if (snapshot.acknowledged) return
    const session = control.session()
    if (session === undefined || session.deviceId !== snapshot.device || session.connectionEpoch !== snapshot.epoch) return
    try {
      const reply = await session.post('api-observations', { observationRevision: snapshot.revision, observations: snapshot.observations },
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.probeTimeoutMs ?? 3000)]))
      if (this.currentOwner !== owner || await this.options.owner() !== owner || this.apiSnapshot !== snapshot
        || control.status()?.connectionEpoch !== snapshot.epoch) return
      if (reply.ok !== true || reply.deviceId !== snapshot.device || reply.connectionEpoch !== snapshot.epoch
        || reply.observationRevision !== snapshot.revision) sharingFail('RESPONSE_INVALID')
      snapshot.acknowledged = true
    } catch { /* Retry this original immutable metadata body; no execution or registration is repeated. */ }
  }
  private async apiProbe(probe: SharingAPIProbe, signal: AbortSignal, session: SharingNodeSession): Promise<void> {
    const owner = await this.scope(); const snapshot = this.apiSnapshot
    if (!this.live || owner === null || !this.authorized(owner, probe.mode) || !snapshot?.acknowledged
      || snapshot.owner !== owner || snapshot.device !== session.deviceId || snapshot.epoch !== probe.epoch
      || session.connectionEpoch !== probe.epoch || Date.parse(probe.expiresAt) <= Date.now()) return
    const declared = snapshot.observations.find(o => o.mode === probe.mode)
    if (declared === undefined || declared.status !== 'ready' || this.options.localDiscovery === undefined) return
    try {
      const deadline = AbortSignal.any([signal, this.controller.signal,
        AbortSignal.timeout(Math.max(1, Date.parse(probe.expiresAt) - Date.now()))])
      const discovered = await discoverSharingLocal({ ...this.options.localDiscovery, autoDiscover: false,
        preferredComfyOrigin: this.localComfyOrigin ?? undefined,
        preferredImageOrigin: this.localImageOrigin ?? undefined,
        preferredVideoOrigin: this.localVideoOrigin ?? undefined }, deadline)
      const local = discovered.states
      if (await this.options.owner() !== owner || this.currentOwner !== owner || !this.authorized(owner, probe.mode)
        || this.options.channel().ownerId?.() !== owner || this.options.channel().status()?.connectionEpoch !== probe.epoch) return
      this.localState = local; this.discoveredLocal = local; this.localComfyOrigin = discovered.comfyOrigin
      this.localImageOrigin = discovered.imageOrigin; this.localVideoOrigin = discovered.videoOrigin; this.localAt = Date.now()
      const observed = probe.mode === 'image' && declared.adapter === 'comfyui'
        ? this.pilot === undefined ? { ...sharingAPIObservation(probe.mode, local[probe.mode]), adapter: 'comfyui' as const,
          status: 'unavailable' as const, model: null, workflow: null } : await this.pilot.handle.observe(deadline)
        : sharingAPIObservation(probe.mode, local[probe.mode])
      if (await this.options.owner() !== owner || this.currentOwner !== owner || !this.authorized(owner, probe.mode)) return
      if (probe.mode === 'image' && declared.adapter === 'comfyui' && this.pilot !== undefined) {
        this.pilot.observation = observed
        this.localState = { ...local, image: { ...local.image, adapter: 'comfyui',
          runtime: observed.status === 'ready' ? 'ready' : observed.status === 'auth_required' ? 'authentication_required' : observed.status,
          adoption: 'verification_required', checkedAt: Math.floor(Date.parse(observed.observedAt) / 1000) } }
      }
      // A failed check describes the original declared adapter, not a replacement runtime or GPU action.
      const original = this.requireStore().apiProbeReceipt(owner, session.deviceId, probe, { ...observed, adapter: declared.adapter })
      const reply = await session.post('api-probe-result', { requestId: probe.requestId, observation: original.observation }, deadline)
      if (await this.options.owner() !== owner || this.currentOwner !== owner || !this.authorized(owner, probe.mode)
        || this.options.channel().status()?.connectionEpoch !== probe.epoch) return
      if (reply.ok !== true || reply.deviceId !== session.deviceId || reply.connectionEpoch !== probe.epoch
        || reply.requestId !== probe.requestId
        || reply.status !== 'confirmed' && reply.status !== 'failed' || reply.status === 'confirmed' && original.observation.status !== 'ready'
        || reply.status === 'failed' && reply.confirmedAt !== null
        || reply.status === 'confirmed' && (typeof reply.confirmedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u.test(reply.confirmedAt)
          || !Number.isFinite(Date.parse(reply.confirmedAt)) || Date.parse(reply.confirmedAt) > Date.now() + 5000)) sharingFail('RESPONSE_INVALID')
      const confirmedAt = reply.status === 'confirmed' ? String(reply.confirmedAt) : null
      this.requireStore().ackAPIProbe(owner, probe.requestId, reply.status, confirmedAt)
      this.apiResults.set(probe.mode, { device: session.deviceId, epoch: probe.epoch, structure: this.apiStructure([original.observation]),
        status: reply.status, confirmedAt })
    } catch { /* The durable original UUID/observation may be replayed; all local requests were GET-only. */ }
  }
  private apiState(owner: string | null, mode: SharingMode): SharingAPIState {
    const observation = this.observation(mode); const snapshot = this.apiSnapshot
    const control = this.options.channel(); const status = owner !== null && control.ownerId?.() === owner ? control.status() : undefined
    const current = owner !== null && this.authorized(owner, mode) && status?.state === 'connected' && status.authorized
      && snapshot?.owner === owner && snapshot.device === status.deviceId && snapshot.epoch === status.connectionEpoch
      && snapshot.observations.some(o => o.mode === mode && this.apiStructure([o]) === this.apiStructure([observation]))
    const result = current ? this.apiResults.get(mode) : undefined
    const confirmed = result?.status === 'confirmed' && result.device === status?.deviceId && result.epoch === status.connectionEpoch
      && result.structure === this.apiStructure([observation]) && result.confirmedAt !== null
      && Date.now() - Date.parse(result.confirmedAt) < 120000
    return { status: observation.status, adapter: observation.adapter === 'unidentified' ? null : observation.adapter,
      modelName: observation.model?.id === 'qwen-image-2.1-int8-convrot' ? 'Qwen Image 2.1 (INT8 ConvRot)' : null,
      workflowName: observation.workflow?.id === 'qianshou-qwen-image21-text-to-image'
        || observation.workflow?.id === 'comfy-pilot-image-154f7d6133fe0276' ? 'Qwen Image 2.1 text-to-image' : null,
      registration: current ? snapshot.acknowledged ? 'registered' : 'pending' : 'unknown', lastProbedAt: confirmed ? result.confirmedAt : null,
      probeStatus: confirmed ? 'passed' : result?.status === 'failed' ? 'failed' : current && snapshot.acknowledged && observation.status === 'ready' ? 'pending' : 'unknown' }
  }
  private async prepare(mode: SharingMode, owner: string): Promise<void> {
    const store = this.requireStore(); const local = new AbortController(); this.preparationControllers.set(mode, local)
    const signal = AbortSignal.any([this.controller.signal, local.signal]); const stopped = (): boolean => signal.aborted
    const observe = (phase: Parameters<SharingStore['updateMode']>[2]): void => {
      if (this.currentOwner === owner && store.mode(owner, mode).desired && !signal.aborted) store.updateMode(owner, mode, phase)
    }
    try {
      observe({ phase: 'detecting', reason: null }); await this.refreshHardware(true)
      if (this.hardware === null) sharingFail('HARDWARE_UNSUPPORTED')
      observe({ completedSteps: ['detect'] }); await this.refreshLocal()
      if (!this.options.gatewayOrigin || !this.options.metadataPublicKey || !this.options.metadataKeyId) sharingFail(
        'CATALOG_UNAVAILABLE')
      const workerId = this.options.workerId(); if (workerId === null || !SHARING_UUID.test(workerId)) sharingFail('VERIFICATION_PENDING')
      observe({ phase: 'matching', completedSteps: ['detect'] })
      const deviceId = await this.device(owner); const nonce = randomUUID()
      const response = await this.publicPost('install-manifest', { nonce, deviceId, workerId, mode,
        platform: this.hardware.platform, arch: this.hardware.arch,
        hardware: { gpu_name: this.hardware.gpuName, vram_mb: this.hardware.vramMb, memory_mb: this.hardware.memoryMb } }, signal)
      const manifest = parseSharingManifest(response.manifest, { nonce, deviceId, workerId, owner: Number(owner), mode,
        hardware: this.hardware, keyId: this.options.metadataKeyId, publicKey: this.options.metadataPublicKey,
        downloadOrigins: this.options.downloadOrigins.length === 0 ? [this.options.gatewayOrigin] : this.options.downloadOrigins })
      if (!this.authorized(owner, mode) || stopped()) return
      store.updateMode(owner, mode, { modelName: manifest.display_name, completedSteps: ['detect'] },
        sharingEnvelope(response.manifest))
      await this.refreshExecution()
      if (!this.executionPermission(owner, mode)) sharingFail('EXECUTION_DISABLED')
      if (this.executionState !== 'idle') sharingFail(this.executionState === 'busy' ? 'IDLE_REQUIRED' : 'RESOURCE_UNAVAILABLE')
      const runtime = new SharingRuntime(join(this.options.directory, 'accounts', sharingDigest(owner), 'bundles',
        manifest.bundle_id), manifest)
      this.runtimes.set(mode, { runtime, manifest })
      const reused = await runtime.installed(signal)
      if (!reused) {
        observe({ phase: 'downloading' })
        await runtime.install(signal, (downloadedBytes, totalDownloadBytes) =>{  observe({ downloadedBytes, totalDownloadBytes }) })
      } else observe({ downloadedBytes: 0, totalDownloadBytes: 0 })
      this.reusable.add(mode)
      const preparedSteps = reused ? ['detect', 'install'] : ['detect', 'download', 'install']
      observe({ phase: 'installing', completedSteps: preparedSteps })
      await this.refreshExecution()
      if (!this.executionPermission(owner, mode) || !this.idleExecution() || stopped()) {
        await runtime.close(); this.runtimes.delete(mode); return
      }
      observe({ phase: 'starting', completedSteps: preparedSteps }); await runtime.start(signal)
      observe({ phase: 'connecting', completedSteps: [...preparedSteps, 'api'] })
      await this.qualify(owner, deviceId, workerId, signal)
      if (!this.qualifications.has(mode)) sharingFail('VERIFICATION_PENDING')
      if (!this.presenceAuthorized || this.options.presenceAllowed !== undefined && !await this.options.presenceAllowed()) sharingFail('OWNER_POLICY_BLOCKED')
      await this.connectPresence()
    } catch (error) {
      if (signal.aborted || this.currentOwner !== owner) {
        const runtime = this.runtimes.get(mode); if (runtime !== undefined && !this.busy()) { await runtime.runtime.close(
        ).catch(() => undefined); this.runtimes.delete(mode) }
        return
      }
      const code = error instanceof NodeContributorError ? error.code : ''
      const reason = code.includes('EXECUTION_DISABLED') ? 'execution_disabled' : code.includes('IDLE_REQUIRED') ? 'idle_required'
        : code.includes('RESOURCE_UNAVAILABLE') ? 'resource_unavailable' : code.includes('OWNER_POLICY') ? 'owner_policy_blocked' : code.includes('HARDWARE') ? 'hardware_unsupported' : code.includes('DISK') ? 'disk_space'
          : code.includes('VERIFICATION') || code.includes('SIGNATURE') ? 'verification_pending' : code.includes(
            'RUNTIME') ? 'runtime_unavailable'
            : code.includes('DOWNLOAD') || code.includes('HASH') ? 'download_failed' : 'catalog_unavailable'
      observe({ phase: 'blocked', reason })
    }
  }
  private async restoreOriginal(owner: string): Promise<void> {
    if (Date.now() - this.restoreAt < 10000) return
    this.restoreAt = Date.now()
    const device = this.currentDeviceId; const worker = this.options.workerId()
    if (device === null || worker === null || this.hardware === null) return
    for (const mode of MODES) {
      if (this.runtimes.has(mode) || !this.requireStore().active(owner).some(a => a.mode === mode
        && ['submitting', 'running', 'unknown'].includes(a.state))) continue
      try {
        const saved = this.requireStore().mode(owner, mode).manifest
        if (saved === null || typeof saved.payload.nonce !== 'string') continue
        const manifest = parseSharingManifest(saved, { nonce: saved.payload.nonce, owner: Number(owner), deviceId: device,
          workerId: worker, mode, hardware: this.hardware, keyId: this.options.metadataKeyId,
          publicKey: this.options.metadataPublicKey, restoreReceipt: true,
          downloadOrigins: this.options.downloadOrigins.length === 0 ? [this.options.gatewayOrigin] : this.options.downloadOrigins })
        const active = this.requireStore().active(owner).filter(a => a.mode === mode)
        if (!active.every((a) => { const plan = sharingObject(a.task.envelope.plan)
          return manifest.profiles.some(cap => Object.keys(cap).every(key => Reflect.get(cap, key) === plan[key])) })) continue
        const runtime = new SharingRuntime(join(this.options.directory, 'accounts', sharingDigest(owner), 'bundles', manifest.bundle_id), manifest)
        if (!await runtime.adoptOriginal(this.controller.signal) || await this.options.owner() !== owner) continue
        this.runtimes.set(mode, { manifest, runtime }); this.reusable.add(mode)
        this.requireProvider().bindOriginal(manifest, runtime, owner)
      } catch { /* Missing or changed installed identity retains unknown; no download/start/POST fallback exists. */ }
    }
  }
  private async qualify(owner: string, deviceId: string, workerId: string, signal: AbortSignal): Promise<void> {
    const nonce = randomUUID(); const response = await this.publicPost('devices/qualification', { nonce, deviceId, workerId }, signal)
    const payload = sharingVerify(response.qualification, { keyId: this.options.metadataKeyId, publicKey: this.options.metadataPublicKey,
      schema: 'qianshou.formal-media-directory-qualification.v1', purpose: 'qianshou:formal-media-directory-qualification', ttl: 30 })
    if (Object.keys(payload).sort().join(',') !== 'expires_at,issued_at,nonce,profiles,purpose,schema'
      || payload.nonce !== nonce || !Array.isArray(payload.profiles)) sharingFail('VERIFICATION_PENDING')
    for (const mode of MODES) {
      const installed = this.runtimes.get(mode); this.qualifications.delete(mode)
      if (installed === undefined || installed.runtime.recoveryOnly || !await installed.runtime.healthy(signal)) {
        this.provider?.unbind(mode); continue
      }
      const profiles = payload.profiles.map(sharingObject).filter(p => p.deviceId === deviceId && p.ownerId === owner
        && p.worker_id === workerId
        && p.executor_sha256 === installed.manifest.executor_sha256 && p.hardware_qualification === 'rtx_4060_or_better_verified'
        && Number(p.authorized_until) * 1000 > Date.now() && Number(p.verified_until) * 1000 > Date.now()
        && p.gpu_model === this.hardware?.gpuName && Number(p.vram_mb) <= (this.hardware?.vramMb ?? 0)
        && Number(p.total_memory_mb) <= (this.hardware?.memoryMb ?? 0) && p.max_concurrent === 1
        && Number.isSafeInteger(p.max_task_seconds) && Number(p.max_task_seconds) > 0
        && Number.isSafeInteger(p.p90_execution_seconds) && Number(p.p90_execution_seconds) > 0)
      const exact = installed.manifest.profiles.filter(cap => profiles.some(p => Object.keys(cap).every(k => Reflect.get(cap, k) === p[k])))
      if (exact.length !== installed.manifest.profiles.length || !this.options.authorizationPublicKey || !this.options.orderPublicKey
        || !this.options.uploadPublicKey || !this.options.guangzhouPublicKey || !this.options.guangzhouKeyId
          || !this.options.authorizationKeyId || !this.options.orderKeyId
          || !this.options.uploadKeyId) { this.provider?.unbind(mode); continue }
      this.qualifications.set(mode, { until: Number(payload.expires_at) * 1000, maxSeconds: Math.min(...profiles.map(
        p => Number(p.max_task_seconds))), capabilities: exact })
      this.requireProvider().bind(installed.manifest, installed.runtime)
    }
    this.qualificationAt = Date.now()
  }
  private async heartbeat(): Promise<MediaNodeHeartbeat> {
    await this.refreshExecution()
    const owner = await this.options.owner(); const active = this.store?.active() ?? []
    const qualified = [...this.qualifications.entries()].filter(([mode, q]) => q.until > Date.now()
      && owner === this.currentOwner && owner !== null && this.executable(owner, mode))
    const clear = this.live && this.presenceAuthorized && qualified.length > 0 && active.length === 0 && !this.options.legacyBusy()
      && Date.now() - this.hardwareAt <= 10000 && (this.hardware?.freeVramMb ?? 0) > 0
      && (await Promise.all(qualified.map(([mode]) => this.runtimes.get(mode)?.runtime.healthy(
        this.controller.signal) ?? Promise.resolve(false)))).every(Boolean)
    return { freeSlots: clear ? 1 : 0, runningAttemptIds: active.filter(a => a.owner === owner).map(a => a.task.attemptId),
      freeVramMb: this.hardware?.freeVramMb ?? 0,
      availableSeconds: clear ? Math.min(...qualified.map(([, q]) => q.maxSeconds)) : 0 }
  }
  private async earnings(owner: string): Promise<void> {
    const origin = this.options.coreOrigin(); const token = await this.options.token(); if (!origin || !token) return
    try {
      const data = await sharingJSON(origin + '/api/v8/media/provider/summary', { signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + token } }, 16384)
      if (await this.options.owner() !== owner || data.currency !== 'CNY' || data.basis !== 'actual_settled_ledger') return
      const modes = sharingObject(data.modes)
      for (const mode of MODES) { const row = sharingObject(modes[mode]); const earnings = row.settledEarnings
        if (typeof row.completedCalls !== 'number' || !Number.isSafeInteger(row.completedCalls) || row.completedCalls < 0
          || typeof earnings !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u.test(earnings)) sharingFail('RESPONSE_INVALID')
        this.requireStore().updateMode(owner, mode, { completedCalls: row.completedCalls, settledYuan: earnings,
          completedSteps: ['earnings'] }) }
      this.earningsAt = Date.now()
    } catch { /* Unknown statistics remain unknown; transport failure is not zero income. */ }
  }
  private projectFreeConnection(owner: string, mode: SharingMode): boolean {
    if (this.options.localDiscovery === undefined || this.runtimes.has(mode)) return false
    const api = this.observation(mode)
    const connection = this.connection(owner)
    const absent = api.status !== 'ready' && api.status !== 'unknown'
    const disconnected = !this.options.gatewayOrigin || connection.channel !== 'connected'
      && (connection.gateway === 'unavailable' || connection.channel === 'offline')
    this.requireStore().updateMode(owner, mode, {
      phase: absent || api.status === 'ready' && disconnected ? 'blocked'
        : api.status === 'unknown' ? 'detecting' : 'connecting',
      reason: absent ? 'runtime_unavailable' : api.status === 'ready' && disconnected ? 'connection_unavailable' : null,
      completedSteps: api.status === 'ready' ? connection.channel === 'connected' ? ['detect', 'connect', 'persist'] : ['detect'] : [],
    })
    return true
  }
  private async tick(): Promise<void> {
    if (!this.live) return
    const owner = await this.scope(); void this.probe(); void this.refreshLocal(); void this.refreshHardware(); if (owner === null) return
    const desired = MODES.some(mode => this.requireStore().mode(owner, mode).desired)
    if (desired || this.draining(owner)) { try { await this.device(owner) } catch { this.currentDeviceId = null } }
    await this.refreshExecution()
    if (this.draining(owner)) { await this.refreshHardware(); await this.restoreOriginal(owner) }
    for (const [mode, installed] of this.runtimes) if (installed.runtime.recoveryOnly
      && !this.requireStore().active(owner).some(a => a.mode === mode)) {
      await installed.runtime.close(); this.runtimes.delete(mode); this.reusable.delete(mode)
    }
    try { this.presenceAuthorized = MODES.some(mode => this.authorized(owner, mode))
      && (this.options.presenceAllowed === undefined || await this.options.presenceAllowed())
      && await this.options.owner() === owner } catch { this.presenceAuthorized = false }
    if ((this.presenceAuthorized || this.draining(owner)) && this.options.gatewayOrigin) await this.connectPresence()
    else await this.stopPresence()
    void this.refreshLocal(); await this.reconcilePilot(owner)
    await this.publishAPIs()
    // Optional metadata and task work never hold the status/consent queue through GPU execution.
    void this.publishDeviceInfo().catch(() => undefined)
    void this.researchExecution().catch(() => undefined)
    void this.research?.tick(this.controller.signal).catch(() => undefined)
    for (const mode of MODES) {
      const saved = this.requireStore().mode(owner, mode)
      if (!saved.desired) { if (saved.state.phase !== 'paused' && saved.state.operationId !== null) this.requireStore(
      ).updateMode(owner, mode, { phase: 'paused', reason: null }); continue }
      if (!this.authorized(owner, mode)) {
        this.preparationControllers.get(mode)?.abort()
        this.requireStore().updateMode(owner, mode, { phase: 'blocked', reason: 'consent_required' }); continue
      }
      if (!this.presenceAuthorized) {
        this.preparationControllers.get(mode)?.abort()
        this.requireStore().updateMode(owner, mode, { phase: 'blocked', reason: 'owner_policy_blocked' }); continue
      }
      // Existing API connection and metadata are independent of paid package/device qualification and GPU idle.
      if (this.projectFreeConnection(owner, mode)) continue
      const executionReason = !this.executionPermission(owner, mode) || this.executionState === 'disabled' ? 'execution_disabled'
        : this.executionState === 'busy' || this.requireStore().active().length !== 0 ? 'idle_required' : this.executionState !== 'idle' ? 'resource_unavailable' : null
      if (executionReason !== null) {
        this.preparationControllers.get(mode)?.abort()
        this.requireStore().updateMode(owner, mode, { phase: 'blocked', reason: executionReason }); continue
      }
      if (['owner_policy_blocked', 'consent_required', 'execution_disabled', 'idle_required', 'resource_unavailable'].includes(saved.state.reason ?? '')) this.requireStore().updateMode(owner, mode, { phase: 'recovering', reason: null })
      if (!this.runtimes.has(mode) && !this.preparing.has(mode)) {
        // A user action or process restart attempts real preparation; no rapid catalog/download retry loops.
        if (saved.state.phase === 'blocked' || saved.state.phase === 'failed') continue
        const work = this.prepare(mode, owner).finally(() => { this.preparing.delete(mode)
          this.preparationControllers.delete(mode) }); this.preparing.set(mode, work)
      }
    }
    if (this.runtimes.size > 0 && Date.now() - this.hardwareAt > 5000) {
      await this.refreshHardware(true)
    }
    for (const [mode, installed] of this.runtimes) {
      if (this.preparing.has(mode) || !this.executionPermission(owner, mode) || this.executionState !== 'idle' || await installed.runtime.healthy(
        this.controller.signal)) continue
      // An unresolved job retains its original process reference and GET-only recovery.
      if (this.draining(owner)) continue
      this.provider?.unbind(mode); this.qualifications.delete(mode)
      this.requireStore().updateMode(owner, mode, { phase: 'recovering', reason: 'runtime_unavailable' })
      const runtime = new SharingRuntime(installed.runtime.root, installed.manifest)
      try { await runtime.start(this.controller.signal); this.runtimes.set(mode, { ...installed, runtime }); this.qualificationAt = 0 }
      catch { this.requireStore().updateMode(owner, mode, { phase: 'blocked', reason: 'runtime_unavailable' }) }
    }
    if (this.presenceAuthorized && this.executionState === 'idle' && this.runtimes.size > 0 && this.preparing.size === 0 && Date.now() - this.qualificationAt > 10000) {
      try { const worker = this.options.workerId(); const device = await this.device(owner)
        if (worker) await this.qualify(owner, device, worker, this.controller.signal) } catch {
        /* Expiry withdraws free slots without inventing a receipt. */ }
    }
    if (this.presenceAuthorized && this.qualifications.size > 0) {
      await this.connectPresence(); const session = this.options.channel().session()
      if (session !== undefined) this.requireProvider().recover(session)
      const control = this.options.channel(); const status = control.ownerId?.() === owner ? control.status() : undefined
      for (const [mode, q] of this.qualifications) if (this.executable(owner, mode)) {
        const connected = q.until > Date.now() && status?.state === 'connected' && status.connectionEpoch > 0
        // Connected is published only after the channel's exact epoch has been persisted.
        this.requireStore().updateMode(owner, mode, { phase: connected ? 'sharing' : 'connecting', reason: null,
          completedSteps: connected ? ['connect', 'persist'] : [] })
      }
    }
    // Pausing supply preserves only fixed operations for the already admitted original attempt.
    const channel = this.options.channel()
    if (this.draining(owner) && channel.ownerId?.() === owner && channel.status()?.state === 'connected') {
      const session = channel.session(); if (session !== undefined) this.requireProvider().recover(session)
    }
    if (Date.now() - this.earningsAt > 15000) await this.earnings(owner)
  }
  /** Start persistent supervision; preparation only follows saved explicit owner intent.
   * @returns Nothing; teardown is exposed through close().
   */
  start(): void {
    const cycle = async (): Promise<void> => {
      try { await this.transaction(async () => this.tick()) } catch { /* Status exposes finite mode reasons on the next owner action. */ }
      if (this.live) { this.timer = setTimeout(() => { void cycle() }, 3000); this.timer.unref() }
    }
    void cycle()
  }
  /** Read an exact current-owner projection without exposing process or connection secrets.
   * @returns Snapshot with exactly image/video and actual or unknown statistics.
   */
  async snapshot(requestId?: string): Promise<SharingSnapshot> {
    const owner = await this.statusDeadline(this.options.owner())
    if (owner !== null && !/^[1-9][0-9]*$/u.test(owner)) sharingFail('LOGIN_REQUIRED')
    if (owner !== this.currentOwner || owner !== null && this.store === undefined) {
      try { await this.statusDeadline(this.transaction(async () => this.scope())) } catch { return this.pendingSnapshot(owner) }
    }
    if (owner !== this.currentOwner || owner !== null && this.store === undefined) return this.pendingSnapshot(owner)
    const snapshot = this.projectSnapshot(owner, requestId)
    void this.refreshRuntimeHealth()
    return snapshot
  }
  private async statusDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new NodeContributorError('SHARING_STATUS_UNAVAILABLE')) }, this.options.statusTimeoutMs ?? 1000)
    })]) } finally { clearTimeout(timer) }
  }
  private pendingSnapshot(owner: string | null): SharingSnapshot {
    return { schema: 'qianshou.compute-sharing.v1', authenticated: owner !== null, scopeId: null, operation: null,
      hardware: null, connection: { gateway: this.options.gatewayOrigin ? 'checking' : 'unconfigured', checkedAt: null,
        deviceAuthorization: 'unknown', channel: 'idle',
        heartbeat: 'unknown', heartbeatAt: null }, modes: MODES.map(mode => ({ ...initialSharingMode(mode), local: initialSharingLocal(),
        api: { status: 'unknown', adapter: null, modelName: null, workflowName: null, registration: 'unknown', lastProbedAt: null,
          probeStatus: 'unknown' }, authorization: { connection: 'required', execution: 'disabled', deviceBound: false } })) }
  }
  private projectSnapshot(owner: string | null, requestId?: string): SharingSnapshot {
    const local = new Map<SharingMode, SharingLocalState>()
    for (const mode of MODES) {
      const installed = this.runtimes.get(mode)
      const observed = this.freshLocal(mode)
      const health = this.runtimeHealth.get(mode)
      const ready = installed !== undefined && health?.runtime === installed.runtime && health.ready
          && Date.now() - health.checkedAt <= 10000
      local.set(mode, ready ? { ...observed, adapter: 'qianshou_media_runtime', runtime: 'ready', adoption: 'reused',
        checkedAt: Math.floor(Date.now() / 1000) } : installed !== undefined && this.reusable.has(mode)
        ? { ...observed, adapter: 'qianshou_media_runtime', runtime: 'unknown', adoption: 'reusable',
          checkedAt: Math.floor(Date.now() / 1000) } : observed)
    }
    return { schema: 'qianshou.compute-sharing.v1', authenticated: owner !== null, scopeId: this.scopeId,
      operation: requestId === undefined || owner === null ? null : this.requireStore().operation(owner, requestId),
      hardware: this.hardware === null ? null : { name: this.hardware.gpuName, memoryMb: this.hardware.memoryMb },
      connection: this.connection(owner),
      modes: MODES.map((mode) => {
        const observation = local.get(mode); if (observation === undefined) sharingFail('STORE_INVALID')
        return { ...(owner === null ? { ...initialSharingMode(mode), reason: 'login_required' as const }
          : this.requireStore().mode(owner, mode).state), local: observation,
        api: this.apiState(owner, mode),
        authorization: owner === null ? { connection: 'required' as const, execution: 'disabled' as const, deviceBound: false }
          : this.requireStore().authorization(owner, this.currentDeviceId, mode) }
      }) }
  }
  private async refreshRuntimeHealth(): Promise<void> {
    const owner = this.currentOwner
    const work: Promise<void>[] = []
    for (const [mode, installed] of this.runtimes) {
      const running = this.runtimeHealthWork.get(mode)
      if (running !== undefined) { work.push(running); continue }
      const known = this.runtimeHealth.get(mode)
      if (known?.runtime === installed.runtime && Date.now() - known.checkedAt < 10000) continue
      const next = installed.runtime.healthy(this.controller.signal).catch(() => false).then((ready) => {
        if (this.live && this.currentOwner === owner && this.runtimes.get(mode)?.runtime === installed.runtime) {
          this.runtimeHealth.set(mode, { runtime: installed.runtime, ready, checkedAt: Date.now() })
        }
      }).finally(() => { if (this.runtimeHealthWork.get(mode) === next) this.runtimeHealthWork.delete(mode) })
      this.runtimeHealthWork.set(mode, next); work.push(next)
    }
    await Promise.all(work)
  }
  /** Persist one explicit owner action before asynchronously preparing approved supply.
   * @param mode - Image or video.
   * @param action - Enable/pause/resume.
   * @param requestId - Stable owner operation UUID.
   * @returns Redacted observation after intent commit; no fake install/completion is implied.
   */
  async command(mode: SharingMode, action: SharingAction, requestId: string, scopeId?: string,
    consent?: SharingConsent): Promise<SharingSnapshot> {
    const refreshOwner = await this.transaction(async (): Promise<string | null> => {
      const owner = await this.scope(); if (owner === null) sharingFail('LOGIN_REQUIRED')
      if (!SHARING_UUID.test(requestId)) sharingFail('REQUEST_INVALID')
      if ((action === 'enable' || action === 'resume') && consent === undefined) sharingFail('CONSENT_REQUIRED')
      if (scopeId === undefined || scopeId !== this.scopeId) sharingFail('SCOPE_CHANGED')
      const device = await this.device(owner)
      const committed = this.requireStore().authorizedCommand(owner, device, mode, action, requestId, scopeId, consent)
      if (!committed) return null
      if (mode === 'image' && (action === 'pause' || action === 'revoke')) await this.stopPilot()
      if (action === 'pause' || action === 'revoke') this.preparationControllers.get(mode)?.abort()
      else if (this.runtimes.has(mode)) this.requireStore().updateMode(owner, mode, { phase: 'connecting' })
      return owner
    })
    if (refreshOwner !== null) {
      void this.transaction(async () => this.tick()).catch(() => undefined)
      if (action === 'enable' || action === 'resume') void this.refreshIntent(refreshOwner, mode, requestId, scopeId).catch(() => undefined)
    }
    return this.snapshot(requestId)
  }
  private async refreshIntent(owner: string, mode: SharingMode, requestId: string, scopeId: string | undefined): Promise<void> {
    await Promise.all([this.probe(true), this.refreshLocal(true), this.refreshHardware(true)])
    await this.transaction(async () => {
      if (!this.live || this.currentOwner !== owner || await this.options.owner() !== owner || this.scopeId !== scopeId
        || this.requireStore().mode(owner, mode).state.operationId !== requestId || !this.authorized(owner, mode)) return
      await this.tick()
    })
  }
  /** Restore the private journal before older asynchronous GPU admissions can start.
   * @returns Completion only when no unresolved formal attempt occupies the local device.
   */
  async assertIdle(): Promise<void> {
    await this.transaction(async () => { await this.scope(); if (this.busy()) sharingFail('BUSY') })
  }
  /** Veto new provider/pilot submissions; keep the original epoch and GET/delivery draining. */
  setUpdateLocked(locked: boolean): void { this.updateLocked = locked }
  /** Read actual provider attempts and pilot journal without invoking generation. */
  async updateState(): Promise<'idle' | 'busy' | 'unknown'> {
    if (this.busy() || this.options.legacyBusy() || this.preparing.size > 0) return 'busy'
    if (this.research?.busy()) return 'busy'
    if (this.pilot !== undefined && await this.pilot.handle.updateBusy(this.controller.signal)) return 'busy'
    const discovery = this.options.localDiscovery
    const origin = this.pilot?.handle.comfyOrigin ?? this.localComfyOrigin ?? discovery?.comfyOrigin
    if (origin && (this.pilot !== undefined || this.discoveredLocal.image.inventory === 'detected')) {
      const queue = await sharingJSON(origin + '/queue', { method: 'GET',
        signal: AbortSignal.timeout(discovery?.timeoutMs ?? 2000) })
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) return 'unknown'
      if (queue.queue_running.length > 0 || queue.queue_pending.length > 0) return 'busy'
    }
    return 'idle'
  }
  /** Global unresolved occupancy is a veto for older local GPU admission paths.
   * @returns True while a formal original attempt remains unresolved.
   */
  private formalBusy(): boolean { return this.provider?.busy() ?? (this.store !== undefined && this.store.active().length !== 0) }
  busy(): boolean { return this.formalBusy() || this.research?.busy() === true }
  /** Drain preparation, original attempts and owned processes before closing the journal.
   * @returns Completion once all side effects have stopped; durable unknown attempts remain.
   */
  async close(): Promise<void> {
    this.live = false; this.presenceAuthorized = false
    clearTimeout(this.timer); this.controller.abort(); this.probeController?.abort(); this.localController?.abort()
    await Promise.allSettled([this.probeWork, this.localWork, this.hardwareWork])
    await this.serial; await this.research?.close(); await this.closeResearchRecovery()
    await Promise.allSettled(this.preparing.values()); await this.stopPresence()
    await this.stopPilot()
    await this.provider?.close()
    const processes = [...this.runtimes.values(), ...[...this.retainedRuntimes.values()].flatMap(m => [...m.values()])]
    await Promise.allSettled(processes.map(p => p.runtime.close())); this.store?.close()
  }
}
/** Mount the product's exact two-mode routes through the real Host connection carrier.
 * @param ctx - Current Cordis carrier.
 * @param coordinator - Actual supervised sharing service.
 * @returns Nothing; route effects unregister with the plugin.
 */
export function registerSharingRoutes(ctx: Context, coordinator: SharingCoordinator): void {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
  for (const action of ['status', 'enable', 'pause', 'resume', 'revoke'] as const) ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/node/sharing/' + action, methods: [action === 'status' ? 'GET' : 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        if (action === 'status') {
          const keys = [...url.searchParams.keys()]; const requestId = url.searchParams.get('request_id') ?? undefined
          if (keys.length > 1 || keys.some(k => k !== 'request_id') || requestId !== undefined && !SHARING_UUID.test(requestId)) {
            sharingFail('REQUEST_INVALID')
          }
          void coordinator.refreshConnection().catch(() => undefined)
          return Response.json(await coordinator.snapshot(requestId), { headers })
        }
        if ([...url.searchParams].length !== 0 || request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
          sharingFail('REQUEST_INVALID')
        }
        const text = await request.text(); if (Buffer.byteLength(text) > 1024) sharingFail('REQUEST_INVALID')
        const body = sharingObject(JSON.parse(text) as unknown)
        const enabling = action === 'enable' || action === 'resume'
        if (enabling && body.consent === undefined) sharingFail('CONSENT_REQUIRED')
        if (Object.keys(body).sort().join(',') !== (enabling ? 'consent,mode,requestId,scopeId' : 'mode,requestId,scopeId')
          || !MODES.includes(body.mode as SharingMode) || typeof body.requestId !== 'string' || typeof body.scopeId !== 'string'
          || !SHARING_UUID.test(body.scopeId)) sharingFail('REQUEST_INVALID')
        let consent: SharingConsent | undefined
        if (enabling) { const c = sharingObject(body.consent)
          if (Object.keys(c).sort().join(',') !== 'connection,execution,version' || c.version !== 'qianshou.media-sharing-consent.v1'
            || c.connection !== true || !['disabled', 'idle_only'].includes(String(c.execution))) sharingFail('CONSENT_REQUIRED')
          consent = { version: 'qianshou.media-sharing-consent.v1', connection: true, execution: c.execution as SharingConsent['execution'] }
        }
        return Response.json(await coordinator.command(body.mode as SharingMode, action, body.requestId, body.scopeId,
          consent), { headers })
      } catch (error) { const code = error instanceof NodeContributorError ? error.code : 'SHARING_UNAVAILABLE'
        return Response.json({ error: { code } }, { status: code.includes('LOGIN') ? 403 : code.includes('CONSENT')
          || code.includes('SCOPE_CHANGED') || code.includes('OWNER_CHANGED') ? 409 : code.includes('INVALID')
            || code.includes('CONFLICT') ? 400 : 503, headers }) }
    },
  }), 'sharing: ' + action)
}
