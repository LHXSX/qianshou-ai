/** Purpose-pinned install packages, device qualifications and formal Shanghai leases. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import type { MediaNodeCapability, MediaNodeDelivery } from './media-node-channel.ts'
import type { SharingHardware, SharingManifest, SharingMode, SharingSigned } from './sharing-types.ts'
import { NodeContributorError } from './errors.ts'

/** Canonical UUID carried by owner operations and immutable media attempts. */
export const SHARING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
/** SHA-256 references never carry a caller-selected URL or price. */
export const SHARING_HASH = /^[0-9a-f]{64}$/u
const capKeys = ['profile_id', 'profile_version', 'model_sha256', 'workflow_sha256', 'validation_receipt_sha256']
/** Throw finite diagnostic codes without attaching upstream bodies or credentials.
 * @param code - Host-owned classifier.
 * @returns Never; the operation fails closed.
 */
export function sharingFail(code: string): never { throw new NodeContributorError('SHARING_' + code) }
/** Narrow JSON objects before checking their exact fields.
 * @param value - Parsed bounded JSON.
 * @returns A non-array record or a finite refusal.
 */
export function sharingObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) sharingFail('INVALID')
  return value as Record<string, unknown>
}
/** Sorted UTF-8 JSON compatible with the pinned Shanghai and Guangzhou signers.
 * @param value - Finite JSON values only.
 * @returns Canonical bytes; non-JSON values are refused.
 */
export function sharingCanonical(value: unknown): Buffer {
  const normalize = (x: unknown): unknown => {
    if (x === null || typeof x === 'boolean') return x
    if (typeof x === 'string' && x.isWellFormed()) return x
    if (typeof x === 'number' && Number.isFinite(x) && Number.isSafeInteger(x)) return x
    if (Array.isArray(x)) return x.map(normalize)
    const object = sharingObject(x)
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, normalize(object[key])]))
  }
  return Buffer.from(JSON.stringify(normalize(value)))
}
/** Hash only canonical metadata, never model/media bytes in memory.
 * @param value - Canonical finite JSON.
 * @returns Lowercase SHA-256.
 */
export function sharingDigest(value: unknown): string { return createHash('sha256').update(sharingCanonical(value)).digest('hex') }
/** Verify one independently configured Ed25519 purpose and short issuance window.
 * @param input - Signed response, not a browser-issued receipt.
 * @param trust - Pinned key identifier, public PEM and required purpose/schema.
 * @returns The authenticated payload; expired or cross-purpose certificates fail closed.
 */
export function sharingVerify(input: unknown, trust: { keyId: string
  publicKey: string
  schema: string
  purpose: string
  ttl: number
  storedReceipt?: boolean }): Record<string, unknown> {
  try {
    const envelope = sharingObject(input)
    const payload = sharingObject(envelope.payload)
    if (Object.keys(envelope).sort().join(',') !== 'key_id,payload,signature' || envelope.key_id !== trust.keyId
      || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)) sharingFail('SIGNATURE_INVALID')
    const signature = Buffer.from(envelope.signature, 'base64url')
    const key = createPublicKey(trust.publicKey)
    const now = Math.floor(Date.now() / 1000)
    if (signature.toString('base64url') !== envelope.signature || key.asymmetricKeyType !== 'ed25519'
      || !verify(null, sharingCanonical(payload), key, signature) || payload.schema !== trust.schema || payload.purpose !== trust.purpose
      || typeof payload.issued_at !== 'number' || !Number.isSafeInteger(payload.issued_at)
      || typeof payload.expires_at !== 'number' || !Number.isSafeInteger(payload.expires_at)
      || payload.issued_at > now || !trust.storedReceipt && payload.expires_at <= now || payload.expires_at <= payload.issued_at
      || payload.expires_at - payload.issued_at > trust.ttl) sharingFail('SIGNATURE_INVALID')
    return payload
  } catch { sharingFail('SIGNATURE_INVALID') }
}
/** Validate bounded capabilities from an independently approved package or qualification.
 * @param value - Exact five-field profile references.
 * @returns Frozen capability metadata; self-reported execution parameters are not admitted.
 */
export function sharingCapabilities(value: unknown): readonly MediaNodeCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) sharingFail('CATALOG_INVALID')
  const result = value.map((value) => {
    const p = sharingObject(value)
    if (Object.keys(p).sort().join(',') !== [...capKeys].sort().join(',')
      || typeof p.profile_id !== 'string' || !/^[a-z][a-z0-9_.-]{2,99}$/u.test(p.profile_id)
      || typeof p.profile_version !== 'number' || !Number.isSafeInteger(p.profile_version) || p.profile_version < 1
      || capKeys.slice(2).some(key => typeof p[key] !== 'string' || !SHARING_HASH.test(p[key]))) sharingFail('CATALOG_INVALID')
    return Object.freeze(p) as unknown as MediaNodeCapability
  })
  if (new Set(result.map(p => p.profile_id + ':' + String(p.profile_version))).size !== result.length) sharingFail('CATALOG_INVALID')
  return Object.freeze(result)
}
/** Reject traversal, absolute paths, reserved Windows names and platform aliases.
 * @param value - Relative package file path from the approved manifest.
 * @returns The same portable file path.
 */
export function sharingRelative(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || !/^[A-Za-z0-9_./-]+$/u.test(value)
    || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..' || /\.$/u.test(p)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p))) sharingFail('PATH_INVALID')
  return value
}
/** Compute the immutable package identity without expiring delivery URLs.
 * @param manifest - Already bounded package metadata.
 * @returns The version's canonical SHA-256.
 */
export function sharingBundleDigest(manifest: Omit<SharingManifest, 'bundle_id'> | SharingManifest): string {
  return sharingDigest({ files: manifest.files.map(({ path, sha256, size_bytes, executable }) => ({ path, sha256,
    size_bytes, executable })),
  entrypoint: manifest.entrypoint, args: manifest.args, abi: manifest.abi, profiles: manifest.profiles,
  executor_sha256: manifest.executor_sha256, min_vram_mb: manifest.min_vram_mb, min_memory_mb: manifest.min_memory_mb,
  supported_gpu_names: manifest.supported_gpu_names, storage_bytes: manifest.storage_bytes,
  platform: manifest.platform, arch: manifest.arch, mode: manifest.mode })
}
/** Authenticate an install challenge and match real platform resources before any bytes run.
 * @param signed - Official response signed for this owner/device/worker/challenge.
 * @param request - Current Host facts and explicit pinned trust.
 * @returns Approved immutable package metadata; no device qualification is implied.
 */
export function parseSharingManifest(signed: unknown, request: { nonce: string
  owner: number
  deviceId: string
  workerId: string
  mode: SharingMode
  hardware: SharingHardware
  keyId: string
  publicKey: string
  downloadOrigins: readonly string[]
  restoreReceipt?: boolean }): SharingManifest {
  const p = sharingVerify(signed, { keyId: request.keyId, publicKey: request.publicKey,
    schema: 'qianshou.media-install-manifest.v1', purpose: 'qianshou:media-install-manifest', ttl: 300,
    storedReceipt: request.restoreReceipt === true })
  const expected = 'abi,accountId,arch,args,bundle_id,deviceId,display_name,entrypoint,executor_sha256,expires_at,files,health_path,issued_at,min_memory_mb,min_vram_mb,mode,nonce,platform,profiles,purpose,schema,storage_bytes,supported_gpu_names,workerId'
  if (Object.keys(p).sort().join(',') !== expected || p.nonce !== request.nonce || p.accountId !== request.owner
    || p.deviceId !== request.deviceId || p.workerId !== request.workerId || p.mode !== request.mode
    || p.platform !== request.hardware.platform || p.arch !== request.hardware.arch || p.abi !== 'qianshou.media-runtime.v1'
    || p.health_path !== '/health' || typeof p.bundle_id !== 'string' || !SHARING_HASH.test(p.bundle_id)
    || typeof p.executor_sha256 !== 'string' || !SHARING_HASH.test(p.executor_sha256)
    || typeof p.display_name !== 'string' || p.display_name.length < 1 || p.display_name.length > 128
      || /[\x00-\x1f\x7f]/u.test(p.display_name)
    || /https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}|localhost|Bearer\s/iu.test(p.display_name)
    || !Array.isArray(p.supported_gpu_names) || p.supported_gpu_names.length < 1 || p.supported_gpu_names.length > 128
    || p.supported_gpu_names.some(v => typeof v !== 'string' || v.length < 1 || v.length > 256)
    || !['min_vram_mb', 'min_memory_mb', 'storage_bytes'].every(k => typeof p[k] === 'number' && Number.isSafeInteger(p[k]) && p[k] > 0)
    || !Array.isArray(p.files) || p.files.length < 1 || p.files.length > 512 || !Array.isArray(p.args) || p.args.length > 32
    || p.args.some(v => typeof v !== 'string' || v.length > 1024 || /[\x00-\x1f\x7f]/u.test(v)
      || /\{(?!PORT\}|ROOT\}|INSTANCE_ID\}|AUTH_TOKEN_FILE\})/u.test(v))) sharingFail('CATALOG_INVALID')
  if (!request.restoreReceipt && (request.hardware.vramMb < Number(p.min_vram_mb) || request.hardware.memoryMb < Number(p.min_memory_mb)
    || !p.supported_gpu_names.includes(request.hardware.gpuName))) sharingFail('HARDWARE_UNSUPPORTED')
  const files = p.files.map((value) => {
    const f = sharingObject(value)
    sharingRelative(f.path)
    if (Object.keys(f).sort().join(',') !== 'etag,executable,path,sha256,size_bytes,url' || typeof f.sha256 !== 'string'
      || !SHARING_HASH.test(f.sha256)
      || typeof f.size_bytes !== 'number' || !Number.isSafeInteger(f.size_bytes) || f.size_bytes < 1 || f.size_bytes > 64 * 1024 ** 3
      || typeof f.executable !== 'boolean' || typeof f.etag !== 'string' || !/^"[^"\r\n]{1,128}"$/u.test(f.etag)
      || typeof f.url !== 'string' || f.url.length > 4096) sharingFail('CATALOG_INVALID')
    const url = new URL(f.url)
    if (!request.downloadOrigins.includes(url.origin) || url.username || url.password || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(
        url.hostname)))) sharingFail('CATALOG_INVALID')
    return f
  })
  if (files.some(f => ['process.json', 'runtime-token'].includes(String(f.path)) || String(f.path).endsWith('.part')
    || files.some(other => other.path !== f.path && String(other.path).startsWith(String(f.path) + '/')))) sharingFail('PATH_INVALID')
  const entry = sharingRelative(p.entrypoint)
  if (!p.args.includes('127.0.0.1') || !p.args.includes('{PORT}') || !p.args.includes('{AUTH_TOKEN_FILE}')
    || !p.args.includes('{INSTANCE_ID}')
    || new Set(files.map(f => String(f.path).toLowerCase())).size !== files.length
    || !files.some(f => f.path === entry && f.executable === true && f.sha256 === p.executor_sha256)
    || files.reduce((sum, f) => sum + Number(f.size_bytes), 0) * 2 > Number(p.storage_bytes)) sharingFail('CATALOG_INVALID')
  const manifest = { ...p, profiles: sharingCapabilities(p.profiles) } as unknown as SharingManifest
  if (sharingBundleDigest(manifest) !== manifest.bundle_id) sharingFail('CATALOG_INVALID')
  return manifest
}
/** Retain only a structurally signed envelope in private persistence.
 * @param value - Original bounded server envelope.
 * @returns Serializable immutable signature fields, never an authorization inferred from persistence.
 */
export function sharingEnvelope(value: unknown): SharingSigned {
  const v = sharingObject(value)
  if (typeof v.key_id !== 'string' || typeof v.signature !== 'string') sharingFail('SIGNATURE_INVALID')
  return { key_id: v.key_id, payload: sharingObject(v.payload), signature: v.signature }
}
/** Verify the Shanghai authorization and compare every immutable execution identity.
 * @param task - Guangzhou-delivered task still treated as untrusted.
 * @param facts - Current authenticated device/provider identity and pinned Shanghai key.
 * @returns Canonical local plan and capability; failed checks never reserve a GPU.
 */
export function sharingTask(task: MediaNodeDelivery, facts: { owner: string
  deviceId: string
  keyId: string
  publicKey: string
  capabilities: readonly MediaNodeCapability[] }): { mode: SharingMode; plan: Record<string, unknown>; spec: Record<string, unknown> } {
  const e = sharingObject(task.envelope)
  const a = sharingVerify(e.authorization, { keyId: facts.keyId, publicKey: facts.publicKey,
    schema: 'qianshou.formal-media-authorization.v1', purpose: 'qianshou:formal-media-authorization', ttl: 3645 })
  const plan = sharingObject(e.plan); const price = sharingObject(a.price); const spec = sharingObject(e.spec)
  const media = sharingObject(spec.media_input)
  const full: Record<string, unknown> = { ...plan, price_version: price.price_version, price_unit: price.price_unit, units: price.units }
  const unhashed: Record<string, unknown> = { ...full }; delete unhashed.plan_sha256
  if (!SHARING_UUID.test(task.taskId) || !SHARING_UUID.test(task.attemptId) || !SHARING_UUID.test(task.authorizationId)
    || !SHARING_HASH.test(task.quoteId) || task.expired || Date.parse(task.leaseExpiresAt) <= Date.now()
    || e.schema !== 'qianshou.formal-media-order.v1' || a.taskId !== task.taskId || a.attemptId !== task.attemptId
    || a.deviceId !== facts.deviceId || a.ownerId !== facts.owner || a.leaseEpoch !== task.leaseEpoch
    || a.leaseExpiresAt !== task.leaseExpiresAt || a.quoteId !== task.quoteId || a.authorizationId !== task.authorizationId
    || a.accountId !== e.accountId || !Number.isSafeInteger(e.accountId) || Number(e.accountId) < 1
    || e.plan_sha256 !== a.plan_sha256 || plan.plan_sha256 !== e.plan_sha256 || sharingDigest(unhashed) !== e.plan_sha256
    || !facts.capabilities.some(c => capKeys.every(k => Reflect.get(c, k) === plan[k]))
    || !['image', 'video'].includes(String(media.capability)) || media.profile_id !== plan.profile_id
      || media.profile_version !== plan.profile_version
    || ['mode', 'quality', 'orientation', 'seconds'].some(k => media[k] !== plan[k])
    || spec.task_type !== (media.capability === 'video' ? 'video_generate' : 'image_generate') || spec.input_kind !== 'params_only'
    || typeof media.prompt !== 'string' || media.prompt.length > 8192 || typeof media.negative_prompt !== 'string'
    || !Array.isArray(media.assets) || media.assets.length > 8) sharingFail('LEASE_INVALID')
  return { mode: media.capability as SharingMode, plan, spec }
}

/** Authenticate the full current spec independently of the relay's task envelope.
 * @param signed - Original Shanghai order-current envelope.
 * @param task - Persisted original lease.
 * @param facts - Device/provider and independent order-current public key.
 * @returns Current authenticated spec; stale or mutated prompt/attachments refuse execution.
 */
export function sharingCurrentOrder(signed: unknown, task: MediaNodeDelivery, facts: { owner: string
  deviceId: string
  keyId: string
  publicKey: string }): Record<string, unknown> {
  const p = sharingVerify(signed, { ...facts, schema: 'qianshou.formal-media-current-order.v1',
    purpose: 'qianshou:formal-media-order-current', ttl: 60 })
  const e = sharingObject(task.envelope); const price = sharingObject(sharingObject(sharingObject(e.authorization).payload).price)
  const plan = { ...sharingObject(e.plan), price_version: price.price_version, price_unit: price.price_unit, units: price.units }
  if (Object.keys(p).sort().join(
    ',') !== 'accountId,attemptId,authorizationId,deviceId,expires_at,issued_at,leaseEpoch,leaseExpiresAt,ownerId,plan,plan_sha256,purpose,quoteId,schema,spec,status,taskId'
    || p.taskId !== task.taskId || p.attemptId !== task.attemptId || p.deviceId !== facts.deviceId || p.ownerId !== facts.owner
    || p.accountId !== e.accountId || p.leaseEpoch !== task.leaseEpoch || p.leaseExpiresAt !== task.leaseExpiresAt
    || p.quoteId !== task.quoteId || p.authorizationId !== task.authorizationId || p.plan_sha256 !== e.plan_sha256
    || !['staged', 'accepted', 'running', 'uploading', 'awaiting_settlement'].includes(String(p.status))
    || sharingDigest(p.spec) !== sharingDigest(e.spec) || sharingDigest(p.plan) !== sharingDigest(plan)) sharingFail('LEASE_INVALID')
  const media = sharingObject(sharingObject(p.spec).media_input)
  if (Object.keys(media).sort().join(
    ',') !== 'assets,capability,mode,negative_prompt,orientation,profile_id,profile_version,prompt,quality,seconds'
    || !Array.isArray(media.assets) || media.assets.length > 8) sharingFail('LEASE_INVALID')
  const assets = media.assets.map((v) => { const a = sharingObject(v)
    if (Object.keys(a).sort().join(',') !== 'asset_id,role,sha256' || typeof a.asset_id !== 'string' || !SHARING_UUID.test(a.asset_id)
      || typeof a.sha256 !== 'string' || !SHARING_HASH.test(a.sha256) || !['reference', 'first_frame',
      'last_frame'].includes(String(a.role))) sharingFail('LEASE_INVALID')
    return a
  }).sort((a, b) => String(a.role).localeCompare(String(b.role), 'en') || String(a.asset_id).localeCompare(String(b.asset_id), 'en'))
  const executionPlan = sharingObject(e.plan); const output = sharingObject(e.outputPolicy)
  if (sharingDigest(assets) !== executionPlan.asset_manifest_sha256
    || Object.keys(output).sort().join(',') !== 'max_bytes,object_prefix'
    || output.object_prefix !== `v8/account-${String(e.accountId)}/workload-${task.taskId}/shard-${task.attemptId}/result/`
    || output.max_bytes !== 64 * 1024 * 1024) sharingFail('LEASE_INVALID')
  return sharingObject(p.spec)
}
