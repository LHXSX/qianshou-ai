/** Device-first Agent Router: choose local or cloud execution before dispatch.
 *
 * This planner is pure and side-effect free. It does not call a model, open a
 * desktop app, create a lease or send anything to Shanghai. A cloud decision
 * is only a hand-off target for the existing Qianshou Router/Core path; a local
 * decision is only a hand-off target for the owner-installed local adapter.
 */
import { ComputeError } from './errors.ts'

export const AGENT_ROUTER_VERSION = 'qianshou.agent-router.v1' as const

export type AgentRouterComplexity = 'simple' | 'complex'
export type AgentRouterPrivacy = 'private' | 'shared'
export type AgentRouterNetwork = 'online' | 'metered' | 'offline' | 'unknown'
export type AgentRouterInteraction = 'realtime' | 'deferred'
export type AgentRouterTarget = 'local' | 'cloud'
export type AgentRouterPath = AgentRouterTarget | 'ask_user' | 'defer'

export interface AgentRouterIntent {
  readonly version: typeof AGENT_ROUTER_VERSION
  readonly intentId: string
  readonly interaction: AgentRouterInteraction
  readonly complexity: AgentRouterComplexity
  readonly privacy: AgentRouterPrivacy
  readonly network: AgentRouterNetwork
  readonly requiresCrossApp: boolean
  readonly requiredCapabilities: readonly string[]
  readonly localModelIds?: readonly string[]
  readonly localAvailable: boolean
  readonly cloudAvailable: boolean
  /** Explicit user policy permitting private input to leave the device. */
  readonly cloudAuthorization: 'approved' | 'pending' | 'denied'
  /** Explicitly allow a local degraded fallback when cloud is unavailable. */
  readonly allowLocalFallback: boolean
}

export type AgentRouterReasonCode =
  | 'LOCAL_PREFERRED_FOR_REALTIME'
  | 'LOCAL_PREFERRED_FOR_PRIVACY'
  | 'LOCAL_SELECTED_OFFLINE'
  | 'CLOUD_REQUIRED_FOR_COMPLEXITY'
  | 'CLOUD_REQUIRED_FOR_CROSS_APP'
  | 'CLOUD_AUTHORIZATION_REQUIRED'
  | 'CLOUD_UNAVAILABLE'
  | 'LOCAL_UNAVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'LOCAL_FALLBACK_SELECTED'
  | 'NETWORK_DEGRADED'
  | 'USER_DECISION_REQUIRED'
  | 'NO_EXECUTION_PATH'

export interface AgentRouterDecision {
  readonly version: typeof AGENT_ROUTER_VERSION
  readonly intentId: string
  readonly status: 'ready' | 'awaiting-authorization' | 'no-route'
  readonly path: AgentRouterPath
  readonly target: AgentRouterTarget | null
  readonly reasons: readonly AgentRouterReasonCode[]
  readonly fallbackTarget: AgentRouterTarget | null
  /** Selection is only a preview; execution requires a later approval/grant. */
  readonly executionAuthorized: false
}

export function planAgentRoute(input: { readonly intent: AgentRouterIntent }): AgentRouterDecision {
  const intent = validateIntent(input?.intent)
  const reasons: AgentRouterReasonCode[] = []
  const cloudBlockedByPrivacy = intent.privacy === 'private' && intent.cloudAuthorization !== 'approved'
  const cloudAllowed = intent.cloudAvailable && intent.network !== 'offline' && !cloudBlockedByPrivacy && intent.cloudAuthorization === 'approved'
  const localAllowed = intent.localAvailable

  if (intent.privacy === 'private' && cloudBlockedByPrivacy) reasons.push('CLOUD_AUTHORIZATION_REQUIRED')
  if (intent.network === 'offline') {
    if (localAllowed) return decision(intent, 'ready', 'local', 'local', ['LOCAL_SELECTED_OFFLINE'], null)
    return decision(intent, 'no-route', 'defer', null, ['NETWORK_UNAVAILABLE', 'LOCAL_UNAVAILABLE', 'NO_EXECUTION_PATH'], null)
  }

  const cloudRequired = intent.complexity === 'complex' || intent.requiresCrossApp
  if (cloudRequired) {
    reasons.push(intent.requiresCrossApp ? 'CLOUD_REQUIRED_FOR_CROSS_APP' : 'CLOUD_REQUIRED_FOR_COMPLEXITY')
    if (localAllowed && intent.allowLocalFallback) return decision(intent, 'ready', 'local', 'local', [...reasons, 'LOCAL_FALLBACK_SELECTED'], null)
    if (cloudAllowed) return decision(intent, 'ready', 'cloud', 'cloud', reasons, localAllowed ? 'local' : null)
    if (intent.cloudAuthorization === 'pending') return decision(intent, 'awaiting-authorization', 'ask_user', null, [...reasons, 'USER_DECISION_REQUIRED'], localAllowed ? 'local' : null)
    return decision(intent, 'no-route', 'defer', null, [...reasons, intent.cloudAvailable ? 'CLOUD_AUTHORIZATION_REQUIRED' : 'CLOUD_UNAVAILABLE', 'NO_EXECUTION_PATH'], null)
  }

  if (localAllowed) {
    reasons.push(intent.interaction === 'realtime' ? 'LOCAL_PREFERRED_FOR_REALTIME' : 'LOCAL_PREFERRED_FOR_PRIVACY')
    return decision(intent, 'ready', 'local', 'local', reasons, cloudAllowed ? 'cloud' : null)
  }
  if (cloudAllowed) return decision(intent, 'ready', 'cloud', 'cloud', reasons.length > 0 ? reasons : ['LOCAL_UNAVAILABLE'], null)
  if (intent.cloudAuthorization === 'pending') return decision(intent, 'awaiting-authorization', 'ask_user', null, [...reasons, 'LOCAL_UNAVAILABLE', 'USER_DECISION_REQUIRED'], null)
  return decision(intent, 'no-route', 'defer', null, [...reasons, 'LOCAL_UNAVAILABLE', intent.cloudAvailable ? 'CLOUD_AUTHORIZATION_REQUIRED' : 'CLOUD_UNAVAILABLE', 'NO_EXECUTION_PATH'], null)
}

function decision(intent: AgentRouterIntent, status: AgentRouterDecision['status'], path: AgentRouterPath, target: AgentRouterTarget | null, reasons: readonly AgentRouterReasonCode[], fallbackTarget: AgentRouterTarget | null): AgentRouterDecision {
  return Object.freeze({ version: AGENT_ROUTER_VERSION, intentId: intent.intentId, status, path, target, reasons: Object.freeze([...new Set(reasons)]), fallbackTarget, executionAuthorized: false as const })
}

function validateIntent(value: AgentRouterIntent): AgentRouterIntent {
  if (!value || value.version !== AGENT_ROUTER_VERSION || !id(value.intentId)
    || !['realtime', 'deferred'].includes(value.interaction) || !['simple', 'complex'].includes(value.complexity)
    || !['private', 'shared'].includes(value.privacy) || !['online', 'metered', 'offline', 'unknown'].includes(value.network)
    || typeof value.requiresCrossApp !== 'boolean' || !Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.some(item => !id(item))
    || (value.localModelIds !== undefined && (!Array.isArray(value.localModelIds) || value.localModelIds.some(item => !id(item))))
    || typeof value.localAvailable !== 'boolean' || typeof value.cloudAvailable !== 'boolean'
    || !['approved', 'pending', 'denied'].includes(value.cloudAuthorization) || typeof value.allowLocalFallback !== 'boolean') {
    throw new ComputeError('COMPUTE_AGENT_ROUTER_INTENT_INVALID', 422)
  }
  return value
}

function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) }
