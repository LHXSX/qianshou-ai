/** Distinct native-device and installed-product confirmations at the Remote boundary. */
import type { GenericAuthorOrderSkillActivation, NativeAuthorOrderSkillActivation } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocalOrderSkillEligibility } from './local-skills-controller.ts'
import type { OrderPublicationItem } from './order-publication-controller.ts'

type Identity = 'source' | 'name' | 'publicationId' | 'deviceId' | 'runtimeDigest' | 'dispatchEligible'
type ActivationConfirmation = (Pick<GenericAuthorOrderSkillActivation, Identity | 'productId' | 'deviceInstalled'>
  | Pick<NativeAuthorOrderSkillActivation, Identity | 'runtimeKind' | 'deviceVerified'>)
  & { readonly order: { readonly mode: 'idle' | 'allowed'; readonly enabledServiceIds: readonly string[] } }
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const SHA = /^sha256:[a-f0-9]{64}$/u

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Validate the selected identity and explicit native/device or generic/install evidence.
 * @param value - Untrusted serialized Host confirmation.
 * @param source - Current controlled local source.
 * @param name - Current owner-selected skill identity.
 * @returns Whether the receipt confirms this exact activation and saved node permission.
 */
export function confirmedAuthorActivation(value: unknown, source: 'user-dsh' | 'user-agents',
  name: string): value is ActivationConfirmation {
  const row = record(value)
  const order = record(row?.order)
  if (row === null || row.source !== source || row.name !== name || row.dispatchEligible !== true
    || typeof row.publicationId !== 'string' || !UUID.test(row.publicationId)
    || typeof row.deviceId !== 'string' || !UUID.test(row.deviceId)
    || typeof row.runtimeDigest !== 'string' || !SHA.test(row.runtimeDigest)
    || order === null || !['idle', 'allowed'].includes(String(order.mode))
    || !Array.isArray(order.enabledServiceIds) || !order.enabledServiceIds.every(id => typeof id === 'string')
    || !order.enabledServiceIds.includes('node')) return false
  if ('runtimeKind' in row) return row.runtimeKind === 'native-h3' && row.deviceVerified === true
    && !('productId' in row) && !('deviceInstalled' in row)
  return row.deviceInstalled === true && typeof row.productId === 'string' && UUID.test(row.productId)
}

/** A native approval needs current local declaration evidence; ordinary products retain their listing gate.
 * @param publication - Current owner-checked publication projection.
 * @param eligible - Host-identified declaration for the same installed local skill.
 * @param productStatus - Existing ordinary product listing state.
 * @returns Whether this publication exposes the explicit author-enable action.
 */
export function canEnableAuthorPublication(publication: OrderPublicationItem | undefined,
  eligible: LocalOrderSkillEligibility | undefined, productStatus: string | null | undefined): boolean {
  if (publication?.phase !== 'approved' || publication.reviewSyncStale === true) return false
  if (publication.runtimeKind === 'native-h3') return eligible?.runtimeKind === 'native-h3'
    && publication.archiveStatus === 'confirmed' && (publication.reviewReasons?.length ?? 0) === 0
    && publication.lifecycle?.archived !== true
    && (publication.lifecycle === undefined || publication.lifecycle.state === 'active')
  return productStatus === 'published'
}
