/** Host-private quotes and explicit paid submissions on Shanghai's official media routes. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { QianshouCoreClient } from './core-client.ts'
import { ComputeError } from './errors.ts'
import { SubmissionLedger } from './submission-ledger.ts'
import { FORMAL_MEDIA_UUID, formalMediaObject, formalMediaSpec, parseFormalMediaDirectory,
  parseFormalMediaInput, type FormalMediaProfile, type FormalMediaSpec } from './formal-media-protocol.ts'
import { inspectFormalMediaImage, inspectFormalMediaMp4 } from './video-trial-media.ts'
import { FormalMediaAssets } from './formal-media-assets.ts'

interface RequestReference { requestId: string
  sessionId: string
  accountId: number
  taskId: string | null
  expected: { capability: 'image' | 'video'; width: number; height: number; fps: number | null; secondsMs: number | null } }
interface QuoteTicket extends RequestReference {
  quoteId: string
  amountYuan: string
  expiresAt: number
  balanceEnough: boolean
  token: string
  spec: FormalMediaSpec
  profileDigest: string
}
const taskId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const sessionId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const sha = /^[a-f0-9]{64}$/u
const statuses = ['CREATED', 'WAITING_FOR_WORKERS', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED']
const phases = ['waiting', 'running', 'awaiting_settlement', 'settled', 'delivery_pending', 'failed', 'cancelled']
const now = () => new Date().toISOString()
function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/u.test(value)
}
function locator(value: unknown): { requestId: string; sessionId: string } {
  const body = formalMediaObject(value)
  if (typeof body.requestId !== 'string' || !FORMAL_MEDIA_UUID.test(body.requestId)
    || typeof body.sessionId !== 'string' || !sessionId.test(body.sessionId)) throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
  return { requestId: body.requestId, sessionId: body.sessionId }
}
function invalid(): never { throw new ComputeError('CORE_INVALID_RESPONSE', 502) }
function profileDigest(profile: FormalMediaProfile): string {
  const values = Object.fromEntries(Object.keys(profile).sort().map(key => [key, profile[key as keyof FormalMediaProfile]]))
  values.allowed_seconds = [...profile.allowed_seconds].sort((a, b) => a - b)
  values.input_roles = [...profile.input_roles].sort()
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

/** Own quote tokens in memory and byte-free owner/session request references on disk. */
export class FormalMediaControl {
  private readonly quotes = new Map<string, QuoteTicket>()
  private readonly submissions = new Map<string, { quoteId: string
    sessionId: string
    amountYuan: string
    promise: Promise<{ taskId: string; requestId: string }> }>()
  private readonly ledger: SubmissionLedger
  private closed = false
  private updateLocked = false
  private activeSubmissions = 0
  private readonly lifetime = new AbortController()
  private readonly deliveries = new Set<Promise<unknown>>()
  private readonly gatewayOrigin: URL | null
  private readonly assets: FormalMediaAssets
  constructor(private readonly client: QianshouCoreClient | null,
    private readonly path: string, private readonly limits: { maxRecords: number; maxBytes: number },
    private readonly deliveryConfig: { gatewayOrigin: string; timeoutMs: number; statusPollMs: number }) {
    this.ledger = new SubmissionLedger({ path: path + '.submissions', maxRecords: limits.maxRecords, maxBytes: limits.maxBytes })
    if (deliveryConfig.gatewayOrigin === '') this.gatewayOrigin = null
    else {
      const origin = new URL(deliveryConfig.gatewayOrigin)
      if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
        || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) {
        throw new ComputeError('COMPUTE_MEDIA_GATEWAY_CONFIG_INVALID', 503)
      }
      this.gatewayOrigin = origin
    }
    this.assets = new FormalMediaAssets(client, this.gatewayOrigin, path + '.assets', limits)
  }
  /** Pause only new confirmations/uploads; status and original delivery remain readable. */
  setUpdateLocked(locked: boolean): void { this.updateLocked = locked }
  /** Read the original durable submission ledger; no new workload or quote is sent. */
  async updateState(): Promise<'idle' | 'busy' | 'unknown'> {
    if (this.activeSubmissions > 0 || this.deliveries.size > 0) return 'busy'
    return (await this.ledger.list()).some(row => ['INTENT_RECORDED', 'SUBMITTING', 'UNKNOWN'].includes(row.status)) ? 'unknown' : 'idle'
  }
  private core(): QianshouCoreClient {
    if (this.closed) throw new ComputeError('COMPUTE_MEDIA_CLOSED', 503)
    if (this.client === null) throw new ComputeError('CORE_UNCONFIGURED', 503)
    return this.client
  }
  private async references(): Promise<RequestReference[]> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
    }
    if (Buffer.byteLength(raw) > this.limits.maxBytes) throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
    let value: unknown
    try { value = JSON.parse(raw) as unknown } catch { throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409) }
    const root = formalMediaObject(value)
    if (root.version !== 1 || !Array.isArray(root.requests) || root.requests.length > this.limits.maxRecords) throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
    const rows = root.requests.map((value) => {
      const row = formalMediaObject(value)
      const ids = locator(row)
      const expected = formalMediaObject(row.expected)
      if (Object.keys(row).sort().join(',') !== 'accountId,expected,requestId,sessionId,taskId'
        || typeof row.accountId !== 'number' || !Number.isSafeInteger(row.accountId) || row.accountId < 1
        || (row.taskId !== null && (typeof row.taskId !== 'string' || !taskId.test(row.taskId)))
        || Object.keys(expected).sort().join(',') !== 'capability,fps,height,secondsMs,width'
        || !['image', 'video'].includes(String(expected.capability))
        || ['width', 'height'].some(key => typeof expected[key] !== 'number' || !Number.isSafeInteger(expected[key])
          || expected[key] < 64 || expected[key] > 4096)
        || (expected.capability === 'image' ? expected.fps !== null || expected.secondsMs !== null
          : typeof expected.fps !== 'number' || !Number.isSafeInteger(expected.fps) || expected.fps < 1 || expected.fps > 120
            || typeof expected.secondsMs !== 'number' || !Number.isSafeInteger(expected.secondsMs) || expected.secondsMs < 1000
            || expected.secondsMs > 120000 || expected.secondsMs % 1000 !== 0)) throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
      return { ...ids, accountId: row.accountId, taskId: row.taskId, expected: expected as unknown as RequestReference['expected'] }
    })
    if (new Set(rows.map(r => `${r.accountId}:${r.requestId}`)).size !== rows.length) throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
    return rows
  }
  private async save(reference: RequestReference): Promise<void> {
    await withFileLock(this.path, async () => {
      const rows = await this.references()
      const index = rows.findIndex(r => r.accountId === reference.accountId && r.requestId === reference.requestId)
      const previous = rows[index]
      if (previous !== undefined && (previous.sessionId !== reference.sessionId
        || (previous.taskId !== null && previous.taskId !== reference.taskId)
        || JSON.stringify(previous.expected) !== JSON.stringify(reference.expected))) throw new ComputeError('COMPUTE_MEDIA_REPLAY_CONFLICT', 409)
      if (index < 0) {
        if (rows.length >= this.limits.maxRecords) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
        rows.push(reference)
      } else rows[index] = reference
      const raw = JSON.stringify({ version: 1, requests: rows })
      if (Buffer.byteLength(raw) > this.limits.maxBytes) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
      await writeFileAtomic(this.path, raw, { mode: 0o600, dirMode: 0o700 })
    })
  }
  /** Read official profiles; an unavailable billing status never authorizes a quote. */
  async directory(signal?: AbortSignal) {
    return parseFormalMediaDirectory(await this.core().mediaProfiles(signal))
  }
  /** Admit an attachment under the current actor without sending bytes to Shanghai.
   * @param value - Original Session, stable asset UUID and exact image bytes.
   * @param signal - Local request cancellation.
   * @returns Credential-free version-admitted reference.
   */
  uploadAsset(value: unknown, signal: AbortSignal) {
    if (this.updateLocked) throw new ComputeError('COMPUTE_UPDATE_IN_PROGRESS', 503)
    return this.assets.upload(value, signal)
  }
  /** Reconcile an original asset identifier through Guangzhou status only.
   * @param value - Original Session and stable asset UUID.
   * @param signal - Local request cancellation.
   * @returns Registered reference or explicit pending state, without retransmission.
   */
  assetStatus(value: unknown, signal: AbortSignal) { return this.assets.status(value, signal) }
  /** Quote without submitting; renderer receives an opaque local ticket and exact yuan string. */
  async quote(value: unknown, signal?: AbortSignal) {
    const body = formalMediaObject(value)
    const ids = locator(body)
    if (Object.keys(body).sort().join(',') !== 'input,requestId,sessionId') throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
    if (this.gatewayOrigin === null) throw new ComputeError('COMPUTE_MEDIA_DELIVERY_UNAVAILABLE', 503)
    const core = this.core()
    const accountId = (await core.getIdentity(signal)).accountId
    const previous = (await this.references()).find(r => r.accountId === accountId && r.requestId === ids.requestId)
    if (previous !== undefined) throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
    const directory = await this.directory(signal)
    const spec = formalMediaSpec(parseFormalMediaInput(body.input), directory)
    const profile = directory.profiles.find(p => p.profile_id === spec.media_input.profile_id
      && p.profile_version === spec.media_input.profile_version)
    if (profile === undefined) invalid()
    await this.assets.admit(spec.media_input.assets, accountId, ids.sessionId)
    const raw = formalMediaObject(await core.estimateMediaTask(spec, signal))
    if (raw.ok !== true || raw.currency !== 'CNY' || raw.task_type !== spec.task_type
      || raw.input_kind !== 'params_only' || raw.billing_mode !== 'server_price'
      || !decimal(raw.recommended_budget) || !/[1-9]/u.test(raw.recommended_budget)
      || raw.estimated_total !== raw.recommended_budget || typeof raw.balance_enough !== 'boolean'
      || typeof raw.quote_token !== 'string' || raw.quote_token.length < 1 || raw.quote_token.length > 8192
      || typeof raw.quote_expires_at !== 'number' || !Number.isSafeInteger(raw.quote_expires_at)
      || raw.quote_expires_at * 1000 <= Date.now() || raw.quote_expires_at * 1000 > Date.now() + 301000) invalid()
    if ((await core.getIdentity(signal)).accountId !== accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
    const ticket: QuoteTicket = { ...ids, accountId, taskId: null, quoteId: randomUUID(),
      expected: { capability: profile.capability, width: profile.width, height: profile.height, fps: profile.fps,
        secondsMs: spec.media_input.seconds === null ? null : spec.media_input.seconds * 1000 },
      amountYuan: raw.recommended_budget, balanceEnough: raw.balance_enough,
      expiresAt: raw.quote_expires_at, token: raw.quote_token, spec, profileDigest: profileDigest(profile) }
    for (const [key, old] of this.quotes) {
      if (old.expiresAt * 1000 <= Date.now() || (old.accountId === accountId && old.requestId === ids.requestId)) this.quotes.delete(key)
    }
    if (this.quotes.size >= this.limits.maxRecords) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
    this.quotes.set(ticket.quoteId, ticket)
    return { ...ids, quoteId: ticket.quoteId, amountYuan: ticket.amountYuan, currency: 'CNY',
      expiresAt: new Date(ticket.expiresAt * 1000).toISOString(), balanceEnough: ticket.balanceEnough, input: spec.media_input }
  }
  /** Consume one explicit confirmation; concurrent requests join the same sole POST. */
  async confirm(value: unknown, signal?: AbortSignal): Promise<{ taskId: string; requestId: string }> {
    if (this.updateLocked) throw new ComputeError('COMPUTE_UPDATE_IN_PROGRESS', 503)
    const body = formalMediaObject(value)
    const ids = locator(body)
    if (Object.keys(body).sort().join(',') !== 'amountYuan,quoteId,requestId,sessionId'
      || typeof body.quoteId !== 'string' || !FORMAL_MEDIA_UUID.test(body.quoteId)) throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
    if (this.gatewayOrigin === null) throw new ComputeError('COMPUTE_MEDIA_CONFIRM_NOT_STARTED', 409)
    const core = this.core()
    const accountId = (await core.getIdentity(signal)).accountId
    const key = `${accountId}:${ids.requestId}`
    const pending = this.submissions.get(key)
    if (pending !== undefined) {
      if (pending.quoteId !== body.quoteId || pending.sessionId !== ids.sessionId || pending.amountYuan !== body.amountYuan) {
        throw new ComputeError('COMPUTE_QUOTE_CONFIRMATION_INVALID', 409)
      }
      return pending.promise
    }
    const ticket = this.quotes.get(body.quoteId)
    if (ticket === undefined || ticket.accountId !== accountId || ticket.requestId !== ids.requestId
      || ticket.sessionId !== ids.sessionId || ticket.amountYuan !== body.amountYuan) throw new ComputeError('COMPUTE_QUOTE_CONFIRMATION_INVALID', 409)
    if (ticket.expiresAt * 1000 <= Date.now()) throw new ComputeError('COMPUTE_QUOTE_EXPIRED', 409)
    if (!ticket.balanceEnough) throw new ComputeError('COMPUTE_QUOTE_BALANCE_INSUFFICIENT', 409)
    this.quotes.delete(ticket.quoteId)
    let reserved = false
    let activeReservation = false
    const operation = Promise.resolve().then(async () => {
      // Recheck directory admission before freezing the immutable quoted request.
      const directory = await this.directory(signal)
      formalMediaSpec(ticket.spec.media_input, directory)
      const profile = directory.profiles.find(p => p.profile_id === ticket.spec.media_input.profile_id
        && p.profile_version === ticket.spec.media_input.profile_version)
      if (profile === undefined || profileDigest(profile) !== ticket.profileDigest) throw new ComputeError('COMPUTE_MEDIA_PROFILE_CHANGED', 409)
      if ((await core.getIdentity(signal)).accountId !== accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
      if (this.updateLocked) throw new ComputeError('COMPUTE_UPDATE_IN_PROGRESS', 503)
      const request = { name: ticket.spec.media_input.prompt.slice(0, 80), spec: ticket.spec,
        budget: ticket.amountYuan, quote_token: ticket.token, request_id: ids.requestId }
      const ledgerKey = createHash('sha256').update(`formal-media:${accountId}:${ids.requestId}`).digest('hex')
      this.activeSubmissions++; activeReservation = true
      const intent = await this.ledger.recordIntentWithKey({ accountId: String(accountId), taskId: ids.requestId,
        attempt: 1, request: { spec: ticket.spec, budget: ticket.amountYuan } }, ledgerKey, now())
      reserved = true
      if (!intent.inserted) throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
      await this.save({ ...ids, accountId, taskId: null, expected: ticket.expected })
      await this.ledger.transition(ledgerKey, { type: 'submitting' }, now())
      try {
        const raw = formalMediaObject(await core.submitMediaTask(request, signal))
        if (typeof raw.id !== 'string' || !taskId.test(raw.id) || !statuses.includes(String(raw.status))) invalid()
        if ((await core.getIdentity(signal)).accountId !== accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
        await this.save({ ...ids, accountId, taskId: raw.id, expected: ticket.expected })
        await this.ledger.reconcile(ledgerKey, { observed: 'workload-present', evidence: raw.id }, now())
        return { taskId: raw.id, requestId: ids.requestId }
      } catch {
        await this.ledger.transition(ledgerKey, { type: 'unknown' }, now()).catch(() => undefined)
        throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
      }
    }).catch((failure: unknown) => {
      if (reserved) throw failure
      this.submissions.delete(key)
      throw new ComputeError('COMPUTE_MEDIA_CONFIRM_NOT_STARTED', 409)
    })
    const tracked = operation.finally(() => { if (activeReservation) this.activeSubmissions-- })
    this.submissions.set(key, { quoteId: ticket.quoteId, sessionId: ticket.sessionId, amountYuan: ticket.amountYuan, promise: tracked })
    return tracked
  }
  /** Query only the recorded request in its original owner and Session; no submission retry. */
  async state(value: unknown, signal?: AbortSignal) {
    const ids = locator(value)
    const core = this.core()
    const accountId = (await core.getIdentity(signal)).accountId
    const reference = (await this.references()).find(r => r.accountId === accountId
      && r.requestId === ids.requestId && r.sessionId === ids.sessionId)
    if (reference === undefined) throw new ComputeError('COMPUTE_MEDIA_NOT_FOUND', 404)
    const raw = formalMediaObject(await core.readMediaTask(reference.taskId === null
      ? { requestId: reference.requestId } : { taskId: reference.taskId }, signal))
    if (raw.ok !== true || typeof raw.taskId !== 'string' || !taskId.test(raw.taskId)
      || (reference.taskId !== null && raw.taskId !== reference.taskId) || raw.requestId !== reference.requestId
      || !statuses.includes(String(raw.status)) || !phases.includes(String(raw.phase))
      || (raw.progress !== null && (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress) || raw.progress < 0 || raw.progress > 1))
      || typeof raw.elapsedSeconds !== 'number' || !Number.isSafeInteger(raw.elapsedSeconds) || raw.elapsedSeconds < 0
      || (raw.attemptId !== null && (typeof raw.attemptId !== 'string' || !taskId.test(raw.attemptId)))
      || (raw.leaseEpoch !== null && (typeof raw.leaseEpoch !== 'number' || !Number.isSafeInteger(raw.leaseEpoch) || raw.leaseEpoch < 1))) invalid()
    if ((await core.getIdentity(signal)).accountId !== accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
    if (reference.taskId === null) await this.save({ ...reference, taskId: raw.taskId })
    let resultMetadata: Record<string, unknown> | null = null
    if (raw.resultMetadata !== null) {
      const result = formalMediaObject(raw.resultMetadata)
      if (result.capability !== reference.expected.capability || result.width !== reference.expected.width
        || result.height !== reference.expected.height || result.secondsMs !== reference.expected.secondsMs
        || (reference.expected.fps !== null && (typeof result.fpsDen !== 'number'
          || result.fpsNum !== reference.expected.fps * result.fpsDen))) invalid()
      if (typeof result.assetId !== 'string' || !opaqueId.test(result.assetId) || typeof result.sha256 !== 'string' || !sha.test(result.sha256)
        || (result.capability === 'image' ? !['image/png', 'image/jpeg'].includes(String(result.contentType)) : result.contentType !== 'video/mp4')
        || typeof result.sizeBytes !== 'number' || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes < 1 || result.sizeBytes > 64 * 1024 * 1024
        || ['width', 'height'].some(k => typeof result[k] !== 'number' || !Number.isSafeInteger(result[k]) || (result[k]) < 1 || (result[k]) > 4096)
        || typeof result.resultRevision !== 'string' || !sha.test(result.resultRevision)
        || (result.capability === 'image' ? result.fpsNum !== null || result.fpsDen !== null || result.secondsMs !== null
          : ['fpsNum', 'fpsDen', 'secondsMs'].some(k => typeof result[k] !== 'number' || !Number.isSafeInteger(result[k]) || (result[k]) < 1 || (result[k]) > 120000))) invalid()
      resultMetadata = { assetId: result.assetId, sha256: result.sha256, capability: result.capability,
        sizeBytes: result.sizeBytes, contentType: result.contentType, width: result.width, height: result.height,
        resultRevision: result.resultRevision, fpsNum: result.fpsNum, fpsDen: result.fpsDen, secondsMs: result.secondsMs }
    }
    let settlement: { settled: true; billableResultRevision: string; ledgerReceiptId: string } | null = null
    if (raw.settlement !== null) {
      const settled = formalMediaObject(raw.settlement)
      if (settled.settled !== true || settled.billableResultRevision !== resultMetadata?.resultRevision
        || typeof settled.ledgerReceiptId !== 'string' || !opaqueId.test(settled.ledgerReceiptId)) invalid()
      settlement = { settled: true, billableResultRevision: settled.billableResultRevision as string,
        ledgerReceiptId: settled.ledgerReceiptId }
    }
    return { ...ids, taskId: raw.taskId, attemptId: raw.attemptId, leaseEpoch: raw.leaseEpoch,
      status: raw.status as string, phase: raw.phase as string, progress: raw.progress,
      elapsedSeconds: raw.elapsedSeconds, resultMetadata, settlement,
      pollIntervalMs: this.deliveryConfig.statusPollMs,
      deliveryAvailable: raw.status === 'DONE' && this.gatewayOrigin !== null && settlement !== null
        && resultMetadata !== null && typeof raw.viewerReceipt === 'string' }
  }
  /** Read the already settled result from Guangzhou; this operation never generates or settles again. */
  media(value: unknown, signal: AbortSignal): Promise<{ bytes: Buffer; contentType: string; sha256: string }> {
    const operation = this.deliver(value, AbortSignal.any([signal, this.lifetime.signal]))
    this.deliveries.add(operation)
    void operation.finally(() => { this.deliveries.delete(operation) }).catch(() => undefined)
    return operation
  }
  private async deliver(value: unknown, signal: AbortSignal): Promise<{ bytes: Buffer; contentType: string; sha256: string }> {
    const state = await this.state(value, signal)
    if (!state.deliveryAvailable || state.resultMetadata === null || this.gatewayOrigin === null) throw new ComputeError('COMPUTE_MEDIA_DELIVERY_UNAVAILABLE', 503)
    const core = this.core()
    const accountId = (await core.getIdentity(signal)).accountId
    const raw = formalMediaObject(await core.readMediaTask({ taskId: state.taskId }, signal))
    const freshResult = formalMediaObject(raw.resultMetadata)
    const freshSettlement = formalMediaObject(raw.settlement)
    if (raw.status !== 'DONE' || freshSettlement.settled !== true
      || freshSettlement.billableResultRevision !== state.resultMetadata.resultRevision
      || ['assetId', 'sha256', 'sizeBytes', 'contentType', 'resultRevision'].some(key => freshResult[key] !== state.resultMetadata?.[key])) invalid()
    const token = raw.viewerReceipt
    if (raw.taskId !== state.taskId || raw.requestId !== state.requestId || typeof token !== 'string'
      || token.length < 1 || token.length > 16384 || !/^[A-Za-z0-9_-]+$/u.test(token)) invalid()
    let grant: Record<string, unknown>
    try { grant = formalMediaObject(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown) }
    catch { return invalid() }
    const payload = formalMediaObject(grant.payload)
    const result = state.resultMetadata
    if (Object.keys(grant).sort().join(',') !== 'key_id,payload,signature'
      || typeof grant.key_id !== 'string' || typeof grant.signature !== 'string'
      || payload.schema !== 'qianshou.media-view-grant.v1' || payload.audience !== 'guangzhou-result-media'
      || payload.account_id !== accountId || payload.task_id !== state.taskId || payload.asset_id !== result.assetId
      || payload.sha256 !== result.sha256 || payload.size_bytes !== result.sizeBytes || payload.content_type !== result.contentType
      || payload.result_finalized !== true || payload.media_attested !== true
      || typeof payload.issued_at !== 'number' || !Number.isSafeInteger(payload.issued_at)
      || typeof payload.expires_at !== 'number' || !Number.isSafeInteger(payload.expires_at)
      || payload.expires_at * 1000 <= Date.now() || payload.issued_at * 1000 > Date.now() + 5000
      || payload.expires_at <= payload.issued_at || payload.expires_at - payload.issued_at > 60) invalid()
    const url = new URL('/media/result', this.gatewayOrigin)
    url.searchParams.set('task_id', state.taskId); url.searchParams.set('asset_id', String(result.assetId))
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.deliveryConfig.timeoutMs)])
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: String(result.contentType) },
      redirect: 'error', signal: bounded })
    if (!response.ok || response.status !== 200 || response.headers.get('content-type')?.split(';')[0]?.trim() !== result.contentType) throw new ComputeError('COMPUTE_MEDIA_DELIVERY_INVALID', 502)
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== result.sizeBytes)) throw new ComputeError('COMPUTE_MEDIA_DELIVERY_INVALID', 502)
    const reader = response.body?.getReader()
    if (reader === undefined) throw new ComputeError('COMPUTE_MEDIA_DELIVERY_INVALID', 502)
    const chunks: Buffer[] = []; let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > (result.sizeBytes as number)) throw new ComputeError('COMPUTE_MEDIA_DELIVERY_INVALID', 502)
        chunks.push(Buffer.from(part.value))
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    const bytes = Buffer.concat(chunks, size)
    if (size !== result.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw new ComputeError('COMPUTE_MEDIA_DELIVERY_INVALID', 502)
    const video = result.contentType === 'video/mp4' ? inspectFormalMediaMp4(bytes) : null
    const inspected = video ?? inspectFormalMediaImage(bytes, result.contentType as 'image/png' | 'image/jpeg')
    if (inspected.width !== result.width || inspected.height !== result.height) {
      throw new ComputeError('COMPUTE_MEDIA_DELIVERY_INVALID', 502)
    }
    if (video !== null) {
      if (Math.abs(video.durationSeconds * 1000 - (result.secondsMs as number)) > 100
        || video.frameCount * 1000 * (result.fpsDen as number) !== (result.fpsNum as number) * (result.secondsMs as number)) {
        throw new ComputeError('COMPUTE_MEDIA_DELIVERY_INVALID', 502)
      }
    }
    if ((await core.getIdentity(signal)).accountId !== accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
    return { bytes, contentType: result.contentType as string, sha256: result.sha256 }
  }
  /** Revoke unused tickets and await already confirmed submissions when the plugin closes. */
  async close(): Promise<void> {
    this.closed = true; this.quotes.clear()
    this.lifetime.abort()
    await this.assets.close()
    await Promise.allSettled([...this.submissions.values()].map(row => row.promise))
    await Promise.allSettled(this.deliveries)
    await this.ledger.close()
  }
}
