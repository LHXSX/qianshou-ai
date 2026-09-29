/** Durable formal-media execution: one runtime POST, exact media tickets, original-result recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { MediaNodeCapability, MediaNodeDelivery } from './media-node-channel.ts'
import type { SharingAttempt, SharingManifest, SharingNodeSession } from './sharing-types.ts'
import { SHARING_HASH, sharingCanonical, sharingCurrentOrder, sharingDigest, sharingFail, sharingObject, sharingTask,
  sharingVerify } from './sharing-protocol.ts'
import { sharingDirectory, sharingWrite, SharingStore } from './sharing-store.ts'
import { sharingFileHash, sharingResponseBytes, sharingJSON, SharingRuntime } from './sharing-runtime.ts'

/** Provider trust is configured only in Host deployment, never by a delivered task. */
export interface SharingProviderOptions {
  readonly store: SharingStore
  readonly directory: string
  readonly origin: string
  readonly authorizationKeyId: string
  readonly authorizationPublicKey: string
  readonly orderKeyId: string
  readonly orderPublicKey: string
  readonly guangzhouKeyId: string
  readonly guangzhouPublicKey: string
  readonly uploadKeyId: string
  readonly uploadPublicKey: string
  readonly owner: () => Promise<string | null>
  readonly admission: <T>(operation: () => Promise<T>) => Promise<T>
  readonly occupancyChanged: () => void
  readonly enabled: (mode: 'image' | 'video') => boolean
  /** Fresh measured permission immediately before admission and consuming a runtime POST right. */
  readonly beforeSubmit?: (mode: 'image' | 'video') => Promise<boolean>
}
/** The actual executor persists immutable admissions before returning the inbox acknowledgement. */
export class SharingProvider {
  private readonly packages = new Map<string, { manifest: SharingManifest; runtime: SharingRuntime }>()
  private readonly attemptPackages = new Map<string, { manifest: SharingManifest; runtime: SharingRuntime }>()
  private readonly running = new Map<string, Promise<void>>()
  private session: SharingNodeSession | undefined
  private readonly controller = new AbortController()
  constructor(private readonly options: SharingProviderOptions) {}
  /** Bind only a fully installed runtime plus current independent qualification.
   * @param manifest - Approved package reference.
   * @param runtime - Hash-verified authenticated process.
   * @returns Nothing; discovered or trial adapters do not enter this map.
   */
  bind(manifest: SharingManifest, runtime: SharingRuntime): void { this.packages.set(manifest.mode, { manifest, runtime }) }
  /** Attach only immutable already-submitted original attempts; no advertised/new-admission binding is created.
   * @param manifest - Reverified stored official receipt.
   * @param runtime - GET-only adopted original process.
   * @param owner - Exact current original owner.
   * @returns Nothing; other owners, modes and plans cannot use this reference.
   */
  bindOriginal(manifest: SharingManifest, runtime: SharingRuntime, owner: string): void {
    if (!runtime.recoveryOnly) sharingFail('RUNTIME_UNAVAILABLE')
    for (const a of this.options.store.active(owner)) {
      const plan = sharingObject(a.task.envelope.plan)
      if (a.mode === manifest.mode && ['submitting', 'running', 'unknown'].includes(a.state)
        && manifest.profiles.some(cap => Object.keys(cap).every(key => Reflect.get(cap, key) === plan[key]))) {
        this.attemptPackages.set(a.task.attemptId, { manifest, runtime })
      }
    }
  }
  /** Withdraw new intake for a mode while preserving unresolved attempts.
   * @param mode - Product mode.
   * @returns Nothing; no old attempt is reclassified as cancelled.
   */
  unbind(mode: 'image' | 'video'): void { this.packages.delete(mode) }
  /** Read exact installed and qualified references for Guangzhou registration.
   * @returns Combined deduplicated capabilities, without price claims.
   */
  capabilities(): readonly MediaNodeCapability[] {
    return [...new Map([...this.packages.values()].flatMap(p => p.manifest.profiles).map(c => [c.profile_id + ':' + String(
      c.profile_version), c])).values()]
  }
  /** Observe actual global slot occupancy; unresolved old accounts still hold it.
   * @returns True while any original attempt lacks trusted terminal settlement.
   */
  busy(): boolean { return this.options.store.active().length !== 0 }
  /** Persist original delivery, validating both price authorization and full current spec.
   * @param task - Original Guangzhou inbox item.
   * @param signal - Short admission lifecycle cancellation.
   * @param session - Device-purpose operation capability owned by the channel.
   * @returns Completion only after durable admission; execution runs under the Host lifecycle.
   */
  async onTask(task: MediaNodeDelivery, signal: AbortSignal, session: SharingNodeSession): Promise<void> {
    const owner = await this.options.owner(); if (owner === null) sharingFail('OWNER_CHANGED')
    const prior = this.options.store.attempt(owner, task.taskId)
    if (prior !== null) {
      const identity = (v: MediaNodeDelivery) => { const { expired: _expired, sequence: _sequence, ...rest } = v; return rest }
      if (sharingDigest(identity(prior.task)) !== sharingDigest(identity(task))) sharingFail('ATTEMPT_CONFLICT')
      this.session = session; this.schedule(prior); return
    }
    const facts = { owner, deviceId: session.deviceId, keyId: this.options.authorizationKeyId,
      publicKey: this.options.authorizationPublicKey, capabilities: this.capabilities() }
    const checked = sharingTask(task, facts)
    if (!this.options.enabled(checked.mode) || !this.packages.has(checked.mode)) sharingFail('PAUSED')
    const reply = await session.post('media/order-current', { taskId: task.taskId, attemptId: task.attemptId,
      leaseEpoch: task.leaseEpoch }, signal)
    sharingCurrentOrder(reply.order, task, { owner, deviceId: session.deviceId, keyId: this.options.orderKeyId,
      publicKey: this.options.orderPublicKey })
    const assetId = randomUUID(); const extension = checked.mode === 'video' ? 'mp4' : 'png'
    const record = await this.options.admission(async () => {
      if (await this.options.beforeSubmit?.(checked.mode) === false || await this.options.owner() !== owner || !this.options.enabled(checked.mode)) sharingFail('OWNER_CHANGED')
      return this.options.store.admit({ task, owner, mode: checked.mode, state: 'admitted', assetId,
        outputPath: join(this.options.directory, task.attemptId, 'result', assetId, 'result.' + extension),
        eventSequence: 0, result: null })
    })
    const installed = this.packages.get(checked.mode)
    if (installed !== undefined) this.attemptPackages.set(record.task.attemptId, installed)
    this.options.occupancyChanged(); this.options.store.event(record, 'accepted'); this.session = session; this.schedule(record)
  }
  /** Reattach the current session to unresolved original jobs; no runtime POST rights are recreated.
   * @param session - Current authenticated private channel.
   * @returns Nothing; background recovery proceeds only for the current owner.
   */
  recover(session: SharingNodeSession): void { this.session = session; for (const a of this.options.store.active()) this.schedule(a) }
  private schedule(a: SharingAttempt): void {
    if (this.running.has(a.task.attemptId)) return
    if (!this.attemptPackages.has(a.task.attemptId)) {
      const installed = this.packages.get(a.mode); const plan = sharingObject(a.task.envelope.plan)
      if (installed?.manifest.profiles.some(cap => Object.keys(cap).every(key => Reflect.get(cap, key) === plan[key]))) {
        this.attemptPackages.set(a.task.attemptId, installed)
      }
    }
    const work = this.execute(a).catch(() => undefined).finally(() => this.running.delete(a.task.attemptId))
    this.running.set(a.task.attemptId, work)
  }
  private async order(a: SharingAttempt, session: SharingNodeSession, signal: AbortSignal): Promise<void> {
    if (await this.options.owner() !== a.owner) sharingFail('OWNER_CHANGED')
    const r = await session.post('media/order-current', { taskId: a.task.taskId, attemptId: a.task.attemptId,
      leaseEpoch: a.task.leaseEpoch }, signal)
    sharingCurrentOrder(r.order, a.task, { owner: a.owner, deviceId: session.deviceId, keyId: this.options.orderKeyId,
      publicKey: this.options.orderPublicKey })
  }
  private async events(a: SharingAttempt, session: SharingNodeSession, signal: AbortSignal): Promise<void> {
    for (const event of this.options.store.events(a.task.attemptId)) {
      const reply = await session.post('events', event, signal)
      if (reply.ok !== true || reply.eventSequence !== event.sequence && reply.sequence !== event.sequence) sharingFail('EVENT_UNCONFIRMED')
      this.options.store.ack(a.task.attemptId, Number(event.sequence))
    }
  }
  private async assets(a: SharingAttempt, session: SharingNodeSession, signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const media = sharingObject(sharingObject(a.task.envelope.spec).media_input); const assets = media.assets as unknown[]
    const values: Record<string, unknown>[] = []
    for (const raw of assets) {
      const asset = sharingObject(raw)
      const reply = await session.post('media/input-ticket', { taskId: a.task.taskId, attemptId: a.task.attemptId,
        leaseEpoch: a.task.leaseEpoch, assetId: asset.asset_id, sha256: asset.sha256 }, signal)
      const declaration = sharingObject(reply.asset)
      const size = Number(declaration.size_bytes); const mime = String(declaration.content_type)
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[mime]
      if (reply.ok !== true || typeof reply.ticket !== 'string' || reply.ticket.length > 32768
        || reply.read_path !== '/v1/media/assets/read'
        || declaration.assetId !== asset.asset_id || declaration.sha256 !== asset.sha256 || !Number.isSafeInteger(size)
          || size < 1 || size > 16 * 1024 * 1024 || ext === undefined) sharingFail('ASSET_INVALID')
      const path = join(this.options.directory, a.task.attemptId, 'assets', String(asset.asset_id) + '.' + ext)
      await sharingDirectory(join(this.options.directory, a.task.attemptId, 'assets'))
      const exists = await lstat(path).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e })
      if (exists === null) {
        const response = await fetch(this.options.origin + '/v1/media/assets/read', { method: 'POST', redirect: 'error', signal,
          headers: { Authorization: 'Bearer ' + reply.ticket } })
        if (!response.ok || Number(response.headers.get('content-length')) !== size || response.headers.get('content-type') !== mime
          || response.headers.get('x-content-sha256') !== asset.sha256) { await response.body?.cancel(); sharingFail('ASSET_INVALID') }
        const bytes = await sharingResponseBytes(response, size)
        if (bytes.length !== size || sharingDigestBytes(bytes) !== asset.sha256) sharingFail('ASSET_INVALID')
        await sharingWrite(path, bytes)
      }
      if (await sharingFileHash(path, size) !== asset.sha256) sharingFail('ASSET_INVALID')
      values.push({ assetId: asset.asset_id, role: asset.role, sha256: asset.sha256, path })
    }
    return values
  }
  private async result(a: SharingAttempt, job: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>> {
    if (job.schema !== 'qianshou.media-runtime-job.v1' || job.taskId !== a.task.taskId || job.attemptId !== a.task.attemptId
      || job.leaseEpoch !== a.task.leaseEpoch || job.assetId !== a.assetId) sharingFail('RUNTIME_RESULT_INVALID')
    const output = sharingObject(job.result); const size = Number(output.size_bytes)
    const mime = a.mode === 'video' ? 'video/mp4' : 'image/png'
    if (Object.keys(output).sort().join(',') !== 'content_type,path,sha256,size_bytes' || output.path !== a.outputPath
      || output.content_type !== mime || !Number.isSafeInteger(size) || size < 1 || size > 64 * 1024 * 1024
      || typeof output.sha256 !== 'string' || !SHARING_HASH.test(output.sha256)
      || await sharingFileHash(a.outputPath, size) !== output.sha256) sharingFail('RUNTIME_RESULT_INVALID')
    return { sha256: output.sha256, size_bytes: size, content_type: mime }
  }
  private async output(a: SharingAttempt, session: SharingNodeSession, signal: AbortSignal): Promise<void> {
    if (a.result === null) sharingFail('RESULT_INVALID')
    const result = a.result
    const tuple = { taskId: a.task.taskId, attemptId: a.task.attemptId, leaseEpoch: a.task.leaseEpoch, assetId: a.assetId }
    let response: Record<string, unknown>
    if (a.state === 'generated') {
      await this.order(a, session, signal)
      const issued = await session.post('media/result-ticket', { ...tuple, ...a.result }, signal)
      if (issued.ok !== true || issued.assetId !== a.assetId
        || issued.upload_path !== '/v1/media/results/upload') sharingFail('RESULT_INVALID')
      const ticket = sharingObject(issued.ticket); const payload = sharingVerify(ticket, { keyId: this.options.uploadKeyId,
        publicKey: this.options.uploadPublicKey,
        schema: 'qianshou.formal-media-result-upload.v1', purpose: 'qianshou:formal-media-result-upload', ttl: 300 })
      const suffix = a.mode === 'video' ? 'mp4' : 'png'
      if (payload.taskId !== a.task.taskId || payload.attemptId !== a.task.attemptId || payload.leaseEpoch !== a.task.leaseEpoch
        || payload.deviceId !== session.deviceId || payload.accountId !== a.task.envelope.accountId || payload.assetId !== a.assetId
        || payload.sha256 !== a.result.sha256 || payload.size_bytes !== a.result.size_bytes
          || payload.content_type !== a.result.content_type
        || payload.object_key !== `v8/account-${String(payload.accountId)}/workload-${a.task.taskId}/shard-${
          a.task.attemptId}/result/${a.assetId}/result.${suffix}`) sharingFail('RESULT_INVALID')
      const file = await open(a.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes: Buffer
      try { if (await sharingFileHash(a.outputPath, Number(a.result.size_bytes)) !== a.result.sha256) sharingFail(
        'RESULT_INVALID'); bytes = await file.readFile() }
      finally { await file.close() }
      if (!this.options.store.claimUpload(a)) return
      const claimed = this.options.store.attempt(a.owner, a.task.taskId); if (claimed === null) sharingFail('RESULT_INVALID')
      a = claimed; this.options.store.event(a, 'uploading')
      // An unknown PUT permanently loses the write right. Only the original status is consulted below.
      response = await sharingJSON(this.options.origin + '/v1/media/results/upload', { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: 'Bearer ' + sharingCanonical(ticket).toString('base64url'), 'Content-Type': String(
          result.content_type) }, body: new Uint8Array(bytes) }, 65536)
    } else response = { ...await session.post('media/result-status', tuple, signal) }
    if (response.status === 'verified' && response.ok === true) {
      const artifact = sharingObject(response.artifact)
      this.verdict(response.verdict, a, session, artifact)
      if (artifact.sha256 !== result.sha256 || artifact.size_bytes !== result.size_bytes || artifact.content_type !== result.content_type
        || typeof artifact.object_version_id !== 'string' || !artifact.object_version_id) sharingFail('RESULT_INVALID')
      this.options.store.transition(a, 'awaiting_settlement')
      this.options.store.event(a, 'awaiting_settlement', { assetId: a.assetId, artifact })
    }
  }
  private verdict(signed: unknown, a: SharingAttempt, session: SharingNodeSession, artifact?: Record<string,
    unknown>): Record<string, unknown> {
    const p = sharingVerify(signed, { keyId: this.options.guangzhouKeyId, publicKey: this.options.guangzhouPublicKey,
      schema: 'qianshou.formal-media-result.v1', purpose: 'qianshou:formal-media-result', ttl: 300, storedReceipt: true })
    const file = sharingObject(p.file)
    if (p.taskId !== a.task.taskId || p.attemptId !== a.task.attemptId || p.deviceId !== session.deviceId
      || p.leaseEpoch !== a.task.leaseEpoch
      || p.ownerId !== String(a.task.envelope.accountId) || p.assetId !== a.assetId || p.plan_sha256 !== a.task.envelope.plan_sha256
      || p.status !== 'verified' || typeof p.resultRevision !== 'string' || !SHARING_HASH.test(p.resultRevision)
      || p.resultRevision !== p.billableResultRevision || a.result === null || file.sha256 !== a.result.sha256
        || file.size_bytes !== a.result.size_bytes
      || file.content_type !== a.result.content_type || artifact !== undefined && Object.keys(artifact).some(
      k => artifact[k] !== file[k])) sharingFail('RESULT_INVALID')
    return p
  }
  private async execute(original: SharingAttempt): Promise<void> {
    const signal = this.controller.signal
    while (!signal.aborted) {
      try {
        const session = this.session; const a = this.options.store.attempt(original.owner, original.task.taskId)
        if (session === undefined || a === null || await this.options.owner() !== a.owner) return
        if (['settled', 'rejected'].includes(a.state)) return
        await this.events(a, session, signal)
        const status = await session.post('media/task-status', { taskId: a.task.taskId, attemptId: a.task.attemptId,
          leaseEpoch: a.task.leaseEpoch }, signal)
        const remote = sharingObject(status.task)
        if (remote.taskId !== a.task.taskId || remote.attemptId !== a.task.attemptId
          || remote.leaseEpoch !== a.task.leaseEpoch) sharingFail('RESULT_INVALID')
        if (remote.stage === 'completed' && remote.settlement !== null && remote.settlement !== undefined
          && a.state === 'awaiting_settlement') {
          const receipt = sharingObject(remote.settlement)
          const verdict = this.verdict(remote.verdict, a, session)
          if (receipt.taskId !== a.task.taskId || receipt.attemptId !== a.task.attemptId || receipt.leaseEpoch !== a.task.leaseEpoch
            || receipt.settled !== true || receipt.resultRevision !== verdict.resultRevision
              || receipt.billableResultRevision !== verdict.resultRevision) sharingFail('RESULT_INVALID')
          this.options.store.transition(a, 'settled'); this.attemptPackages.delete(a.task.attemptId)
          this.options.occupancyChanged(); return
        }
        const bound = this.attemptPackages.get(a.task.attemptId)
        if (a.state === 'generated' || a.state === 'uploading') await this.output(a, session, signal)
        else if (a.state !== 'awaiting_settlement' && bound !== undefined) {
          let job: Record<string, unknown>
          if (a.state === 'admitted') {
            if (!this.options.enabled(a.mode)) sharingFail('PAUSED')
            await this.order(a, session, signal); const assets = await this.assets(a, session, signal)
            await this.order(a, session, signal); await sharingDirectory(join(this.options.directory, a.task.attemptId,
              'result', a.assetId))
            if (await this.options.beforeSubmit?.(a.mode) === false || !this.options.enabled(a.mode)) sharingFail('PAUSED')
            if (!this.options.store.claimSubmission(a)) continue
            try {
              job = await bound.runtime.request('POST', '/v1/media/jobs', { schema: 'qianshou.media-runtime-submit.v1',
                idempotencyKey: a.task.attemptId,
                taskId: a.task.taskId, attemptId: a.task.attemptId, leaseEpoch: a.task.leaseEpoch, assetId: a.assetId,
                leaseExpiresAt: a.task.leaseExpiresAt, deviceId: session.deviceId, accountId: a.task.envelope.accountId,
                plan_sha256: a.task.envelope.plan_sha256, plan: a.task.envelope.plan, spec: a.task.envelope.spec,
                outputPath: a.outputPath, assets }, signal)
              this.options.store.transition(a, 'running'); this.options.store.event(a, 'running')
            } catch { this.options.store.transition(a, 'unknown'); this.options.store.event(a, 'outcome_unknown')
              throw new Error('original runtime outcome unknown') }
          } else job = await bound.runtime.request('GET', '/v1/media/jobs/' + a.task.attemptId, null, signal)
          if (job.taskId !== a.task.taskId || job.attemptId !== a.task.attemptId || job.leaseEpoch !== a.task.leaseEpoch
            || job.assetId !== a.assetId) sharingFail('RUNTIME_RESULT_INVALID')
          if (job.status === 'succeeded') this.options.store.transition(a, 'generated', await this.result(a, job))
          // failed/not_found/unknown are retained: a local report is neither a refund nor permission to regenerate.
        }
      } catch { /* Only fixed original operations are retried; immutable submit/upload rights remain consumed. */ }
      await new Promise<void>((resolve) => { const done = (): void => { clearTimeout(timer); signal.removeEventListener(
        'abort', done); resolve() }
      const timer = setTimeout(done, 1000); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done() })
    }
  }
  /** Stop and drain recovery before SQLite/runtime handles are closed.
   * @returns Completion with original unknown operations retained.
   */
  async close(): Promise<void> { this.controller.abort(); await Promise.allSettled(this.running.values()) }
}
function sharingDigestBytes(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
