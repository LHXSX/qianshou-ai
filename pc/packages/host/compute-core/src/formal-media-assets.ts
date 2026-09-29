/** Actor-scoped Guangzhou image uploads with durable identifiers and no automatic retransmission. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { QianshouCoreClient } from './core-client.ts'
import { ComputeError } from './errors.ts'
import { FORMAL_MEDIA_UUID, formalMediaObject } from './formal-media-protocol.ts'
import { inspectFormalMediaImage } from './video-trial-media.ts'

const MAX_BYTES = 16777216
const sha = /^[a-f0-9]{64}$/u
// Guangzhou derives upload nonces as UUIDv5; buyer asset/request identifiers remain UUIDv4.
const nonceUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const session = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
type Role = 'reference' | 'first_frame' | 'last_frame'
type Mime = 'image/png' | 'image/jpeg'
interface AssetIntent {
  accountId: number
  sessionId: string
  assetId: string
  role: Role
  sha256: string
  sizeBytes: number
  contentType: Mime
  status: 'uncertain' | 'registered'
}
function invalid(): never { throw new ComputeError('COMPUTE_MEDIA_ASSET_INVALID', 400) }
function locator(value: unknown) {
  const row = formalMediaObject(value)
  if (typeof row.assetId !== 'string' || !FORMAL_MEDIA_UUID.test(row.assetId)
    || typeof row.sessionId !== 'string' || !session.test(row.sessionId)) invalid()
  return { assetId: row.assetId, sessionId: row.sessionId }
}
function publicAsset(intent: AssetIntent) {
  return { assetId: intent.assetId, status: intent.status,
    asset: intent.status === 'registered' ? { asset_id: intent.assetId, sha256: intent.sha256, role: intent.role } : null }
}

/** Persist only upload identity, owner and digest; an unknown POST is reconciled through status only. */
export class FormalMediaAssets {
  private readonly pending = new Map<string, { intent: AssetIntent; promise: Promise<ReturnType<typeof publicAsset>> }>()
  private readonly lifetime = new AbortController()
  private closed = false
  constructor(private readonly client: QianshouCoreClient | null, private readonly origin: URL | null,
    private readonly path: string, private readonly limits: { maxRecords: number; maxBytes: number }) {}
  private core() {
    if (this.closed) throw new ComputeError('COMPUTE_MEDIA_CLOSED', 503)
    if (this.client === null) throw new ComputeError('CORE_UNCONFIGURED', 503)
    if (this.origin === null) throw new ComputeError('COMPUTE_MEDIA_ASSET_UNAVAILABLE', 503)
    return this.client
  }
  private gateway(): URL {
    if (this.origin === null) throw new ComputeError('COMPUTE_MEDIA_ASSET_UNAVAILABLE', 503)
    return this.origin
  }
  /** Require registered references owned by the original actor and Session before quoting.
   * @param assets - Exact references sent in media_input.
   * @param accountId - Current authenticated actor.
   * @param sessionId - Original local conversation.
   */
  async admit(assets: readonly { asset_id: string; sha256: string; role: string }[], accountId: number, sessionId: string): Promise<void> {
    if (assets.length === 0) return
    const rows = await this.rows()
    if (assets.some(asset => !rows.some(row => row.assetId === asset.asset_id && row.accountId === accountId
      && row.sessionId === sessionId && row.status === 'registered' && row.sha256 === asset.sha256 && row.role === asset.role))) {
      throw new ComputeError('COMPUTE_MEDIA_ASSET_NOT_REGISTERED', 409)
    }
  }
  private async rows(): Promise<AssetIntent[]> {
    let text: string
    try { text = await readFile(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
    }
    if (Buffer.byteLength(text) > this.limits.maxBytes) throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
    let parsed: unknown
    try { parsed = JSON.parse(text) as unknown } catch { throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409) }
    const root = formalMediaObject(parsed)
    if (root.version !== 1 || !Array.isArray(root.assets) || root.assets.length > this.limits.maxRecords) throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
    const rows = root.assets.map((value) => {
      const row = formalMediaObject(value)
      locator(row)
      if (Object.keys(row).sort().join(',') !== 'accountId,assetId,contentType,role,sessionId,sha256,sizeBytes,status'
        || typeof row.accountId !== 'number' || !Number.isSafeInteger(row.accountId) || row.accountId < 1
        || typeof row.sha256 !== 'string' || !sha.test(row.sha256)
        || typeof row.sizeBytes !== 'number' || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1 || row.sizeBytes > MAX_BYTES
        || !['image/png', 'image/jpeg'].includes(String(row.contentType))
        || !['reference', 'first_frame', 'last_frame'].includes(String(row.role))
        || !['uncertain', 'registered'].includes(String(row.status))) throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
      return row as unknown as AssetIntent
    })
    if (new Set(rows.map(r => r.assetId)).size !== rows.length) throw new ComputeError('COMPUTE_MEDIA_STATE_INVALID', 409)
    return rows
  }
  private async save(intent: AssetIntent, reserve = false): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const rows = await this.rows()
      const index = rows.findIndex(r => r.assetId === intent.assetId)
      const prior = rows[index]
      if (prior !== undefined && (reserve || !this.same(prior, intent))) throw new ComputeError('COMPUTE_MEDIA_ASSET_CONFLICT', 409)
      if (index < 0) {
        if (rows.length >= this.limits.maxRecords) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
        rows.push(intent)
      } else rows[index] = intent
      const text = JSON.stringify({ version: 1, assets: rows })
      if (Buffer.byteLength(text) > this.limits.maxBytes) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
      await writeFileAtomic(this.path, text, { mode: 0o600, dirMode: 0o700 })
    })
  }
  private same(a: AssetIntent, b: AssetIntent) {
    return a.assetId === b.assetId && a.accountId === b.accountId && a.sessionId === b.sessionId
      && a.role === b.role && a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes && a.contentType === b.contentType
  }
  private async owner(core: QianshouCoreClient, intent: AssetIntent, signal: AbortSignal) {
    if ((await core.getIdentity(signal)).accountId !== intent.accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
  }
  private async registered(raw: unknown, intent: AssetIntent, core: QianshouCoreClient, signal: AbortSignal) {
    const row = formalMediaObject(raw)
    if (row.ok !== true || row.status !== 'registered') throw new ComputeError('COMPUTE_MEDIA_ASSET_RESPONSE_INVALID', 502)
    const asset = formalMediaObject(row.asset)
    const extension = intent.contentType === 'image/png' ? 'png' : 'jpg'
    if (asset.asset_id !== intent.assetId || asset.sha256 !== intent.sha256 || asset.size_bytes !== intent.sizeBytes
      || asset.content_type !== intent.contentType || asset.object_key !== `v8/account-${intent.accountId}/media-assets/${intent.assetId}/input.${extension}`
      || typeof asset.object_version_id !== 'string' || asset.object_version_id.length < 1 || asset.object_version_id.length > 1024
      || typeof asset.retention_until !== 'number' || !Number.isSafeInteger(asset.retention_until)
      || asset.retention_until * 1000 <= Date.now() + 60000) throw new ComputeError('COMPUTE_MEDIA_ASSET_RESPONSE_INVALID', 502)
    await this.owner(core, intent, signal)
    const registered: AssetIntent = { ...intent, status: 'registered' }
    await this.save(registered)
    return publicAsset(registered)
  }
  /** Reconcile one original upload identifier without sending media again.
   * @param value - Original Session and asset UUID.
   * @param caller - Local request cancellation.
   * @returns Registered reference or an explicit pending state.
   */
  async status(value: unknown, caller: AbortSignal) {
    const ids = locator(value)
    if (Object.keys(formalMediaObject(value)).sort().join(',') !== 'assetId,sessionId') invalid()
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    const core = this.core()
    const accountId = (await core.getIdentity(signal)).accountId
    const intent = (await this.rows()).find(r => r.assetId === ids.assetId && r.accountId === accountId && r.sessionId === ids.sessionId)
    if (intent === undefined) throw new ComputeError('COMPUTE_MEDIA_ASSET_NOT_FOUND', 404)
    const raw = formalMediaObject(await core.mediaAssetRequest(this.gateway(), 'status', { assetId: intent.assetId }, signal))
    await this.owner(core, intent, signal)
    if (raw.ok === true && raw.status === 'pending' && raw.assetId === intent.assetId) return publicAsset({ ...intent, status: 'uncertain' })
    return this.registered(raw, intent, core, signal)
  }
  /** Upload one validated attachment after saving its stable UUID; repeated calls query its status.
   * @param value - Exact image bytes and metadata from the authenticated original Session.
   * @param caller - Local request cancellation.
   * @returns Version-admitted, credential-free asset reference.
   */
  async upload(value: unknown, caller: AbortSignal) {
    const row = formalMediaObject(value)
    const ids = locator(row)
    if (Object.keys(row).sort().join(',') !== 'assetId,data,mediaType,role,sessionId,sha256'
      || !['reference', 'first_frame', 'last_frame'].includes(String(row.role))
      || !['image/png', 'image/jpeg'].includes(String(row.mediaType)) || typeof row.sha256 !== 'string' || !sha.test(row.sha256)
      || typeof row.data !== 'string' || row.data.length < 1 || row.data.length > Math.ceil(MAX_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(row.data)) invalid()
    const bytes = Buffer.from(row.data, 'base64')
    if (bytes.toString('base64') !== row.data || bytes.length < 1 || bytes.length > MAX_BYTES
      || createHash('sha256').update(bytes).digest('hex') !== row.sha256) invalid()
    inspectFormalMediaImage(bytes, row.mediaType as Mime)
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    const core = this.core()
    const accountId = (await core.getIdentity(signal)).accountId
    const intent: AssetIntent = { ...ids, accountId, role: row.role as Role, contentType: row.mediaType as Mime,
      sizeBytes: bytes.length, sha256: row.sha256, status: 'uncertain' }
    const key = `${accountId}:${ids.assetId}`
    const pending = this.pending.get(key)
    if (pending !== undefined) {
      if (!this.same(pending.intent, intent)) throw new ComputeError('COMPUTE_MEDIA_ASSET_CONFLICT', 409)
      return pending.promise
    }
    const operation = Promise.resolve().then(async () => {
      const previous = (await this.rows()).find(r => r.assetId === intent.assetId)
      if (previous !== undefined) {
        if (!this.same(previous, intent)) throw new ComputeError('COMPUTE_MEDIA_ASSET_CONFLICT', 409)
        return this.status(ids, signal)
      }
      await this.save(intent, true)
      try {
        await this.owner(core, intent, signal)
        const raw = formalMediaObject(await core.mediaAssetRequest(this.gateway(), 'ticket', { assetId: intent.assetId,
          role: intent.role, sha256: intent.sha256, size_bytes: intent.sizeBytes, content_type: intent.contentType }, signal))
        if (raw.ok !== true || raw.assetId !== intent.assetId || raw.upload_path !== '/v1/media/assets/upload') invalid()
        const ticket = formalMediaObject(raw.ticket)
        const payload = formalMediaObject(ticket.payload)
        const extension = intent.contentType === 'image/png' ? 'png' : 'jpg'
        if (Object.keys(ticket).sort().join(',') !== 'key_id,payload,signature'
          || typeof ticket.key_id !== 'string' || ticket.key_id.length < 1 || ticket.key_id.length > 128
          || typeof ticket.signature !== 'string' || ticket.signature.length < 1 || ticket.signature.length > 512
          || Object.keys(payload).sort().join(',') !== 'accountId,assetId,content_type,expires_at,issued_at,nonce,object_key,purpose,role,schema,sha256,size_bytes'
          || payload.schema !== 'qianshou.formal-media-asset-upload.v1' || payload.purpose !== 'qianshou:formal-media-asset-upload'
          || payload.accountId !== accountId || payload.assetId !== intent.assetId || payload.role !== intent.role
          || payload.sha256 !== intent.sha256 || payload.size_bytes !== intent.sizeBytes || payload.content_type !== intent.contentType
          || payload.object_key !== `v8/account-${accountId}/media-assets/${intent.assetId}/input.${extension}`
          || typeof payload.nonce !== 'string' || !nonceUuid.test(payload.nonce)
          || typeof payload.issued_at !== 'number' || !Number.isSafeInteger(payload.issued_at)
          || typeof payload.expires_at !== 'number' || !Number.isSafeInteger(payload.expires_at)
          || payload.expires_at * 1000 <= Date.now() || payload.issued_at * 1000 > Date.now() + 5000
          || payload.expires_at <= payload.issued_at || payload.expires_at - payload.issued_at > 300) invalid()
        await this.owner(core, intent, signal)
        const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
          : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value
        const token = Buffer.from(JSON.stringify(canonical(ticket))).toString('base64url')
        const registered = await core.mediaAssetRequest(this.gateway(), 'upload', bytes, signal, { token, contentType: intent.contentType })
        return await this.registered(registered, intent, core, signal)
      } catch (failure) {
        if (failure instanceof ComputeError && failure.code === 'COMPUTE_QUOTE_ACCOUNT_CHANGED') throw failure
        throw new ComputeError('COMPUTE_MEDIA_ASSET_UNKNOWN', 409)
      }
    })
    this.pending.set(key, { intent, promise: operation })
    void operation.finally(() => { this.pending.delete(key) }).catch(() => undefined)
    return operation
  }
  /** Abort in-flight uploads without changing their durable identifiers or resending bytes. */
  async close(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    await Promise.allSettled([...this.pending.values()].map(p => p.promise))
  }
}
