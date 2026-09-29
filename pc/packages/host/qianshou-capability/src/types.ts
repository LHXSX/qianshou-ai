/**
 * Browser-visible capability facts. The four layers (catalog and health, server estimate,
 * quote, submission) never collapse into one another: a listed capability is not executable,
 * an estimate is not a quote, and this package has no quote or submission method.
 */

/** Safe failure vocabulary; server bodies and credential values never reach callers. */
export type CapabilityFailureCode =
  | 'auth-required' | 'timeout' | 'network' | 'server-error' | 'rate-limited'
  | 'invalid-response' | 'invalid-input' | 'busy' | 'closed' | 'not-in-catalog'

/** One capability the Shanghai catalog lists; title is enriched from the local registry copy. */
export interface CapabilityCatalogEntry {
  id: string
  title: string | null
  /** First local `legacy_task_types` landing only while the Shanghai response still lists it. */
  taskType: string | null
}

/** A failed or unauthenticated read, kept distinct from an empty catalog. */
export interface CapabilityUnavailable {
  state: 'unavailable'
  source: string
  failure: CapabilityFailureCode
  httpStatus: number | null
}

/** No account credential is stored; the Host made no request. */
export interface CapabilitySignedOut {
  state: 'signed-out'
  source: string
}

/** Layer 1, whole catalog: `catalog-only` means listed, not runnable. */
export type CatalogView =
  | CapabilitySignedOut
  | { state: 'catalog-only'; source: string; registryVersion: string | null; entries: CapabilityCatalogEntry[]; checkedAt: number }
  | CapabilityUnavailable

/** Counts the scheduler reports for one capability; declared and available-now are independent facts. */
export interface CapabilityPoolCounts {
  count: number
  byImpl: Record<string, number>
}

/** Layer 1, one capability: catalog membership plus the scheduler's health counts. */
export type AvailabilityView =
  | (CapabilitySignedOut & { capabilityId: string })
  | {
    state: 'catalog-only'
    capabilityId: string
    source: string
    registryVersion: string | null
    declared: CapabilityPoolCounts
    availableNow: CapabilityPoolCounts & { onlineTtlSeconds: number }
    checkedAt: number
  }
  | (CapabilityUnavailable & { capabilityId: string })

/** The subset of `qianshou/intent/v1` the card collects; validated against the contract copy. */
export interface EstimateIntent {
  goal: string
  /** Local budget cap in minor units; kept for display and never sent to the server this round. */
  budget: { amount_minor: number; currency: string } | null
}

/** Layer 2: server price estimate. Not a quote id, not a locked price, not reserved funds. */
export type EstimateView =
  | (CapabilitySignedOut & { capabilityId: string })
  | {
    state: 'estimate-only'
    capabilityId: string
    /** Platform `task_type` actually posted. */
    taskType: string
    source: string
    currency: string
    /** Decimal strings copied verbatim from the server; never computed or rounded here. */
    estimatedTotal: string
    recommendedBudget: string
    balanceEnough: boolean
    billingMode: string
    /** Projected field name to server field name, so the card can cite the origin of each number. */
    fields: Record<string, string>
    intent: EstimateIntent
    checkedAt: number
  }
  | (CapabilityUnavailable & { capabilityId: string })
