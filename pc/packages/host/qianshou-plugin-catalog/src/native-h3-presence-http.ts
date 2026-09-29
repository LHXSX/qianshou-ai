/** Renew an approved native binding against the actual current socket; no GPU sample is rerun. */
import { createHash, type KeyObject } from 'node:crypto'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { verifyAnyNativeH3PresenceChallenge,
  type AnyVerifiedNativeH3PresenceChallenge } from '@deepseek-ai/dsh-compute-core/native-h3-presence'
import { verifyAnyNativeH3DeviceProof, nativeH3ExpectedDeviceTuple, type AnyVerifiedNativeH3DeviceProof as VerifiedNativeH3DeviceProof }
  from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import type { AnyNativeH3Declaration as NativeH3Declaration } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import type { NativeH3DeviceIdentity } from './native-h3-device-identity.ts'
import { postNativeH3Control, type NativeH3ReviewControl } from './native-h3-review-http.ts'
import { CatalogFailure } from './registry.ts'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA = /^[a-f0-9]{64}$/u
/** Immutable local source and task-definition identity selected for a connection-bound presence renewal. */
export interface NativeH3PresenceSelection {
  readonly declaration: NativeH3Declaration
  readonly sourceDigest: string
  readonly taskDefinitionSha256: string
  readonly localOwnerConfigDigest?: string
  readonly deviceBindingRevision?: number
}
function invalid(): never { throw new CatalogFailure('order-review-samples-unavailable') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

/** Verify and witness presence renewal on the same authenticated worker connection without rerunning GPU samples.
 * @param input - Current control identity, signer, source, connection, purpose keys and validation/socket ports.
 * @returns Attestor-verified device proof matching the signed challenge and witnessed presence payload.
 */
export async function renewNativeH3DevicePresence(input: NativeH3ReviewControl & {
  signer: NativeH3DeviceIdentity
  selection: NativeH3PresenceSelection
  publicationId: string
  connectionId: string
  challengeKeys: ReadonlyMap<string, KeyObject>
  attestorKeys: ReadonlyMap<string, KeyObject>
  validate(input: {
    selection: NativeH3PresenceSelection
    publicationId: string
    contractSha256: string
    challenge: AnyVerifiedNativeH3PresenceChallenge
  }): Promise<void>
  observePresence(input: { challengeNonce: string; signature: string }): Promise<void>
}): Promise<VerifiedNativeH3DeviceProof> {
  if (!UUID.test(input.publicationId) || !UUID.test(input.connectionId)
    || input.signer.ownerId !== input.ownerId || input.signer.workerId !== input.workerId
    || input.challengeKeys.size === 0 || input.attestorKeys.size === 0) invalid()
  const envelope = await postNativeH3Control(input, `${input.publicationId}/native-device-presence/challenge`, {
    worker_id: input.workerId, key_id: input.signer.keyId,
  })
  const payload = record(envelope.payload)
  if (typeof payload.contract_sha256 !== 'string' || !SHA.test(payload.contract_sha256)) invalid()
  const tuple = nativeH3ExpectedDeviceTuple(input.selection.declaration, { publicationId: input.publicationId,
    ownerId: input.ownerId, deviceId: input.workerId, contractSha256: payload.contract_sha256,
    sourceDigest: input.selection.sourceDigest }, input.selection.localOwnerConfigDigest !== undefined
    && input.selection.deviceBindingRevision !== undefined ? { localOwnerConfigDigest: input.selection.localOwnerConfigDigest,
      deviceBindingRevision: input.selection.deviceBindingRevision } : undefined)
  const challenge = verifyAnyNativeH3PresenceChallenge(envelope, tuple, input.challengeKeys, Math.floor(Date.now() / 1000))
  if (challenge.payload.device_key_id !== input.signer.keyId
    || challenge.payload.connection_id !== input.connectionId) invalid()
  await input.assertCurrent()
  await input.validate({ selection: input.selection, publicationId: input.publicationId,
    contractSha256: tuple.contract_sha256, challenge })
  await input.assertCurrent()
  const presence = input.signer.signPresence(challenge, input.connectionId)
  await input.observePresence({ challengeNonce: challenge.payload.challenge_nonce, signature: presence.signature })
  await input.assertCurrent()
  const reply = await postNativeH3Control(input, `${input.publicationId}/native-device-presence/report`, {
    worker_id: input.workerId, challenge_nonce: challenge.payload.challenge_nonce, signature: presence.signature,
  })
  if (Object.keys(reply).sort().join(',') !== 'device_proof,publication_id,schema,worker_id'
    || reply.schema !== `qianshou.native-h3-device-presence-result.${input.selection.declaration.contractVersion}`
    || reply.publication_id !== input.publicationId || reply.worker_id !== input.workerId) invalid()
  const proof = verifyAnyNativeH3DeviceProof(reply.device_proof, tuple, input.attestorKeys, Math.floor(Date.now() / 1000))
  const digest = (value: unknown): string => createHash('sha256').update(canonicalNativeH3ReviewJson(value)).digest('hex')
  if (proof.payload.challenge_nonce !== challenge.payload.challenge_nonce
    || proof.payload.challenge_input_sha256 !== digest(challenge.payload)
    || proof.payload.challenge_result_sha256 !== digest(presence.payload)) invalid()
  return proof
}
