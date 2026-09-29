/** Presence validates the actual owner binding without rendering, uploading or granting intake. */
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { parseAnyNativeH3Declaration } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { isVerifiedAnyNativeH3PresenceChallenge,
  type AnyVerifiedNativeH3PresenceChallenge } from '@deepseek-ai/dsh-compute-core/native-h3-presence'
import { nativeH3ExpectedDeviceTuple } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { nativeH3PublicBindingDigest } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import type { createH3VideoProvider } from './h3-video.ts'
import type { createH3CanonicalProvider } from './h3-canonical-provider.ts'
import { selectNativeH3Binding, type NativeH3LocalSelection } from './native-h3-publication.ts'

/** Host-only plan, with neither caller-provided identity nor a cached readiness boolean. */
export interface NativeH3PresenceRequest {
  readonly selection: NativeH3LocalSelection
  readonly publicationId: string
  readonly contractSha256: string
  readonly challenge: AnyVerifiedNativeH3PresenceChallenge
}

type Provider = Pick<ReturnType<typeof createH3VideoProvider>, 'nativeAuthorBinding'>
  & Partial<Pick<ReturnType<typeof createH3VideoProvider>, 'nativeAuthorBindingV2'>>
  & Partial<Pick<ReturnType<typeof createH3CanonicalProvider>, 'nativeAuthorBindingCanonical'>>
function invalid(): never { throw new ComputeError('H3_PRESENCE_VALIDATION_REFUSED', 409) }

/** Recheck a presence plan against the current socket and freshly read actual recipe/model identity.
 * @param provider - Fixed owner H3 preparation port; it never renders a GPU job.
 * @param request - Purpose-verified short-lived plan and exact author source selection.
 * @param identity - Current authenticated owner, ACK device and server-issued socket UUID reader.
 * @param now - Trusted epoch seconds, checked before and after preparation.
 * @returns Resolves only if the same live identity and actual native binding remain current.
 */
export async function validateNativeH3PresenceChallenge(provider: Provider, request: NativeH3PresenceRequest,
  identity: () => Promise<{ ownerId: number; deviceId: string; connectionId: string } | null>,
  now: () => number = () => Math.floor(Date.now() / 1000)): Promise<void> {
  const owner = await identity()
  if (owner === null) invalid()
  const declaration = parseAnyNativeH3Declaration(request.selection.declaration)
  const tuple = nativeH3ExpectedDeviceTuple(declaration, { publicationId: request.publicationId,
    ownerId: owner.ownerId, deviceId: owner.deviceId, contractSha256: request.contractSha256,
    sourceDigest: request.selection.sourceDigest }, request.challenge.payload.contract_version === 'v2'
    && request.selection.localOwnerConfigDigest !== undefined ? { localOwnerConfigDigest: request.selection.localOwnerConfigDigest,
      deviceBindingRevision: request.challenge.payload.device_binding_revision } : undefined)
  if (!isVerifiedAnyNativeH3PresenceChallenge(request.challenge, tuple, now())
    || request.challenge.payload.connection_id !== owner.connectionId) invalid()
  const binding = request.challenge.payload.native_binding
  if (nativeH3PublicBindingDigest(binding) !== nativeH3PublicBindingDigest(declaration)) invalid()
  // This port reads the real identity endpoint and bound prior trial on every call.
  // It does not call loadAndSelfTest() or run(), and accepts no cached readiness flag.
  const fresh = await selectNativeH3Binding(provider, { declaration, sourceDigest: request.selection.sourceDigest,
    taskDefinitionSha256: request.selection.taskDefinitionSha256 })
  if (tuple.contract_version === 'v2' && fresh.localOwnerConfigDigest !== tuple.local_owner_config_digest) invalid()
  const after = await identity()
  if (after?.ownerId !== owner.ownerId || after.deviceId !== owner.deviceId || after.connectionId !== owner.connectionId
    || !isVerifiedAnyNativeH3PresenceChallenge(request.challenge, tuple, now())) invalid()
}
