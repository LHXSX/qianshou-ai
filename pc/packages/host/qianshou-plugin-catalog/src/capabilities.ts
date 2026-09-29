/**
 * 我的能力: visibility rules, the publish wizard's steps, and the numbers this computer measured.
 *
 * Nothing here writes files, opens the network or reads account credentials. The catalog service
 * supplies the observations and does the writing; this module decides what a saved row means.
 */
import { CatalogFailure } from './registry.ts'
import type {
  CapabilityDraftRequest,
  CapabilityMetric,
  CapabilityMetricReason,
  CapabilityMetrics,
  CapabilityVisibility,
  CapabilityWizardStepId,
  PublishCapabilityRequest,
} from './types.ts'

/** Visibilities a client may set, in the order the publish step offers them. */
export const CAPABILITY_VISIBILITIES: readonly CapabilityVisibility[] = ['draft', 'private', 'invite', 'public']

/** The publish wizard's steps, in order. Every step before `publish` saves a draft. */
export const CAPABILITY_WIZARD_STEP_IDS: readonly CapabilityWizardStepId[] = [
  'identity', 'run-preflight', 'order-policy', 'publish',
]

/**
 * Visibility a row carries when its stored value is missing or one this build does not know.
 * A file written before visibility existed reads as `draft`: unpublished, and out of the hello.
 */
export const DEFAULT_VISIBILITY: CapabilityVisibility = 'draft'

/** The only visibility the node hello repeats. */
export const HELLO_VISIBILITY: CapabilityVisibility = 'public'

/** Longest account id this computer stores: twenty decimal digits, which Shanghai account ids fit. */
const ACCOUNT_ID = /^[1-9]\d{0,19}$/

/** Most account ids one record invites. */
export const MAX_INVITE_ACCOUNT_IDS = 64

/**
 * Whether a saved visibility may reach the node hello.
 * @param visibility - Visibility stored on one record.
 * @returns True only for `public`.
 */
export function mergesIntoHello(visibility: CapabilityVisibility): boolean {
  return visibility === HELLO_VISIBILITY
}

/**
 * Read one stored visibility.
 * An absent or unrecognized value is `draft`, never `public`: an unreadable field cannot publish.
 * @param value - Untrusted stored visibility.
 * @returns The stored visibility, or {@link DEFAULT_VISIBILITY}.
 */
export function readVisibility(value: unknown): CapabilityVisibility {
  return typeof value === 'string' && (CAPABILITY_VISIBILITIES as readonly string[]).includes(value)
    ? value as CapabilityVisibility
    : DEFAULT_VISIBILITY
}

/**
 * Validate one publish request into the visibility to save, or refuse it.
 * @param request - Publish input, including the owner's public confirmation.
 * @returns The visibility the host will store.
 * @throws CatalogFailure - `invalid-visibility` for a value this build does not know,
 * `publish-unconfirmed` for `public` without the owner's explicit confirmation.
 */
export function resolvePublishVisibility(request: PublishCapabilityRequest): CapabilityVisibility {
  if (!(CAPABILITY_VISIBILITIES as readonly string[]).includes(request.visibility)) {
    throw new CatalogFailure('invalid-visibility')
  }
  // The confirmation is what makes public a decision, not a default: without it this refuses
  // rather than quietly publishing.
  if (request.visibility === HELLO_VISIBILITY && request.confirmPublic !== true) {
    throw new CatalogFailure('publish-unconfirmed')
  }
  return request.visibility
}

/**
 * The visibility a wizard step before publish may save.
 * @returns `draft`, whatever the page sent.
 */
export function draftVisibility(): CapabilityVisibility {
  return DEFAULT_VISIBILITY
}

function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value)
}

/**
 * Validate one draft request's invite list and drop repeats.
 * @param value - Untrusted account ids from a draft request.
 * @returns The accepted ids in first-seen order, or null when one entry is not an account id.
 */
export function parseInviteAccountIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_INVITE_ACCOUNT_IDS) return null
  const ids: string[] = []
  for (const entry of value as unknown[]) {
    if (!isAccountId(entry)) return null
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

/**
 * Read a saved invite list from the declaration file.
 * An entry this computer does not store is dropped rather than promoted, so a hand-edited file
 * cannot invent an invitation, and a bounded read can never fail the whole hello.
 * @param value - Untrusted stored list.
 * @returns The stored ids, in order, bounded to {@link MAX_INVITE_ACCOUNT_IDS}.
 */
export function readInviteAccountIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value as unknown[]) {
    if (ids.length >= MAX_INVITE_ACCOUNT_IDS) break
    if (!isAccountId(entry)) continue
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

/** One measurement no local source reported. */
function unmeasured(reason: CapabilityMetricReason): CapabilityMetric {
  return { state: 'unknown', reason }
}

/**
 * The three published numbers, as this service can observe them.
 *
 * This service measures none of the three: no run of the capability is counted here, no duration
 * is recorded, and no accelerator memory is probed. Every one is therefore `unknown` with its
 * reason. Zero would be a measured claim nobody measured — a capability that never ran here is
 * not one with a 0% success rate, and a machine whose accelerator memory was never read is not a
 * machine with 0 bytes of it.
 * @returns Metrics holding no measured number.
 */
export function unmeasuredCapabilityMetrics(): CapabilityMetrics {
  return {
    successRate: unmeasured('no-local-sample'),
    p95LatencyMs: unmeasured('no-local-sample'),
    vramBytes: unmeasured('not-probed'),
  }
}

/**
 * The invite list one draft request saves.
 * @param request - Untrusted draft input from the wizard's order-policy step.
 * @returns The ids to store on this computer.
 * @throws CatalogFailure - `invalid-invite` when an entry is not an account id or the list is too long.
 */
export function draftInviteAccountIds(request: CapabilityDraftRequest): string[] {
  const ids = parseInviteAccountIds(request.inviteAccountIds)
  if (ids === null) throw new CatalogFailure('invalid-invite')
  return ids
}
