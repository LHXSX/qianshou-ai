/** Independent Guangzhou result signatures; a device event cannot settle an order. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { MediaNodeError, mediaNodeId, mediaNodeInteger, type MediaNodeDispatch } from './media-node-store.ts'

export interface MediaResultFile {
  object_key: string; object_version_id: string; sha256: string; size_bytes: number
  content_type: string; width: number; height: number; fps_num: number; fps_den: number; seconds_ms: number
}
export interface MediaResultPayload {
  schema: 'qianshou.formal-media-result.v1'; purpose: 'qianshou:formal-media-result'
  taskId: string; attemptId: string; deviceId: string; ownerId: string; leaseEpoch: number
  plan_sha256: string; profile_id: string; profile_version: number; status: 'verified' | 'rejected'
  resultRevision: string; billableResultRevision: string; assetId: string; file: MediaResultFile
  reason: null | 'media_rejected'; issued_at: number; expires_at: number
}

/** Canonical JSON shared with the existing Python Ed25519 receipts. Numbers are safe integers. */
export function canonicalMediaJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalMediaJson).join(',')}]`
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalMediaJson(row[key])}`).join(',')}}`
  }
  throw new MediaNodeError('MEDIA_RESULT_CANONICAL_INVALID')
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaNodeError('MEDIA_RESULT_INVALID')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key))) throw new MediaNodeError('MEDIA_RESULT_INVALID')
  return row
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new MediaNodeError('MEDIA_RESULT_INVALID')
  return value
}

/** Deterministic immutable result identity; expiry and re-signing cannot create a second billable result. */
export function mediaResultRevision(payload: Omit<MediaResultPayload, 'resultRevision' | 'billableResultRevision' | 'issued_at' | 'expires_at'>): string {
  return createHash('sha256').update(canonicalMediaJson(payload)).digest('hex')
}

/** Verify a purpose-separated pinned Ed25519 receipt before it can enter the control journal. */
export function verifyMediaResultVerdict(value: unknown, roots: Readonly<Record<string, string>>, now = Math.floor(Date.now() / 1000)): MediaResultPayload {
  if (Object.keys(roots).length === 0) throw new MediaNodeError('MEDIA_RESULT_VERIFIER_NOT_CONFIGURED', 503)
  const envelope = exact(value, ['key_id', 'payload', 'signature'])
  const keyId = mediaNodeId(envelope['key_id'])
  const pem = roots[keyId]
  const encoded = envelope['signature']
  if (!pem || typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(encoded)) throw new MediaNodeError('MEDIA_RESULT_SIGNATURE_INVALID', 401)
  const signature = Buffer.from(encoded, 'base64url')
  if (signature.length !== 64 || signature.toString('base64url') !== encoded) throw new MediaNodeError('MEDIA_RESULT_SIGNATURE_INVALID', 401)
  const p = exact(envelope['payload'], ['schema', 'purpose', 'taskId', 'attemptId', 'deviceId', 'ownerId', 'leaseEpoch', 'plan_sha256',
    'profile_id', 'profile_version', 'status', 'resultRevision', 'billableResultRevision', 'assetId', 'file', 'reason', 'issued_at', 'expires_at'])
  const canonical = canonicalMediaJson(p)
  if (Buffer.byteLength(canonical) > 16 * 1024) throw new MediaNodeError('MEDIA_RESULT_INVALID')
  try {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical), key, signature)) throw new Error('invalid')
  } catch { throw new MediaNodeError('MEDIA_RESULT_SIGNATURE_INVALID', 401) }
  if (p['schema'] !== 'qianshou.formal-media-result.v1' || p['purpose'] !== 'qianshou:formal-media-result'
    || !['verified', 'rejected'].includes(String(p['status'])) || (p['status'] === 'verified' ? p['reason'] !== null : p['reason'] !== 'media_rejected')) throw new MediaNodeError('MEDIA_RESULT_INVALID')
  for (const field of ['taskId', 'attemptId', 'deviceId', 'assetId', 'profile_id']) mediaNodeId(p[field])
  if (typeof p['ownerId'] !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(p['ownerId'])) throw new MediaNodeError('MEDIA_RESULT_INVALID')
  mediaNodeInteger(p['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1); mediaNodeInteger(p['profile_version'], Number.MAX_SAFE_INTEGER, 1)
  digest(p['plan_sha256']); digest(p['resultRevision']); digest(p['billableResultRevision'])
  const issued = mediaNodeInteger(p['issued_at'], Number.MAX_SAFE_INTEGER, 1)
  const expires = mediaNodeInteger(p['expires_at'], Number.MAX_SAFE_INTEGER, 1)
  if (issued > now + 5 || issued < now - 300 || expires <= now || expires <= issued || expires > issued + 300) throw new MediaNodeError('MEDIA_RESULT_EXPIRED', 409)
  const f = exact(p['file'], ['object_key', 'object_version_id', 'sha256', 'size_bytes', 'content_type', 'width', 'height', 'fps_num', 'fps_den', 'seconds_ms'])
  if (typeof f['object_key'] !== 'string' || !new RegExp(`^v8/account-${p['ownerId']}/[A-Za-z0-9_./-]{1,700}$`, 'u').test(f['object_key'])
    || f['object_key'].split('/').some(part => part === '.' || part === '..' || part === '')
    || typeof f['object_version_id'] !== 'string' || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(f['object_version_id']) || f['object_version_id'] === 'null'
    || !['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(String(f['content_type']))) throw new MediaNodeError('MEDIA_RESULT_INVALID')
  digest(f['sha256']); mediaNodeInteger(f['size_bytes'], 64 * 1024 * 1024, 1)
  for (const name of ['width', 'height']) mediaNodeInteger(f[name], 8192, p['status'] === 'verified' ? 16 : 0)
  mediaNodeInteger(f['fps_num'], 120000); mediaNodeInteger(f['fps_den'], 10000, 1); mediaNodeInteger(f['seconds_ms'], 120150)
  const payload = p as unknown as MediaResultPayload
  const { resultRevision, billableResultRevision, issued_at: _issued, expires_at: _expires, ...identity } = payload
  if (resultRevision !== billableResultRevision || resultRevision !== mediaResultRevision(identity)) throw new MediaNodeError('MEDIA_RESULT_REVISION_INVALID', 409)
  return payload
}

/** Admit Shanghai's signed frozen price only after its complete device/task/lease binding is checked. */
export function verifyMediaDispatchAuthorization(task: MediaNodeDispatch, nodeOwnerId: string,
  roots: Readonly<Record<string, string>>, now = Math.floor(Date.now() / 1000)): void {
  if (Object.keys(roots).length === 0) throw new MediaNodeError('SHANGHAI_AUTHORIZATION_NOT_CONFIGURED', 503)
  const e = exact(task.envelope['authorization'], ['key_id', 'payload', 'signature'])
  const keyId = mediaNodeId(e['key_id']); const signature = e['signature']
  if (!roots[keyId] || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) throw new MediaNodeError('SHANGHAI_AUTHORIZATION_INVALID', 401)
  const p = exact(e['payload'], ['schema', 'purpose', 'taskId', 'attemptId', 'deviceId', 'leaseEpoch', 'leaseExpiresAt',
    'accountId', 'ownerId', 'plan_sha256', 'quoteId', 'authorizationId', 'price', 'issued_at', 'expires_at'])
  try {
    const key = createPublicKey(roots[keyId]!)
    const bytes = Buffer.from(signature, 'base64url')
    if (key.asymmetricKeyType !== 'ed25519' || bytes.length !== 64 || bytes.toString('base64url') !== signature
      || !verify(null, Buffer.from(canonicalMediaJson(p)), key, bytes)) throw new Error('invalid')
  } catch { throw new MediaNodeError('SHANGHAI_AUTHORIZATION_INVALID', 401) }
  const accountId = mediaNodeInteger(p['accountId'], Number.MAX_SAFE_INTEGER, 1)
  if (p['schema'] !== 'qianshou.formal-media-authorization.v1' || p['purpose'] !== 'qianshou:formal-media-authorization'
    || p['ownerId'] !== nodeOwnerId || accountId !== task.envelope['accountId'] || p['plan_sha256'] !== task.envelope['plan_sha256']
    || ['taskId', 'attemptId', 'deviceId', 'leaseEpoch', 'leaseExpiresAt', 'quoteId', 'authorizationId'].some(field => p[field] !== task[field as keyof MediaNodeDispatch])) throw new MediaNodeError('SHANGHAI_AUTHORIZATION_BINDING_INVALID', 409)
  digest(p['plan_sha256']); digest(p['quoteId'])
  const issued = mediaNodeInteger(p['issued_at'], Number.MAX_SAFE_INTEGER, 1)
  const expires = mediaNodeInteger(p['expires_at'], Number.MAX_SAFE_INTEGER, 1)
  if (issued > now + 5 || expires <= now || issued >= expires || expires * 1000 !== Date.parse(task.leaseExpiresAt)) throw new MediaNodeError('SHANGHAI_AUTHORIZATION_EXPIRED', 409)
  const price = exact(p['price'], ['currency', 'total_yuan', 'profile_id', 'profile_version', 'price_version', 'price_unit', 'units'])
  const spec = task.envelope['spec'] as Record<string, unknown> | undefined
  const input = spec?.['media_input'] as Record<string, unknown> | undefined
  if (price['currency'] !== 'CNY' || typeof price['total_yuan'] !== 'string' || !/^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/u.test(price['total_yuan'])
    || !input || price['profile_id'] !== input['profile_id'] || price['profile_version'] !== input['profile_version']) throw new MediaNodeError('SHANGHAI_AUTHORIZATION_PRICE_INVALID', 409)
  mediaNodeId(price['price_unit']); mediaNodeInteger(price['profile_version'], Number.MAX_SAFE_INTEGER, 1)
  mediaNodeInteger(price['price_version'], Number.MAX_SAFE_INTEGER, 1); mediaNodeInteger(price['units'], 120, 1)
}

export interface MediaQualifiedProfile {
  profile_id: string; profile_version: number; model_sha256: string; workflow_sha256: string; validation_receipt_sha256: string
  deviceId: string; ownerId: string; executor_sha256: string
  worker_id: string; authorized_until: number; verified_until: number; p90_execution_seconds: number; max_task_seconds: number
  gpu_model: string; vram_mb: number; total_memory_mb: number; max_concurrent: number; hardware_qualification: string
}
/** Only the independent verifier's fresh catalog-derived qualification can change the directory's readiness. */
export function verifyMediaDirectoryQualification(value: unknown, roots: Readonly<Record<string, string>>, nonce: string,
  now = Math.floor(Date.now() / 1000)): readonly MediaQualifiedProfile[] {
  const e = exact(value, ['key_id', 'payload', 'signature'])
  const keyId = mediaNodeId(e['key_id']); const signature = e['signature']
  if (!roots[keyId] || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) throw new MediaNodeError('MEDIA_QUALIFICATION_INVALID', 401)
  const p = exact(e['payload'], ['schema', 'purpose', 'nonce', 'profiles', 'issued_at', 'expires_at'])
  try {
    const key = createPublicKey(roots[keyId]!); const bytes = Buffer.from(signature, 'base64url')
    if (key.asymmetricKeyType !== 'ed25519' || bytes.toString('base64url') !== signature || !verify(null, Buffer.from(canonicalMediaJson(p)), key, bytes)) throw new Error('invalid')
  } catch { throw new MediaNodeError('MEDIA_QUALIFICATION_INVALID', 401) }
  const issued = mediaNodeInteger(p['issued_at'], Number.MAX_SAFE_INTEGER, 1)
  const expires = mediaNodeInteger(p['expires_at'], Number.MAX_SAFE_INTEGER, 1)
  if (p['schema'] !== 'qianshou.formal-media-directory-qualification.v1' || p['purpose'] !== 'qianshou:formal-media-directory-qualification'
    || p['nonce'] !== nonce || issued < now - 30 || issued > now + 5 || expires <= now || expires > issued + 30
    || !Array.isArray(p['profiles']) || p['profiles'].length > 500) throw new MediaNodeError('MEDIA_QUALIFICATION_INVALID')
  return p['profiles'].map(row => {
    const r = exact(row, ['profile_id', 'profile_version', 'model_sha256', 'workflow_sha256', 'validation_receipt_sha256', 'deviceId', 'ownerId', 'executor_sha256', 'worker_id', 'authorized_until', 'verified_until', 'p90_execution_seconds', 'max_task_seconds', 'gpu_model', 'vram_mb', 'total_memory_mb', 'max_concurrent', 'hardware_qualification'])
    for (const field of ['profile_id', 'deviceId', 'ownerId']) mediaNodeId(r[field])
    mediaNodeInteger(r['profile_version'], Number.MAX_SAFE_INTEGER, 1)
    for (const field of ['model_sha256', 'workflow_sha256', 'validation_receipt_sha256', 'executor_sha256']) digest(r[field])
    mediaNodeId(r['worker_id'])
    const p90 = mediaNodeInteger(r['p90_execution_seconds'], 3600, 1)
    mediaNodeInteger(r['max_task_seconds'], 3600, p90); mediaNodeInteger(r['vram_mb'], 65536, 8192)
    mediaNodeInteger(r['total_memory_mb'], 524288, 1024)
    if (mediaNodeInteger(r['authorized_until'], Number.MAX_SAFE_INTEGER, 1) <= now + p90 + 45
      || mediaNodeInteger(r['verified_until'], Number.MAX_SAFE_INTEGER, 1) <= now || r['max_concurrent'] !== 1
      || r['hardware_qualification'] !== 'rtx_4060_or_better_verified' || typeof r['gpu_model'] !== 'string' || r['gpu_model'].length < 1 || r['gpu_model'].length > 128) throw new MediaNodeError('MEDIA_QUALIFICATION_INVALID')
    return r as unknown as MediaQualifiedProfile
  })
}
