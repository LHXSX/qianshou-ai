import { describe, expect, it } from 'vitest'
import { ComputeError } from '../src/errors.ts'
import { parseCapabilityManifest, parseCapabilityOffer, parseIntentSpec, parseRoutePlan } from '../src/routing-contract.ts'

const signature = { algorithm: 'ed25519' as const, key_id: 'node-key', value: 'signature' }
const manifest = {
  contract: 'qianshou/capability-manifest/v1', manifest_id: 'm-1', plugin_id: 'qianshou.image', plugin_version: '1.0.0', revision: 1,
  capabilities: [{ capability_id: 'image.generate', version: '1.0.0', input_schema_ref: 'schema:in', output_schema_ref: 'schema:out', input_kinds: ['text'], output_kinds: ['image'], streaming: true, cancellation: true }],
  execution: { location: 'local', platforms: ['windows'], architectures: ['x86_64'], models: ['h3', 'z-ming'] }, risk_level: 'workspace-write', permissions: ['workspace.read'], privacy: { data_residency: 'local', network_egress: 'denied', retention: 'task' }, limits: { max_concurrency: 1, max_input_bytes: 100, max_output_bytes: 200 }, health: 'available', heartbeat_seq: 1, ttl_s: 60, observed_at: '2026-09-20T00:00:00Z', digest: 'a'.repeat(64), signature,
}
const offer = {
  contract: 'qianshou/offer/v1', offer_id: 'o-1', node_id: 'n-1', owner_id: 'a-1', manifest_id: 'm-1', manifest_revision: 1, capability_id: 'image.generate', capability_version: '1.0.0', visibility: 'public', acceptance: 'auto', status: 'available', price: { amount_minor: 10, currency: 'CNY', unit: 'run' }, availability: { heartbeat_seq: 1, expires_at: '2026-09-20T00:01:00Z', queue_depth: 0, max_concurrency: 1 }, privacy: { data_residency: 'local', network_egress: 'denied' }, limits: { max_input_bytes: 100, max_output_bytes: 200, max_duration_s: 60 }, signature,
}
const intent = {
  contract: 'qianshou/intent/v1', intent_id: 'i-1', request_id: 'r-1', account_id: 'a-1', goal: 'make image', domain: 'image', modalities: ['image'], requires: [{ capability_id: 'image.generate', min_version: '1.0.0', optional: false }], inputs: [{ kind: 'inline', ref: 'prompt', media_type: 'text/plain' }], output: { kind: 'image', format: 'png' }, budget: { amount_minor: 10, currency: 'CNY' }, deadline_s: 60, privacy: { level: 'strict', allow_remote: false, data_residency: 'local' }, preferences: { prefer_local: true, node_ids: [], platforms: [] }, fallback: { allow_replan: true, allow_degraded: false, max_attempts: 2 }, confirmation: 'required',
}
const route = {
  contract: 'qianshou/route-plan/v1', route_id: 'route-1', intent_id: 'i-1', revision: 1, status: 'quoted', steps: [{ step_id: 's-1', capability_id: 'image.generate', capability_version: '1.0.0', input_refs: ['prompt'], output_kind: 'image', candidates: [{ offer_id: 'o-1', node_id: 'n-1', score: 1, eligible: true, reason_codes: ['MATCH'] }], selected: { offer_id: 'o-1', node_id: 'n-1', manifest_revision: 1 }, privacy: { data_residency: 'local', network_egress: 'denied' }, fallback_offer_ids: [] }], quote: { amount_minor: 10, currency: 'CNY', unit: 'run', expires_at: '2026-09-20T00:01:00Z' }, explanation: ['local model matched'],
}

describe('routing contract parsers', () => {
  it('parse and deeply freeze all four wire contracts', () => {
    const parsed = [parseCapabilityManifest(manifest), parseCapabilityOffer(offer), parseIntentSpec(intent), parseRoutePlan(route)]
    for (const value of parsed) expect(Object.isFrozen(value)).toBe(true)
    expect(parseCapabilityManifest(manifest).execution.models).toEqual(['h3', 'z-ming'])
  })

  it('rejects expired or unsafe numeric values at the host boundary', () => {
    expect(() => parseCapabilityManifest({ ...manifest, ttl_s: 0 })).toThrow('COMPUTE_ROUTING_CONTRACT_INVALID')
    expect(() => parseCapabilityOffer({ ...offer, price: { ...offer.price, amount_minor: -1 } })).toThrow(ComputeError)
    expect(() => parseIntentSpec({ ...intent, deadline_s: Number.POSITIVE_INFINITY })).toThrow(ComputeError)
  })

  it('requires the selected route target to be explicitly eligible', () => {
    expect(() => parseRoutePlan({ ...route, steps: [{ ...route.steps[0]!, candidates: [{ ...route.steps[0]!.candidates[0]!, eligible: false }] }] })).toThrow('COMPUTE_ROUTING_CONTRACT_INVALID')
    expect(() => parseRoutePlan({ ...route, steps: [{ ...route.steps[0]!, selected: { ...route.steps[0]!.selected, offer_id: 'unknown' } }] })).toThrow('COMPUTE_ROUTING_CONTRACT_INVALID')
  })

  it('does not accept a manifest with duplicate capability versions', () => {
    expect(() => parseCapabilityManifest({ ...manifest, capabilities: [manifest.capabilities[0], manifest.capabilities[0]] })).toThrow('COMPUTE_ROUTING_CONTRACT_INVALID')
  })
})
