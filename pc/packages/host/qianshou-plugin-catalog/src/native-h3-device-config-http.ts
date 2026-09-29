/** Explicit v2 private configuration CAS is control metadata, never execution authority. */
import type { KeyObject } from 'node:crypto'
import { nativeH3LogicalBindingSha256, nativeH3DeclarationBinding,
  type NativeH3DeclarationV2, type NativeH3CanonicalDeclaration } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { nativeH3ExpectedDeviceTuple } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { verifyNativeH3DeviceConfigChallengeV2 } from '@deepseek-ai/dsh-compute-core/native-h3-presence'
import { getNativeH3Control, postNativeH3Control, type NativeH3ReviewControl } from './native-h3-review-http.ts'
import type { NativeH3DeviceIdentity } from './native-h3-device-identity.ts'
import { CatalogFailure } from './registry.ts'

/** Only the server chooses revisions; registration alone does not verify a device or enable supply. */
export interface NativeH3DeviceConfigHead {
  readonly schema: 'qianshou.native-h3-device-config.v2'
  readonly publication_id: string
  readonly worker_id: string
  readonly logical_binding_sha256: string
  readonly local_owner_config_digest: string | null
  readonly device_binding_revision: number
  readonly status: 'absent' | 'registered'
}
/** Current portable source plus private preparation; private values never enter its public four files. */
export interface NativeH3V2ConfigSelection {
  readonly declaration: NativeH3DeclarationV2 | NativeH3CanonicalDeclaration
  readonly sourceDigest: string
  readonly localOwnerConfigDigest: string
}
function invalid(): never { throw new CatalogFailure('order-review-samples-not-ready') }
function parseHead(value: Record<string, unknown>, publicationId: string, workerId: string,
  selection: NativeH3V2ConfigSelection): NativeH3DeviceConfigHead {
  const binding = nativeH3DeclarationBinding(selection.declaration)
  if ('ownerConfigDigest' in binding) invalid()
  const keys = ['schema', 'publication_id', 'worker_id', 'logical_binding_sha256',
    'local_owner_config_digest', 'device_binding_revision', 'status']
  if (Object.keys(value).length !== 7 || keys.some(key => !Object.hasOwn(value, key))
    || value.schema !== 'qianshou.native-h3-device-config.v2' || value.publication_id !== publicationId
    || value.worker_id !== workerId || value.logical_binding_sha256 !== nativeH3LogicalBindingSha256(binding)
    || !Number.isSafeInteger(value.device_binding_revision)
    || (value.status === 'absent' ? value.local_owner_config_digest !== null || value.device_binding_revision !== 0
      : value.status !== 'registered' || typeof value.local_owner_config_digest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(value.local_owner_config_digest) || Number(value.device_binding_revision) < 1)) invalid()
  return Object.freeze({ ...value }) as unknown as NativeH3DeviceConfigHead
}
/** Read the authoritative device head without creating keys, challenges, samples or owner grants.
 * @param input - Authenticated current owner/device, exact public source and private preparation.
 * @returns An absent or registered head; registered is not a ready receipt.
 */
export async function readNativeH3DeviceConfig(input: NativeH3ReviewControl & {
  publicationId: string
  selection: NativeH3V2ConfigSelection
}): Promise<NativeH3DeviceConfigHead> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(input.publicationId)) invalid()
  return parseHead(await getNativeH3Control(input,
    `${input.publicationId}/native-device-configs?worker_id=${encodeURIComponent(input.workerId)}`),
  input.publicationId, input.workerId, input.selection)
}
/** Register one current private revision with an independently signed plan and same-socket key witness.
 * @param input - Current selection, signer, operator keys and fresh local/socket checks.
 * @returns Server-confirmed revision; old revisions and samples are never reinterpreted.
 */
export async function registerNativeH3DeviceConfig(input: NativeH3ReviewControl & {
  publicationId: string
  selection: NativeH3V2ConfigSelection
  signer: NativeH3DeviceIdentity
  connectionId: string
  challengeKeys: ReadonlyMap<string, KeyObject>
  assertLocalCurrent(): Promise<void>
  observeConfig(input: { challengeId: string; signature: string }): Promise<void>
}): Promise<NativeH3DeviceConfigHead> {
  await input.assertLocalCurrent()
  const head = await readNativeH3DeviceConfig(input)
  const envelope = await postNativeH3Control(input, `${input.publicationId}/native-device-configs/challenge`, {
    worker_id: input.workerId, key_id: input.signer.keyId,
    local_owner_config_digest: input.selection.localOwnerConfigDigest, expected_revision: head.device_binding_revision,
  })
  if (envelope.payload === null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) invalid()
  const payload = envelope.payload as Record<string, unknown>
  if (typeof payload.contract_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.contract_sha256)) invalid()
  const proposed = head.local_owner_config_digest === input.selection.localOwnerConfigDigest
    ? head.device_binding_revision : head.device_binding_revision + 1
  const tuple = nativeH3ExpectedDeviceTuple(input.selection.declaration, { publicationId: input.publicationId,
    ownerId: input.ownerId, deviceId: input.workerId, sourceDigest: input.selection.sourceDigest,
    contractSha256: payload.contract_sha256 }, { localOwnerConfigDigest: input.selection.localOwnerConfigDigest,
    deviceBindingRevision: proposed })
  if (tuple.contract_version !== 'v2') invalid()
  const challenge = verifyNativeH3DeviceConfigChallengeV2(envelope, tuple, input.challengeKeys, Math.floor(Date.now() / 1000))
  if (challenge.payload.expected_revision !== head.device_binding_revision
    || challenge.payload.connection_id !== input.connectionId || challenge.payload.key_id !== input.signer.keyId
    || input.signer.ownerId !== input.ownerId || input.signer.workerId !== input.workerId) invalid()
  await input.assertLocalCurrent()
  await input.assertCurrent()
  const signature = input.signer.signConfig(challenge, input.connectionId)
  await input.observeConfig({ challengeId: challenge.payload.challenge_id, signature })
  await input.assertLocalCurrent()
  const registered = parseHead(await postNativeH3Control(input, `${input.publicationId}/native-device-configs/register`, {
    worker_id: input.workerId, challenge_id: challenge.payload.challenge_id, signature,
  }), input.publicationId, input.workerId, input.selection)
  if (registered.status !== 'registered' || registered.device_binding_revision !== proposed
    || registered.local_owner_config_digest !== input.selection.localOwnerConfigDigest) invalid()
  await input.assertLocalCurrent()
  return registered
}
