/** A distinct local device key; publisher keys and independent attestor keys are never reused. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { canonicalNativeH3ReviewJson, type AnyNativeH3ReviewExecution } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { isVerifiedAnyNativeH3PresenceChallenge, isVerifiedNativeH3DeviceConfigChallengeV2,
  type NativeH3PresenceChallenge, type NativeH3PresenceChallengeV2,
  type AnyVerifiedNativeH3PresenceChallenge, type VerifiedNativeH3DeviceConfigChallengeV2 } from '@deepseek-ai/dsh-compute-core/native-h3-presence'
import { accountOrderPublisherIdentity } from './order-publisher-identity.ts'
import { CatalogFailure } from './registry.ts'

/** Protected account/physical-worker key with enrollment, execution and current-presence signing. */
export interface NativeH3DeviceIdentity {
  readonly ownerId: number
  readonly workerId: string
  readonly keyId: string
  readonly publicKey: string
  signEnrollment(payload: unknown, now: number): string
  signConfig(challenge: VerifiedNativeH3DeviceConfigChallengeV2, connectionId: string): string
  signExecution(payload: AnyNativeH3ReviewExecution): string
  signPresence(challenge: AnyVerifiedNativeH3PresenceChallenge, connectionId: string): {
    payload: NativeH3DevicePresence
    signature: string
  }
}

/** Device proof of the independently signed current-connection presence plan. */
export type NativeH3DevicePresence = (Omit<NativeH3PresenceChallenge, 'schema' | 'purpose'> & {
  readonly schema: 'qianshou.native-h3-device-presence.v1'
  readonly purpose: 'qianshou:native-h3-device-presence'
}) | (Omit<NativeH3PresenceChallengeV2, 'schema' | 'purpose'> & {
  readonly schema: 'qianshou.native-h3-device-presence.v2'
  readonly purpose: 'qianshou:native-h3-device-presence.v2'
})

function invalid(): never { throw new CatalogFailure('order-author-key-unavailable') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path
    || process.platform !== 'win32' && (stat.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && stat.uid !== process.getuid()) invalid()
}

/** Create a separate protected key per profile/account/physical ACK worker, without enrollment.
 * @param profileDir - The trusted current Host profile directory.
 * @param ownerId - Authenticated current platform account.
 * @param workerId - This process's acknowledged physical worker, not a guessed hostname.
 * @returns A device signer limited to enrollment, native review execution and verified presence.
 */
export async function nativeH3DeviceIdentity(profileDir: string,
  ownerId: number, workerId: string): Promise<NativeH3DeviceIdentity> {
  if (!isAbsolute(profileDir) || !Number.isSafeInteger(ownerId) || ownerId < 1
    || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(workerId)) invalid()
  const profileStat = await lstat(profileDir)
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()
    || typeof process.getuid === 'function' && profileStat.uid !== process.getuid()) invalid()
  const root = await realpath(profileDir)
  const namespace = join(root, 'native-h3-device-identities')
  await privateDirectory(namespace, true)
  const privateHome = join(namespace, createHash('sha256').update(`${ownerId}\0${workerId}`).digest('hex'))
  await privateDirectory(privateHome, true)
  const namespaceBefore = await lstat(namespace)
  const homeBefore = await lstat(privateHome)
  // The protected storage primitive is shared; this directory contains independently generated key bytes.
  const primitive = await accountOrderPublisherIdentity(privateHome, ownerId)
  await privateDirectory(namespace, false)
  await privateDirectory(privateHome, false)
  const namespaceAfter = await lstat(namespace)
  const homeAfter = await lstat(privateHome)
  if (namespaceBefore.ino !== namespaceAfter.ino || namespaceBefore.dev !== namespaceAfter.dev
    || homeBefore.ino !== homeAfter.ino || homeBefore.dev !== homeAfter.dev) invalid()
  const keyId = `native-h3-device-${createHash('sha256').update(Buffer.from(primitive.publicKey, 'base64url')).digest('hex').slice(0, 24)}`
  return Object.freeze({ ownerId, workerId, keyId, publicKey: primitive.publicKey,
    signEnrollment(payload: unknown, now: number): string {
      const row = record(payload)
      if (Object.keys(row).sort().join(',') !== 'challenge_id,device_id,expires_at,issued_at,key_id,nonce,owner_id,public_key,purpose,schema'
        || row.schema !== 'qianshou.native-h3-device-enrollment.v1'
        || row.purpose !== 'qianshou:native-h3-device-key-enrollment'
        || row.owner_id !== ownerId || row.device_id !== workerId || row.key_id !== keyId || row.public_key !== primitive.publicKey
        || typeof row.challenge_id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(row.challenge_id)
        || typeof row.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(row.nonce)
        || !Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(row.issued_at) || !Number.isSafeInteger(row.expires_at)
        || Number(row.issued_at) > now + 30 || Number(row.expires_at) <= now
        || Number(row.expires_at) <= Number(row.issued_at) || Number(row.expires_at) - Number(row.issued_at) > 300) invalid()
      return primitive.sign(row)
    },
    signConfig(challenge: VerifiedNativeH3DeviceConfigChallengeV2, connectionId: string): string {
      const payload = challenge.payload
      if (!isVerifiedNativeH3DeviceConfigChallengeV2(challenge, payload, Math.floor(Date.now() / 1000))
        || payload.owner_id !== ownerId || payload.device_id !== workerId || payload.key_id !== keyId
        || payload.connection_id !== connectionId) invalid()
      return primitive.sign({ ...payload })
    },
    signPresence(challenge: AnyVerifiedNativeH3PresenceChallenge, connectionId: string) {
      const payload = challenge.payload
      const now = Math.floor(Date.now() / 1000)
      if (!isVerifiedAnyNativeH3PresenceChallenge(challenge, payload, now)
        || payload.owner_id !== ownerId || payload.device_id !== workerId
        || payload.device_key_id !== keyId || payload.connection_id !== connectionId) invalid()
      const presence: NativeH3DevicePresence = payload.contract_version === 'v2'
        ? Object.freeze({ ...payload, schema: 'qianshou.native-h3-device-presence.v2',
          purpose: 'qianshou:native-h3-device-presence.v2' })
        : Object.freeze({ ...payload, schema: 'qianshou.native-h3-device-presence.v1',
          purpose: 'qianshou:native-h3-device-presence' })
      return { payload: presence, signature: primitive.sign(presence) }
    },
    signExecution(payload: AnyNativeH3ReviewExecution): string {
      const row = record(payload)
      const v2 = payload.contract_version === 'v2'
      const version = v2 ? 'v2' : 'v1'
      const keys = ['schema', 'purpose', 'publication_id', 'owner_id', 'device_id', 'task_type',
        'capability_id', 'contract_version', 'contract_sha256', 'artifact_digest', 'source_digest',
        ...v2 ? ['logical_binding_sha256', 'local_owner_config_digest', 'device_binding_revision'] : ['config_digest'],
        'challenge_nonce', 'challenge_input_sha256', 'challenge_result_sha256',
        'artifact', 'issued_at', 'expires_at']
      const sha = /^[a-f0-9]{64}$/u
      const digest = /^sha256:[a-f0-9]{64}$/u
      const now = Math.floor(Date.now() / 1000)
      const text = (value: unknown, max: number): value is string => typeof value === 'string'
        && value.length >= 1 && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value)
      if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
        || row.schema !== `qianshou.native-h3-review-execution.${version}`
        || row.purpose !== `qianshou:native-h3-review-execution${v2 ? '.v2' : ''}`
        || row.owner_id !== ownerId || row.device_id !== workerId
        || typeof row.publication_id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(row.publication_id)
        || typeof row.task_type !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(row.task_type)
        || row.capability_id !== 'video.render' || row.contract_version !== version
        || ![row.contract_sha256, row.challenge_input_sha256, row.challenge_result_sha256]
          .every(value => typeof value === 'string' && sha.test(value))
        || ![row.artifact_digest, row.source_digest, v2 ? row.local_owner_config_digest : row.config_digest]
          .every(value => typeof value === 'string' && digest.test(value))
        || v2 && (typeof row.logical_binding_sha256 !== 'string' || !sha.test(row.logical_binding_sha256)
          || !Number.isSafeInteger(row.device_binding_revision) || Number(row.device_binding_revision) < 1)
        || row.artifact_digest !== row.source_digest || !text(row.challenge_nonce, 256)
        || !Number.isSafeInteger(row.issued_at) || !Number.isSafeInteger(row.expires_at)
        || Number(row.issued_at) < 1 || Number(row.issued_at) > now + 30 || Number(row.expires_at) <= now
        || Number(row.expires_at) <= Number(row.issued_at) || Number(row.expires_at) - Number(row.issued_at) > 900) invalid()
      const artifact = record(row.artifact)
      if (Object.keys(artifact).sort().join(',') !== 'content_type,filename,object_key,object_version_id,result_id,schema,sha256,size_bytes'
        || artifact.schema !== 'artifact.v1' || artifact.filename !== 'result.mp4' || artifact.content_type !== 'video/mp4'
        || !Number.isSafeInteger(artifact.size_bytes) || Number(artifact.size_bytes) < 1 || Number(artifact.size_bytes) > 16 * 1024 * 1024
        || typeof artifact.sha256 !== 'string' || !sha.test(artifact.sha256)
        || !text(artifact.object_version_id, 200) || !/^[A-Za-z0-9_.~+-]+$/u.test(artifact.object_version_id)
        || artifact.object_version_id.toLowerCase() === 'null' || !text(artifact.result_id, 128)
        || !text(artifact.object_key, 1024) || artifact.object_key.includes('://') || artifact.object_key.includes('\\')
        || artifact.object_key.startsWith('/') || artifact.object_key.split('/').some(part => part === '..')
        || createHash('sha256').update(canonicalNativeH3ReviewJson(artifact)).digest('hex') !== row.challenge_result_sha256) invalid()
      // Canonicalization also refuses non-JSON values, nonfinite numbers and malformed Unicode.
      canonicalNativeH3ReviewJson(row)
      return primitive.sign(row)

    } })
}
