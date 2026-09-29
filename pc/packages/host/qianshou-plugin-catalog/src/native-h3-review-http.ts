/** Native author review uses control metadata only; GPU bytes go directly to a bound object-store lease. */
import { createHash, randomUUID, verify, type KeyObject } from 'node:crypto'
import { canonicalNativeH3ReviewJson, verifyAnyNativeH3ReviewChallenge,
  type NativeH3ReviewArtifact, type AnyNativeH3ReviewExecution,
  type AnyVerifiedNativeH3ReviewChallenge } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import type { AnyNativeH3Declaration as NativeH3Declaration } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { nativeH3ExpectedDeviceTuple } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { nativeH3DeviceIdentity, type NativeH3DeviceIdentity } from './native-h3-device-identity.ts'
import { CatalogFailure } from './registry.ts'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA = /^[a-f0-9]{64}$/u
const MAX_REPLY = 64 * 1024
function invalid(): never { throw new CatalogFailure('order-review-samples-unavailable') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))
}
function origin(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid()
  return url
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (response.body === null) invalid()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_REPLY) invalid()
      chunks.push(next.value)
    }
  } finally { try { await reader.cancel() } catch { /* Closed. */ } reader.releaseLock() }
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { return invalid() }
}

/** Current identity is reread before each authenticated control request and after its response. */
export interface NativeH3ReviewControl {
  readonly origin: string
  readonly token: string
  readonly ownerId: number
  readonly workerId: string
  readonly profileDir: string
  readonly signal: AbortSignal
  readonly fetch?: typeof fetch
  assertCurrent(): Promise<void>
  observeDeviceKey(input: { challengeId: string; signature: string }): Promise<void>
}
/** Send authenticated control metadata and reread current identity before and after the bounded response.
 * @param input - HTTPS control origin, current identity/token, cancellation signal and identity checks.
 * @param suffix - Endpoint suffix relative to /api/v8/task-adapter-publications/.
 * @param body - JSON control metadata for the selected endpoint.
 * @returns A JSON object from a successful response bounded to sixty-four KiB.
 */
export async function postNativeH3Control(input: NativeH3ReviewControl, suffix: string,
  body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return nativeH3Control(input, suffix, 'POST', body)
}

/** Read bounded authenticated native control metadata without issuing a nonce or permission.
 * @param input - Current authenticated identity and HTTPS control origin.
 * @param suffix - Exact endpoint suffix, including its bounded query.
 * @returns Current server metadata; failures are never GPU retry authority.
 */
export async function getNativeH3Control(input: NativeH3ReviewControl, suffix: string): Promise<Record<string, unknown>> {
  return nativeH3Control(input, suffix, 'GET')
}
async function nativeH3Control(input: NativeH3ReviewControl, suffix: string, method: 'GET' | 'POST',
  body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  input.signal.throwIfAborted()
  await input.assertCurrent()
  if (!input.token || /[\r\n]/u.test(input.token)) throw new CatalogFailure('order-auth-required')
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(new URL(`/api/v8/task-adapter-publications/${suffix}`, origin(input.origin)), {
      method, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.token}` },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
  } catch { return invalid() }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Untrusted details stay private. */ }
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    if (response.status === 409) throw new CatalogFailure('order-review-samples-not-ready')
    invalid()
  }
  const row = await boundedJson(response)
  await input.assertCurrent()
  return row
}

/** Register a device key only after its proof is observed on the current authenticated worker socket.
 * @param input - Current profile/account/worker identity and the socket observation/control ports.
 * @returns Protected device signer after the platform confirms the exact key registration as active.
 */
export async function enrollNativeH3DeviceKey(input: NativeH3ReviewControl): Promise<NativeH3DeviceIdentity> {
  if (!Number.isSafeInteger(input.ownerId) || input.ownerId < 1 || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(input.workerId)) invalid()
  const signer = await nativeH3DeviceIdentity(input.profileDir, input.ownerId, input.workerId)
  const challenge = await postNativeH3Control(input, 'native-device-keys/challenge', {
    worker_id: input.workerId, key_id: signer.keyId, public_key: signer.publicKey,
  })
  const signature = signer.signEnrollment(challenge, Math.floor(Date.now() / 1000))
  const challengeId = challenge.challenge_id
  if (typeof challengeId !== 'string' || !UUID.test(challengeId)) invalid()
  await input.assertCurrent()
  await input.observeDeviceKey({ challengeId, signature })
  await input.assertCurrent()
  const registered = await postNativeH3Control(input, 'native-device-keys/register', {
    worker_id: input.workerId, challenge_id: challengeId, signature,
  })
  if (!exact(registered, ['schema', 'owner_id', 'device_id', 'key_id', 'public_key', 'status'])
    || registered.schema !== 'qianshou.native-h3-device-key.v1' || registered.owner_id !== input.ownerId
    || registered.device_id !== input.workerId || registered.key_id !== signer.keyId
    || registered.public_key !== signer.publicKey || registered.status !== 'active') invalid()
  return signer
}

/** Acquire two independently signed challenges for one immutable author binding.
 * @param input - Current identity, publication/source binding, device key and trusted challenge keys.
 * @returns Two tuple-verified challenges with distinct nonces and inputs; no GPU execution is performed.
 */
export async function startNativeH3ReviewSamples(input: NativeH3ReviewControl & {
  publicationId: string
  sourceDigest: string
  declaration: NativeH3Declaration
  deviceKeyId: string
  localOwnerConfigDigest?: string
  deviceBindingRevision?: number
  restart?: boolean
  challengeKeys: ReadonlyMap<string, KeyObject>
}): Promise<readonly AnyVerifiedNativeH3ReviewChallenge[]> {
  if (!UUID.test(input.publicationId) || !/^sha256:[a-f0-9]{64}$/u.test(input.sourceDigest)
    || input.challengeKeys.size === 0) invalid()
  const response = await postNativeH3Control(input,
    `${input.publicationId}/native-review-samples/${input.restart === true ? 'restart' : 'start'}`, {
      worker_id: input.workerId, key_id: input.deviceKeyId,
    })
  if (!exact(response, ['schema', 'publication_id', 'worker_id', 'challenges'])
    || response.schema !== `qianshou.native-h3-review-session.${input.declaration.contractVersion}` || response.publication_id !== input.publicationId
    || response.worker_id !== input.workerId || !Array.isArray(response.challenges) || response.challenges.length !== 2) invalid()
  const challenges = response.challenges.map((envelope: unknown) => {
    const payload = record(record(envelope).payload)
    if (typeof payload.contract_sha256 !== 'string' || !SHA.test(payload.contract_sha256)) invalid()
    const expected = nativeH3ExpectedDeviceTuple(input.declaration, { publicationId: input.publicationId,
      ownerId: input.ownerId, deviceId: input.workerId, contractSha256: payload.contract_sha256,
      sourceDigest: input.sourceDigest }, input.localOwnerConfigDigest !== undefined && input.deviceBindingRevision !== undefined
      ? { localOwnerConfigDigest: input.localOwnerConfigDigest, deviceBindingRevision: input.deviceBindingRevision } : undefined)
    return verifyAnyNativeH3ReviewChallenge(envelope, expected, input.challengeKeys, Math.floor(Date.now() / 1000))
  })
  if (challenges[0]?.payload.challenge_nonce === challenges[1]?.payload.challenge_nonce
    || challenges[0]?.payload.contract_sha256 !== challenges[1]?.payload.contract_sha256
    || canonicalNativeH3ReviewJson(challenges[0]?.payload.challenge_input)
      === canonicalNativeH3ReviewJson(challenges[1]?.payload.challenge_input)) invalid()
  return challenges
}

/** Report signed result metadata separately from administrator approval.
 * @param input - Current control identity, device signer and completed review execution metadata.
 * @returns Whether a second sample is still required or the independent samples are verified.
 */
export async function reportNativeH3ReviewSample(input: NativeH3ReviewControl & {
  signer: NativeH3DeviceIdentity
  execution: AnyNativeH3ReviewExecution
}): Promise<'awaiting_second_sample' | 'independent_sample_verified'> {
  const execution = input.execution
  if (!UUID.test(execution.publication_id) || !/^[A-Za-z0-9_-]{1,256}$/u.test(execution.challenge_nonce)
    || input.signer.ownerId !== input.ownerId || input.signer.workerId !== input.workerId) invalid()
  const signature = input.signer.signExecution(execution)
  const reply = await postNativeH3Control(input, `${execution.publication_id}/native-review-samples/${execution.challenge_nonce}/report`, {
    execution: { key_id: input.signer.keyId, payload: execution, signature },
  })
  if (!exact(reply, ['schema', 'publication_id', 'worker_id', 'challenge_nonce', 'status', 'sample_receipt', 'approval_required'])
    || reply.schema !== `qianshou.native-h3-review-report-response.${execution.contract_version}` || reply.publication_id !== execution.publication_id
    || reply.worker_id !== input.workerId || reply.challenge_nonce !== execution.challenge_nonce
    || !['awaiting_second_sample', 'independent_sample_verified'].includes(String(reply.status))
    || typeof reply.approval_required !== 'boolean'
    || reply.status === 'awaiting_second_sample' && reply.sample_receipt !== null
    || reply.status === 'independent_sample_verified' && (reply.sample_receipt === null
      || typeof reply.sample_receipt !== 'object' || Array.isArray(reply.sample_receipt))) invalid()
  return reply.status as 'awaiting_second_sample' | 'independent_sample_verified'
}

/** Upload bytes directly to one signed, immutable, owner/device-bound object rather than Shanghai.
 * @param input - Current identity, sample nonce, bounded MP4 bytes/hash, trusted storage host and issuance keys.
 * @returns Versioned artifact metadata after a successful signed object-store PUT; no approval is implied.
 */
export async function uploadNativeH3ReviewArtifact(input: NativeH3ReviewControl & {
  publicationId: string
  challengeNonce: string
  contractVersion?: 'v1' | 'v2'
  bytes: Uint8Array
  sha256: string
  trustedUploadHostname: string
  issuanceKeys: ReadonlyMap<string, KeyObject>
}): Promise<NativeH3ReviewArtifact> {
  if (!UUID.test(input.publicationId) || !/^[A-Za-z0-9_-]{1,256}$/u.test(input.challengeNonce)
    || input.bytes.byteLength < 1 || input.bytes.byteLength > 16 * 1024 * 1024
    || !SHA.test(input.sha256) || createHash('sha256').update(input.bytes).digest('hex') !== input.sha256
    || input.issuanceKeys.size === 0 || !/^[a-z0-9][a-z0-9.-]{2,252}$/u.test(input.trustedUploadHostname)) invalid()
  const bytes = new Uint8Array(input.bytes)
  const resultId = randomUUID()
  const md5 = createHash('md5').update(bytes).digest('base64')
  const reply = await postNativeH3Control(input, `${input.publicationId}/native-review-samples/${input.challengeNonce}/upload-intent`, {
    result_id: resultId, sha256: input.sha256, size_bytes: bytes.byteLength, content_md5: md5,
  })
  const now = Math.floor(Date.now() / 1000)
  if (!exact(reply, ['schema', 'object_key', 'result_id', 'upload_url', 'method', 'headers', 'expires_at', 'issuance_receipt'])
    || reply.schema !== `qianshou.native-h3-review-upload-intent.${input.contractVersion ?? 'v1'}` || reply.result_id !== resultId
    || reply.method !== 'PUT' || !Number.isSafeInteger(reply.expires_at) || Number(reply.expires_at) <= now
    || Number(reply.expires_at) > now + 300 || typeof reply.object_key !== 'string'
    || typeof reply.upload_url !== 'string' || reply.upload_url.length > 8192) invalid()
  const receipt = record(reply.issuance_receipt)
  const grant = record(receipt.payload)
  if (!exact(receipt, ['key_id', 'payload', 'signature']) || typeof receipt.key_id !== 'string'
    || typeof receipt.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(receipt.signature)
    || !exact(grant, ['schema', 'issuance_id', 'account_id', 'workload_id', 'shard_id', 'worker_id',
      'attempt', 'result_id', 'object_key', 'sha256', 'size_bytes', 'content_type', 'issued_at', 'expires_at'])
    || grant.schema !== 'qianshou.artifact-upload-issuance.v1' || grant.account_id !== input.ownerId
    || grant.worker_id !== input.workerId || grant.attempt !== 1 || grant.result_id !== resultId
    || grant.object_key !== reply.object_key || grant.sha256 !== input.sha256 || grant.size_bytes !== bytes.byteLength
    || grant.content_type !== 'video/mp4' || typeof grant.issuance_id !== 'string' || !UUID.test(grant.issuance_id)
    || typeof grant.workload_id !== 'string' || !UUID.test(grant.workload_id)
    || typeof grant.shard_id !== 'string' || !UUID.test(grant.shard_id)
    || !Number.isSafeInteger(grant.issued_at) || Number(grant.issued_at) < 1 || Number(grant.issued_at) > now + 30
    || grant.expires_at !== reply.expires_at || Number(grant.expires_at) <= Number(grant.issued_at)
    || Number(grant.expires_at) - Number(grant.issued_at) > 300) invalid()
  const objectKey = `v8/account-${input.ownerId}/workload-${grant.workload_id}/shard-${grant.shard_id}/result/${resultId}/result.mp4`
  if (reply.object_key !== objectKey) invalid()
  const key = input.issuanceKeys.get(receipt.key_id)
  const signature = Buffer.from(receipt.signature, 'base64url')
  if (key?.asymmetricKeyType !== 'ed25519' || signature.length !== 64
    || signature.toString('base64url') !== receipt.signature
    || !verify(null, Buffer.from(canonicalNativeH3ReviewJson(grant)), key, signature)) invalid()
  let url: URL
  try { url = new URL(reply.upload_url) } catch { return invalid() }
  if (url.protocol !== 'https:' || url.hostname !== input.trustedUploadHostname || url.username || url.password
    || url.port || !url.search || url.hash || decodeURIComponent(url.pathname) !== `/${objectKey}`) invalid()
  const headers = record(reply.headers)
  const retention = headers['x-amz-object-lock-retain-until-date']
  if (!exact(headers, ['Content-Type', 'Content-MD5', 'x-amz-checksum-sha256', 'x-amz-object-lock-mode',
    'x-amz-object-lock-retain-until-date']) || headers['Content-Type'] !== 'video/mp4' || headers['Content-MD5'] !== md5
    || headers['x-amz-checksum-sha256'] !== Buffer.from(input.sha256, 'hex').toString('base64')
    || headers['x-amz-object-lock-mode'] !== 'COMPLIANCE' || typeof retention !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(retention)
    || !Number.isFinite(Date.parse(retention)) || Date.parse(retention) < (now + 50 * 3600 - 30) * 1000) invalid()
  await input.assertCurrent()
  input.signal.throwIfAborted()
  let uploaded: Response
  try {
    uploaded = await (input.fetch ?? fetch)(url, { method: 'PUT', redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]),
      headers: headers as Record<string, string>, body: bytes })
  } catch { throw new CatalogFailure('order-archive-upload-failed') }
  const versions = ['x-amz-version-id', 'x-cos-version-id'].map(name => uploaded.headers.get(name))
    .filter((value): value is string => value !== null)
  const version = versions[0]
  try { await uploaded.body?.cancel() } catch { /* No body is trusted. */ }
  if (!uploaded.ok || version === undefined || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(version)
    || version.toLowerCase() === 'null' || versions.some(value => value !== version)) invalid()
  await input.assertCurrent()
  input.signal.throwIfAborted()
  return { schema: 'artifact.v1', object_key: objectKey, object_version_id: version, filename: 'result.mp4',
    size_bytes: bytes.byteLength, content_type: 'video/mp4', sha256: input.sha256, result_id: resultId }
}
