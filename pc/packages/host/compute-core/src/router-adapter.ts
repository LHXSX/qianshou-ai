/**
 * Adapter between the signed wire contracts and the in-process router.
 *
 * Wire contracts are snake_case and intentionally conservative. The planner
 * uses a richer observation (models, platform, local privacy and measured
 * capacity). This adapter is the only place that maps between the two; it
 * never creates a lease or treats a draft route as an authorization to spend.
 */
import { ComputeError } from './errors.ts'
import {
  parseCapabilityManifest,
  parseCapabilityOffer,
  parseIntentSpec,
  type CapabilityManifest,
  type CapabilityOffer,
  type IntentSpec,
  type RoutePlan,
} from './routing-contract.ts'
import { planRoute, type RouterIntent, type RouterNodeOffer, type RouterPlan } from './router.ts'

export interface RouterWireOfferObservation {
  readonly offer: CapabilityOffer | unknown
  readonly manifest: CapabilityManifest | unknown
  readonly ownerAuthorized?: boolean
  readonly vramBytes?: number
  readonly estimatedLatencyMs?: number
  readonly successRate?: number
}

export interface WireRoutePlanningInput {
  readonly intent: IntentSpec | unknown
  readonly offers: readonly RouterWireOfferObservation[]
  readonly now: string
  readonly routeId?: string
  readonly revision?: number
  readonly maxCandidates?: number
}

export interface WireRoutePlanningResult {
  readonly status: 'quoted' | 'awaiting-authorization' | 'no-route' | 'expired'
  /** A quote can be shown before the owner approves the actual lease. */
  readonly requiresConfirmation: boolean
  readonly plan: RoutePlan | null
  readonly internalPlans: readonly RouterPlan[]
}

/** Convert and plan every required capability in a wire intent. */
export function planWireRoute(input: WireRoutePlanningInput): WireRoutePlanningResult {
  const intent = parseIntentSpec(input.intent)
  parseTimestamp(input.now)
  const offerIds = new Set<string>()
  for (const observation of input.offers) {
    const offer = parsedOffer(observation)
    if (offerIds.has(offer.offer_id)) throw new ComputeError('COMPUTE_ROUTE_OFFER_DUPLICATE')
    offerIds.add(offer.offer_id)
  }
  const routerOffers = input.offers.map(toRouterOffer)
  const required = intent.requires.filter(requirement => !requirement.optional)
  if (required.length === 0) throw new ComputeError('COMPUTE_ROUTE_INTENT_HAS_NO_REQUIRED_CAPABILITY')

  const internalPlans = required.map(requirement => {
    const routerIntent = toRouterIntent(intent, requirement.capability_id, requirement.min_version, input.now)
    return planRoute(input.maxCandidates === undefined
      ? { now: input.now, intent: routerIntent, offers: routerOffers }
      : { now: input.now, intent: routerIntent, offers: routerOffers, maxCandidates: input.maxCandidates })
  })
  const firstNonReady = internalPlans.find(plan => plan.status !== 'ready')
  if (firstNonReady?.status === 'awaiting-authorization') return result('awaiting-authorization', intent.confirmation === 'required', internalPlans)
  if (firstNonReady?.status === 'expired') return result('expired', intent.confirmation === 'required', internalPlans)
  if (firstNonReady) return result('no-route', intent.confirmation === 'required', internalPlans)

  const revision = input.revision ?? 1
  if (!Number.isSafeInteger(revision) || revision < 1) throw new ComputeError('COMPUTE_ROUTE_REVISION_INVALID')
  const steps = internalPlans.map((planned, index) => {
    const requirement = required[index]
    const selected = planned.selected
    if (!selected || !requirement) throw new ComputeError('COMPUTE_ROUTE_PLAN_INCOMPLETE')
    const selectedObservation = input.offers.find(item => parsedOffer(item).offer_id === selected.offerId)
    const selectedOffer = selectedObservation ? parsedOffer(selectedObservation).offer_id : selected.offerId
    const manifestRevision = selectedObservation ? parsedManifest(selectedObservation).revision : 1
    const candidates = planned.candidates.map(candidate => ({ offer_id: candidate.offerId, node_id: candidate.nodeId, score: candidate.score / 10000, eligible: true, reason_codes: ['HARD_FILTERS_PASSED'] }))
    const rejected = planned.rejections.map(rejection => ({ offer_id: rejection.offerId, node_id: rejection.nodeId, score: 0, eligible: false, reason_codes: [rejection.code] }))
    const combined = [...candidates, ...rejected]
    const expiresAt = selectedObservation ? parsedOffer(selectedObservation).availability.expires_at : input.now
    return {
      step_id: `step-${index + 1}`,
      capability_id: requirement.capability_id,
      capability_version: selected.capabilityVersion,
      input_refs: intent.inputs.map(item => item.ref),
      output_kind: intent.output.kind,
      candidates: combined,
      selected: { offer_id: selectedOffer, node_id: selected.nodeId, manifest_revision: manifestRevision },
      privacy: { data_residency: intent.privacy.data_residency, network_egress: intent.privacy.allow_remote ? 'declared' as const : 'denied' as const },
      fallback_offer_ids: planned.candidates.slice(1).map(candidate => candidate.offerId),
      expiresAt,
    }
  })
  const quoteAmount = steps.reduce((total, step) => total + (parsedOffer(input.offers.find(item => parsedOffer(item).offer_id === step.selected.offer_id) as RouterWireOfferObservation).price.amount_minor), 0)
  const quoteExpiresAt = steps.map(step => step.expiresAt).sort()[0] ?? input.now
  const route: RoutePlan = {
    contract: 'qianshou/route-plan/v1',
    route_id: input.routeId ?? `route-${intent.intent_id}-${revision}`,
    intent_id: intent.intent_id,
    revision,
    status: 'quoted',
    steps: steps.map(({ expiresAt: _expiresAt, ...step }) => step),
    quote: { amount_minor: quoteAmount, currency: intent.budget.currency, unit: 'step', expires_at: quoteExpiresAt },
    explanation: Object.freeze([
      ...steps.map(step => `${step.capability_id} matched ${step.selected.node_id}; owner approval and lease are still required`),
      ...(intent.confirmation === 'required' ? ['主人确认是报价后的独立步骤，当前结果不会创建租约或扣费'] : []),
    ]),
  }
  return Object.freeze({ status: 'quoted', requiresConfirmation: intent.confirmation === 'required', plan: route, internalPlans: Object.freeze(internalPlans) })
}

function result(status: WireRoutePlanningResult['status'], requiresConfirmation: boolean, internalPlans: readonly RouterPlan[]): WireRoutePlanningResult {
  return Object.freeze({ status, requiresConfirmation, plan: null, internalPlans: Object.freeze([...internalPlans]) })
}

function toRouterIntent(intent: IntentSpec, capabilityId: string, minimumCapabilityVersion: string, now: string): RouterIntent {
  const deadline = new Date(Date.parse(now) + intent.deadline_s * 1000).toISOString()
  return {
    version: 'qianshou.intent.v1',
    intentId: intent.intent_id,
    capabilityId,
    minimumCapabilityVersion,
    ...(intent.preferences.platforms.length === 1 && intent.preferences.platforms[0] !== undefined ? { requiredPlatform: intent.preferences.platforms[0] } : {}),
    dataScope: 'task-inputs',
    privacy: intent.privacy.level === 'strict' || !intent.privacy.allow_remote ? 'private' : 'shared',
    // Confirmation is a post-quote lease gate. It must not hide eligible
    // candidates or prevent the user from seeing a truthful quote.
    ownerAuthorization: 'approved',
    ...(intent.preferences.node_ids.length > 0 ? { allowedNodeIds: intent.preferences.node_ids } : {}),
    budgetMinor: intent.preferences.max_price_minor ?? intent.budget.amount_minor,
    currency: 'CNY',
    deadlineAt: deadline,
    idempotencyKey: intent.request_id,
  }
}

function toRouterOffer(observation: RouterWireOfferObservation): RouterNodeOffer {
  const offer = parsedOffer(observation)
  const manifest = parsedManifest(observation)
  if (offer.manifest_id !== manifest.manifest_id || offer.manifest_revision !== manifest.revision || !manifest.capabilities.some(capability => capability.capability_id === offer.capability_id && capability.version === offer.capability_version)) throw new ComputeError('COMPUTE_ROUTE_OFFER_BINDING_INVALID')
  if (offer.price.currency !== 'CNY') throw new ComputeError('COMPUTE_ROUTE_CURRENCY_INVALID')
  const degraded = offer.status === 'degraded' || manifest.health === 'degraded'
  const available = (offer.status === 'available' || degraded) && ['available', 'degraded'].includes(manifest.health)
  return {
    offerId: offer.offer_id,
    nodeId: offer.node_id,
    capabilityId: offer.capability_id,
    capabilityVersion: offer.capability_version,
    pluginDigest: manifest.digest,
    health: available ? (degraded ? 'degraded' : 'ok') : 'missing',
    available,
    ownerAuthorized: observation.ownerAuthorized ?? offer.acceptance !== 'off',
    platform: manifest.execution.platforms[0] ?? 'unknown',
    modelIds: manifest.execution.models,
    vramBytes: observation.vramBytes ?? 0,
    dataScopes: ['none', 'task-inputs', ...(manifest.permissions.some(permission => permission === 'workspace.read' || permission === 'workspace.write') ? ['workspace' as const] : [])],
    privacy: manifest.privacy.data_residency === 'local' && manifest.privacy.network_egress === 'denied' && offer.privacy.data_residency === 'local' ? 'private' : 'shared',
    queueDepth: offer.availability.queue_depth,
    maxConcurrency: offer.availability.max_concurrency,
    // The wire offer carries queue depth but not a separate running count. Keep
    // that absence explicit; the planner still penalizes queued work.
    runningTasks: 0,
    estimatedLatencyMs: observation.estimatedLatencyMs ?? offer.limits.max_duration_s * 1000,
    priceMinor: offer.price.amount_minor,
    currency: 'CNY',
    successRate: observation.successRate ?? 0.5,
    observedAt: manifest.observed_at,
    expiresAt: offer.availability.expires_at,
  }
}

function parsedOffer(observation: RouterWireOfferObservation): CapabilityOffer { return parseCapabilityOffer(observation.offer) }
function parsedManifest(observation: RouterWireOfferObservation): CapabilityManifest { return parseCapabilityManifest(observation.manifest) }
function parseTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_ROUTE_TIMESTAMP_INVALID')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new ComputeError('COMPUTE_ROUTE_TIMESTAMP_INVALID')
  return parsed
}
