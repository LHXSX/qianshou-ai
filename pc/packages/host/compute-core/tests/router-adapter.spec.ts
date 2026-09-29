import { describe, expect, it } from 'vitest'
import { planWireRoute } from '../src/router-adapter.ts'

const signature = { algorithm: 'ed25519' as const, key_id: 'node-key', value: 'signature' }
const manifest = {
  contract: 'qianshou/capability-manifest/v1', manifest_id: 'manifest-1', plugin_id: 'qianshou.image', plugin_version: '1.0.0', revision: 1,
  capabilities: [{ capability_id: 'image.generate', version: '1.2.0', input_schema_ref: 'schema:in', output_schema_ref: 'schema:out', input_kinds: ['text'], output_kinds: ['image'], streaming: true, cancellation: true }],
  execution: { location: 'local', platforms: ['windows'], architectures: ['x86_64'], models: ['h3', 'z-ming'] },
  risk_level: 'workspace-write', permissions: ['workspace.read'], privacy: { data_residency: 'local', network_egress: 'denied', retention: 'task' },
  limits: { max_concurrency: 2, max_input_bytes: 1000, max_output_bytes: 2000 }, health: 'available', heartbeat_seq: 1, ttl_s: 60,
  observed_at: '2026-09-20T10:00:00.000Z', digest: 'a'.repeat(64), signature,
}
const offer = {
  contract: 'qianshou/offer/v1', offer_id: 'offer-1', node_id: 'node-1', owner_id: 'owner-1', manifest_id: 'manifest-1', manifest_revision: 1,
  capability_id: 'image.generate', capability_version: '1.2.0', visibility: 'private', acceptance: 'auto', status: 'available',
  price: { amount_minor: 300, currency: 'CNY', unit: 'run' }, availability: { heartbeat_seq: 1, expires_at: '2026-09-20T10:01:00.000Z', queue_depth: 0, max_concurrency: 2 },
  privacy: { data_residency: 'local', network_egress: 'denied' }, limits: { max_input_bytes: 1000, max_output_bytes: 2000, max_duration_s: 60 }, signature,
}
const intent = {
  contract: 'qianshou/intent/v1', intent_id: 'intent-1', request_id: 'request-1', account_id: 'owner-1', goal: '生成商品图', domain: 'ecommerce', modalities: ['image'],
  requires: [{ capability_id: 'image.generate', min_version: '1.0.0', optional: false }], inputs: [{ kind: 'inline', ref: 'prompt', media_type: 'text/plain' }], output: { kind: 'image', format: 'png' },
  budget: { amount_minor: 1000, currency: 'CNY' }, deadline_s: 300, privacy: { level: 'strict', allow_remote: false, data_residency: 'local' }, preferences: { prefer_local: true, node_ids: [], platforms: ['windows'] },
  fallback: { allow_replan: true, allow_degraded: false, max_attempts: 1 }, confirmation: 'preapproved',
}

describe('planWireRoute', () => {
  it('converts signed wire observations into a quoted route plan', () => {
    const result = planWireRoute({ now: '2026-09-20T10:00:00.000Z', intent, offers: [{ offer, manifest, vramBytes: 16 * 1024 ** 3, successRate: 0.95 }] })
    expect(result.status).toBe('quoted')
    expect(result.plan).toMatchObject({ contract: 'qianshou/route-plan/v1', status: 'quoted', quote: { amount_minor: 300 } })
    expect(result.plan?.steps[0]?.selected).toMatchObject({ offer_id: 'offer-1', node_id: 'node-1', manifest_revision: 1 })
  })

  it('returns a truthful quote while keeping confirmation as a separate non-spending lease gate', () => {
    const result = planWireRoute({ now: '2026-09-20T10:00:00.000Z', intent: { ...intent, confirmation: 'required' }, offers: [{ offer, manifest }] })
    expect(result.status).toBe('quoted')
    expect(result.requiresConfirmation).toBe(true)
    expect(result.plan?.status).toBe('quoted')
  })

  it('honors the wire minimum version without pinning an exact higher version', () => {
    const result = planWireRoute({ now: '2026-09-20T10:00:00.000Z', intent: { ...intent, requires: [{ ...intent.requires[0], min_version: '1.2.0' }] }, offers: [{ offer, manifest }] })
    expect(result.status).toBe('quoted')
  })

  it('rejects stale offer-to-manifest bindings before planning', () => {
    expect(() => planWireRoute({ now: '2026-09-20T10:00:00.000Z', intent, offers: [{ offer: { ...offer, manifest_revision: 2 }, manifest }] })).toThrow('COMPUTE_ROUTE_OFFER_BINDING_INVALID')
  })
})
