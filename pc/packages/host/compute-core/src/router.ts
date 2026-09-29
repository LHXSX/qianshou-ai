/**
 * Pure control-plane routing for the Qianshou capability network.
 *
 * The router is deliberately separate from execution and transport. It only
 * turns an owner-authorized intent and observed node offers into an explainable
 * plan. Applying a lease, charging a quote, loading a plugin, and running a
 * model remain downstream effects owned by their existing services.
 */
import { ComputeError } from './errors.ts'

export const QIANSHOU_INTENT_VERSION = 'qianshou.intent.v1' as const
export const QIANSHOU_ROUTE_VERSION = 'qianshou.route.v1' as const

export type RouterDataScope = 'none' | 'task-inputs' | 'workspace'
export type RouterPrivacy = 'private' | 'shared'

/** A semantic request produced by the conversation/intent layer. */
export interface RouterIntent {
  readonly version: typeof QIANSHOU_INTENT_VERSION
  readonly intentId: string
  readonly capabilityId: string
  /** Exact plugin version when a workflow pins one; omitted means compatible versions. */
  readonly capabilityVersion?: string
  /** Minimum version from the wire intent contract; higher compatible versions are allowed. */
  readonly minimumCapabilityVersion?: string
  /** Model ids are internal implementation ids, never a user-facing provider name. */
  readonly requiredModelIds?: readonly string[]
  readonly requiredPlatform?: string
  readonly minVramBytes?: number
  readonly dataScope: RouterDataScope
  readonly privacy: RouterPrivacy
  readonly ownerAuthorization: 'approved' | 'pending' | 'denied'
  readonly allowedNodeIds?: readonly string[]
  readonly requiredPluginDigest?: string
  readonly budgetMinor: number
  readonly currency: 'CNY'
  readonly deadlineAt: string
  readonly idempotencyKey: string
}

/** One capability/node observation from the Shanghai capability pool. */
export interface RouterNodeOffer {
  readonly offerId: string
  readonly nodeId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly pluginDigest: string
  readonly health: 'ok' | 'degraded' | 'missing'
  readonly available: boolean
  readonly ownerAuthorized: boolean
  readonly platform: string
  readonly modelIds: readonly string[]
  readonly vramBytes: number
  readonly dataScopes: readonly RouterDataScope[]
  readonly privacy: RouterPrivacy
  readonly queueDepth: number
  readonly maxConcurrency: number
  readonly runningTasks: number
  readonly estimatedLatencyMs: number
  readonly priceMinor: number
  readonly currency: 'CNY'
  readonly successRate: number
  readonly observedAt: string
  readonly expiresAt: string
}

export type RouterRejectionCode =
  | 'OWNER_AUTHORIZATION_REQUIRED'
  | 'CAPABILITY_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'PLUGIN_DIGEST_MISMATCH'
  | 'MODEL_UNAVAILABLE'
  | 'PLATFORM_MISMATCH'
  | 'VRAM_INSUFFICIENT'
  | 'DATA_SCOPE_UNAVAILABLE'
  | 'PRIVACY_MISMATCH'
  | 'NODE_NOT_ALLOWED'
  | 'HEALTH_UNAVAILABLE'
  | 'OFFER_UNAVAILABLE'
  | 'OFFER_EXPIRED'
  | 'QUEUE_FULL'
  | 'LATENCY_LIMIT'
  | 'BUDGET_EXCEEDED'

/** Explainable exclusion returned to the route UI and audit log. */
export interface RouterRejection {
  readonly offerId: string
  readonly nodeId: string
  readonly code: RouterRejectionCode
}

/** A candidate that survived all hard filters, with a stable ranking score. */
export interface RouterCandidate {
  readonly offerId: string
  readonly nodeId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly pluginDigest: string
  readonly priceMinor: number
  readonly estimatedLatencyMs: number
  readonly score: number
  readonly scoreBreakdown: Readonly<{
    health: number
    capacity: number
    latency: number
    price: number
    reliability: number
    privacy: number
  }>
}

/** A deterministic route result. It is not a lease and does not spend money. */
export interface RouterPlan {
  readonly version: typeof QIANSHOU_ROUTE_VERSION
  readonly intentId: string
  readonly status: 'ready' | 'no-route' | 'awaiting-authorization' | 'expired'
  readonly selected: RouterCandidate | null
  readonly candidates: readonly RouterCandidate[]
  readonly rejections: readonly RouterRejection[]
  readonly generatedAt: string
}

export interface RouterPlanningInput {
  readonly now: string
  readonly intent: RouterIntent
  readonly offers: readonly RouterNodeOffer[]
  readonly maxCandidates?: number
}

/**
 * Apply hard policy/resource filters first, then rank surviving offers.
 *
 * This function has no network, filesystem, plugin, or billing side effects.
 * A caller must still obtain an owner approval and create a lease before any
 * executor is invoked.
 */
export function planRoute(input: RouterPlanningInput): RouterPlan {
  const now = parseTimestamp(input.now)
  const intent = validateIntent(input.intent)
  const maxCandidates = input.maxCandidates ?? 8
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 64) {
    throw new ComputeError('COMPUTE_ROUTE_LIMIT_INVALID')
  }

  if (intent.ownerAuthorization === 'pending') return noRoute(input.now, intent, 'awaiting-authorization')
  if (intent.ownerAuthorization === 'denied') return noRoute(input.now, intent, 'awaiting-authorization')
  if (Date.parse(intent.deadlineAt) <= now) return noRoute(input.now, intent, 'expired')

  const allowedNodes = intent.allowedNodeIds ? new Set(intent.allowedNodeIds) : null
  const rejections: RouterRejection[] = []
  const candidates: RouterCandidate[] = []
  for (const rawOffer of input.offers) {
    const offer = validateOffer(rawOffer)
    const rejection = rejectOffer(intent, offer, now, allowedNodes)
    if (rejection) { rejections.push(rejection); continue }
    candidates.push(rankOffer(intent, offer))
  }
  candidates.sort((a, b) => b.score - a.score || a.estimatedLatencyMs - b.estimatedLatencyMs || a.nodeId.localeCompare(b.nodeId))
  const bounded = candidates.slice(0, maxCandidates)
  return Object.freeze({
    version: QIANSHOU_ROUTE_VERSION,
    intentId: intent.intentId,
    status: bounded.length > 0 ? 'ready' : 'no-route',
    selected: bounded[0] ?? null,
    candidates: Object.freeze(bounded),
    rejections: Object.freeze(rejections),
    generatedAt: input.now,
  })
}

function noRoute(now: string, intent: RouterIntent, status: RouterPlan['status']): RouterPlan {
  return Object.freeze({ version: QIANSHOU_ROUTE_VERSION, intentId: intent.intentId, status, selected: null, candidates: Object.freeze([]), rejections: Object.freeze([]), generatedAt: now })
}

function rejectOffer(intent: RouterIntent, offer: RouterNodeOffer, now: number, allowedNodes: Set<string> | null): RouterRejection | null {
  if (!offer.ownerAuthorized) return reject(offer, 'OWNER_AUTHORIZATION_REQUIRED')
  if (allowedNodes && !allowedNodes.has(offer.nodeId)) return reject(offer, 'NODE_NOT_ALLOWED')
  if (offer.capabilityId !== intent.capabilityId) return reject(offer, 'CAPABILITY_MISMATCH')
  if (intent.capabilityVersion && offer.capabilityVersion !== intent.capabilityVersion) return reject(offer, 'VERSION_MISMATCH')
  if (intent.minimumCapabilityVersion && compareVersion(offer.capabilityVersion, intent.minimumCapabilityVersion) < 0) return reject(offer, 'VERSION_MISMATCH')
  if (intent.requiredPluginDigest && offer.pluginDigest !== intent.requiredPluginDigest) return reject(offer, 'PLUGIN_DIGEST_MISMATCH')
  if (intent.requiredModelIds && intent.requiredModelIds.some(model => !offer.modelIds.includes(model))) return reject(offer, 'MODEL_UNAVAILABLE')
  if (intent.requiredPlatform && offer.platform !== intent.requiredPlatform) return reject(offer, 'PLATFORM_MISMATCH')
  if (intent.minVramBytes !== undefined && offer.vramBytes < intent.minVramBytes) return reject(offer, 'VRAM_INSUFFICIENT')
  if (!offer.dataScopes.includes(intent.dataScope)) return reject(offer, 'DATA_SCOPE_UNAVAILABLE')
  if (intent.privacy === 'private' && offer.privacy !== 'private') return reject(offer, 'PRIVACY_MISMATCH')
  if (offer.health === 'missing') return reject(offer, 'HEALTH_UNAVAILABLE')
  if (!offer.available) return reject(offer, 'OFFER_UNAVAILABLE')
  if (Date.parse(offer.expiresAt) <= now) return reject(offer, 'OFFER_EXPIRED')
  if (offer.runningTasks >= offer.maxConcurrency) return reject(offer, 'QUEUE_FULL')
  if (offer.estimatedLatencyMs > 0 && intent.deadlineAt && now + offer.estimatedLatencyMs > Date.parse(intent.deadlineAt)) return reject(offer, 'LATENCY_LIMIT')
  if (offer.priceMinor > intent.budgetMinor) return reject(offer, 'BUDGET_EXCEEDED')
  return null
}

function rankOffer(intent: RouterIntent, offer: RouterNodeOffer): RouterCandidate {
  const health = offer.health === 'ok' ? 1000 : 500
  const capacity = Math.round(Math.max(0, Math.min(1, (offer.maxConcurrency - offer.runningTasks - offer.queueDepth) / offer.maxConcurrency)) * 2000)
  const latency = Math.round(Math.max(0, Math.min(1, 1 - offer.estimatedLatencyMs / 60_000)) * 2000)
  const price = intent.budgetMinor === 0 ? 0 : Math.round(Math.max(0, Math.min(1, 1 - offer.priceMinor / intent.budgetMinor)) * 2000)
  const reliability = Math.round(Math.max(0, Math.min(1, offer.successRate)) * 2000)
  const privacy = intent.privacy === offer.privacy ? 1000 : 0
  return Object.freeze({
    offerId: offer.offerId,
    nodeId: offer.nodeId,
    capabilityId: offer.capabilityId,
    capabilityVersion: offer.capabilityVersion,
    pluginDigest: offer.pluginDigest,
    priceMinor: offer.priceMinor,
    estimatedLatencyMs: offer.estimatedLatencyMs,
    score: health + capacity + latency + price + reliability + privacy,
    scoreBreakdown: Object.freeze({ health, capacity, latency, price, reliability, privacy }),
  })
}

function reject(offer: RouterNodeOffer, code: RouterRejectionCode): RouterRejection { return Object.freeze({ offerId: offer.offerId, nodeId: offer.nodeId, code }) }

function validateIntent(value: RouterIntent): RouterIntent {
  if (!value || value.version !== QIANSHOU_INTENT_VERSION || !id(value.intentId) || !id(value.capabilityId) || !id(value.idempotencyKey)) throw new ComputeError('COMPUTE_INTENT_INVALID')
  if (value.capabilityVersion !== undefined && !id(value.capabilityVersion)) throw new ComputeError('COMPUTE_INTENT_INVALID')
  if (value.minimumCapabilityVersion !== undefined && !id(value.minimumCapabilityVersion)) throw new ComputeError('COMPUTE_INTENT_INVALID')
  if (value.requiredModelIds !== undefined && (!Array.isArray(value.requiredModelIds) || value.requiredModelIds.some(model => !id(model)))) throw new ComputeError('COMPUTE_INTENT_INVALID')
  if (value.requiredPlatform !== undefined && !id(value.requiredPlatform)) throw new ComputeError('COMPUTE_INTENT_INVALID')
  if (value.requiredPluginDigest !== undefined && !digest(value.requiredPluginDigest)) throw new ComputeError('COMPUTE_INTENT_INVALID')
  if (!['none', 'task-inputs', 'workspace'].includes(value.dataScope) || !['private', 'shared'].includes(value.privacy) || !['approved', 'pending', 'denied'].includes(value.ownerAuthorization)) throw new ComputeError('COMPUTE_INTENT_INVALID')
  if (value.allowedNodeIds !== undefined && (!Array.isArray(value.allowedNodeIds) || value.allowedNodeIds.some(nodeId => !id(nodeId)))) throw new ComputeError('COMPUTE_INTENT_INVALID')
  if (!Number.isSafeInteger(value.budgetMinor) || value.budgetMinor < 0 || value.currency !== 'CNY') throw new ComputeError('COMPUTE_INTENT_INVALID')
  parseTimestamp(value.deadlineAt)
  if (value.minVramBytes !== undefined && (!Number.isSafeInteger(value.minVramBytes) || value.minVramBytes < 0)) throw new ComputeError('COMPUTE_INTENT_INVALID')
  return value
}

function validateOffer(value: RouterNodeOffer): RouterNodeOffer {
  if (!value || !id(value.offerId) || !id(value.nodeId) || !id(value.capabilityId) || !id(value.capabilityVersion) || !digest(value.pluginDigest)) throw new ComputeError('COMPUTE_ROUTE_OFFER_INVALID')
  if (!['ok', 'degraded', 'missing'].includes(value.health) || typeof value.available !== 'boolean' || typeof value.ownerAuthorized !== 'boolean') throw new ComputeError('COMPUTE_ROUTE_OFFER_INVALID')
  if (!id(value.platform) || !Array.isArray(value.modelIds) || value.modelIds.some(model => !id(model)) || !Array.isArray(value.dataScopes) || !value.dataScopes.every(scope => ['none', 'task-inputs', 'workspace'].includes(scope)) || !['private', 'shared'].includes(value.privacy)) throw new ComputeError('COMPUTE_ROUTE_OFFER_INVALID')
  if (!Number.isSafeInteger(value.vramBytes) || value.vramBytes < 0 || !Number.isSafeInteger(value.queueDepth) || value.queueDepth < 0 || !Number.isSafeInteger(value.maxConcurrency) || value.maxConcurrency < 1 || !Number.isSafeInteger(value.runningTasks) || value.runningTasks < 0 || value.runningTasks > value.maxConcurrency) throw new ComputeError('COMPUTE_ROUTE_OFFER_INVALID')
  if (!Number.isFinite(value.estimatedLatencyMs) || value.estimatedLatencyMs < 0 || !Number.isSafeInteger(value.priceMinor) || value.priceMinor < 0 || value.currency !== 'CNY' || !Number.isFinite(value.successRate) || value.successRate < 0 || value.successRate > 1) throw new ComputeError('COMPUTE_ROUTE_OFFER_INVALID')
  parseTimestamp(value.observedAt); parseTimestamp(value.expiresAt)
  return value
}

function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function parseTimestamp(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_ROUTE_TIMESTAMP_INVALID')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new ComputeError('COMPUTE_ROUTE_TIMESTAMP_INVALID')
  return parsed
}

function compareVersion(left: string, right: string): number {
  const a = left.split(/[._-]/u).map(part => /^\d+$/u.test(part) ? Number(part) : part)
  const b = right.split(/[._-]/u).map(part => /^\d+$/u.test(part) ? Number(part) : part)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const leftPart = a[index] ?? 0
    const rightPart = b[index] ?? 0
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'number') return leftPart - rightPart
    return String(leftPart).localeCompare(String(rightPart))
  }
  return 0
}
