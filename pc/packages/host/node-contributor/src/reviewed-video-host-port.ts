/** Optional product Host provider for one independently reviewed video installation. */
import type { KeyObject } from 'node:crypto'
import type { ResidentComfyVideoConsumerPorts } from './comfy-video-resident-consumer.ts'
import type { SignedReviewedVideoOfferPort } from './reviewed-video-signed-order.ts'
import type { ReviewedVideoSupplyPorts } from './reviewed-video-supply-proof.ts'

/** The Host owns every resource here; buyer parameters and catalog labels cannot provide them. */
export interface ReviewedVideoHostPort {
  readonly offer: SignedReviewedVideoOfferPort
  readonly consumerPorts: Omit<ResidentComfyVideoConsumerPorts,
    'fileUpload' | 'readSignedOrder' | 'readVersionedFirstFrame'>
  readonly storageOrigin: URL
  readonly controlOrigin: URL
  readonly evidenceEndpoint: URL
  readonly evidenceBucket: string
  readonly attestorPublicKeys: Readonly<Record<string, string | KeyObject>>
  readonly supply: Omit<ReviewedVideoSupplyPorts, 'sendUpdate'>
  /** Recover the durable attempt ledger and verify actual Comfy/ffprobe before any server update. */
  readonly proveLocalReady: (signal: AbortSignal) => Promise<void>
}

function method(value: object, name: string): boolean { return typeof Reflect.get(value, name) === 'function' }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reject a partial optional service before it can enter product Edge construction.
 * @param value - Optional Cordis service read by the product plugin.
 * @returns A complete provider, or null when any local execution dependency is absent.
 */
export function reviewedVideoHostPortOf(value: unknown): ReviewedVideoHostPort | null {
  if (!object(value) || !object(value.consumerPorts)) return null
  const consumerPorts = value.consumerPorts
  if (!object(consumerPorts.bridge)) return null
  const bridge = consumerPorts.bridge
  if (!object(bridge.ledger)) return null
  const ledger = bridge.ledger
  if (!object(value.offer)
    || !object(value.supply) || !object(value.attestorPublicKeys)
    || !method(value.offer, 'verifyOffer') || !method(value.offer, 'readSignedOrder')
    || typeof value.offer.taskType !== 'string'
    || !method(consumerPorts, 'ownerAccountId') || !method(consumerPorts, 'runtime')
    || !method(bridge, 'readCurrentInstallation')
    || !method(bridge, 'readCurrentPublication')
    || !method(bridge, 'assertOrderPublication')
    || !method(bridge, 'assertOrderOwnership')
    || !method(bridge, 'assertTaskValues')
    || !method(bridge, 'assertRuntimeCurrent')
    || !method(bridge, 'withGpuReservation')
    || !object(bridge.drafts)
    || !method(bridge.drafts, 'readPrivate')
    || !['reserve', 'assertReserved', 'beforePromptSubmit', 'recordPromptId', 'recordLocalResult']
      .every(name => method(ledger, name))
    || !method(value.supply, 'readCurrent') || !method(value.supply, 'signDevice')
    || !method(value.supply, 'readSampleAttestation') || !method(value, 'proveLocalReady')
    || !(value.storageOrigin instanceof URL) || !(value.controlOrigin instanceof URL)
    || !(value.evidenceEndpoint instanceof URL) || typeof value.evidenceBucket !== 'string'
    || value.evidenceBucket.length < 1 || Object.keys(value.attestorPublicKeys).length < 1) return null
  return value as unknown as ReviewedVideoHostPort
}
