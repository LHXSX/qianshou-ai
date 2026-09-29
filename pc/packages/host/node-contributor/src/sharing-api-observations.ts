/** Fixed local adapter metadata; observing and reporting it grants no GPU or financial authority. */
import type { SharingAPIObservation, SharingAPIProbe, SharingLocalState, SharingMode } from './sharing-types.ts'
import { SHARING_UUID, sharingFail, sharingObject } from './sharing-protocol.ts'

/** Translate actual read-only local observations, never an invented model or workflow hash.
 * @param mode - The explicitly selected local product mode.
 * @param local - Existing fixed health/model/workflow GET evidence.
 * @returns Safe identifiers for Guangzhou; local addresses and filenames are excluded.
 */
export function sharingAPIObservation(mode: SharingMode, local: SharingLocalState): SharingAPIObservation {
  const identified = mode === 'image' && local.adapter === 'qianshou_image'
  const ready = identified && local.runtime === 'ready'
  return { mode, adapter: local.adapter ?? 'unidentified', status: local.runtime === 'authentication_required' ? 'auth_required'
    : local.runtime === 'ready' ? ready ? 'ready' : 'unsupported' : local.runtime,
  model: ready ? { id: 'qwen-image-2.1-int8-convrot', sha256: null, version: '2.1' } : null,
  workflow: ready ? { id: 'qianshou-qwen-image21-text-to-image', sha256: null, version: null } : null,
  observedAt: new Date((local.checkedAt ?? Math.floor(Date.now() / 1000)) * 1000).toISOString() }
}
/** Reject arbitrary operations or stale challenges before any local request is made.
 * @param value - One authenticated channel metadata challenge.
 * @param epoch - Current persisted channel epoch.
 * @returns A bounded, immutable GET-only challenge.
 */
export function parseSharingAPIProbe(value: unknown, epoch: number): SharingAPIProbe {
  const p = sharingObject(value)
  if (Object.keys(p).sort().join(',') !== 'epoch,expiresAt,kind,mode,requestId' || typeof p.requestId !== 'string'
    || !SHARING_UUID.test(p.requestId) || p.kind !== 'metadata' || p.mode !== 'image' && p.mode !== 'video'
    || p.epoch !== epoch || typeof p.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u.test(p.expiresAt)
    || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.now() || Date.parse(p.expiresAt) > Date.now() + 95000) sharingFail('RESPONSE_INVALID')
  return p as unknown as SharingAPIProbe
}
