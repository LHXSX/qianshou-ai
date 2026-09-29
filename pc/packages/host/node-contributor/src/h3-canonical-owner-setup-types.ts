/** Local canonical onboarding responses contain no private paths or software approval selectors. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Host-issued command context for one authenticated canonical owner/profile/revision. */
export type H3CanonicalSetupContextId = Branded<'H3CanonicalSetupContextId'>
/** Short-lived inspection of a selected PNG and the fixed loopback software. */
export type H3CanonicalInspectionId = Branded<'H3CanonicalInspectionId'>
/** One explicit five-second local trial; it cannot authorize a repeat after uncertainty. */
export type H3CanonicalTrialId = Branded<'H3CanonicalTrialId'>

/** Ordinary selection; software identity and managed destinations are obtained by the Host. */
export interface H3CanonicalSetupSelection {
  readonly firstFramePath: string
  readonly adapterBase?: string
  readonly negative?: string
}

/** One local sample, independent of platform samples, review and supply authorization. */
export interface H3CanonicalTrialStatus {
  readonly operationId: H3CanonicalTrialId
  readonly revision: number
  readonly sample: 1 | 2
  readonly state: 'pending' | 'unknown' | 'ready'
  readonly code: 'H3_CANONICAL_TRIAL_PENDING' | 'H3_CANONICAL_TRIAL_UNKNOWN' | 'H3_CANONICAL_TRIAL_VERIFIED'
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Read-only current managed state; ready requires two confirmed independent local samples. */
export interface H3CanonicalSetupSummary {
  readonly kind: 'current'
  readonly contextId: H3CanonicalSetupContextId
  readonly runtime: 'canonical' | null
  readonly configured: boolean
  readonly revision: number
  readonly state: 'unconfigured' | 'saved' | 'pending' | 'unknown' | 'ready'
  readonly code: 'H3_CANONICAL_NOT_CONFIGURED' | 'H3_CANONICAL_SAVED'
    | 'H3_CANONICAL_TRIAL_PENDING' | 'H3_CANONICAL_TRIAL_UNKNOWN' | 'H3_CANONICAL_TRIAL_VERIFIED'
  readonly samples: readonly H3CanonicalTrialStatus[]
}

/** A successful pure inspection is not a saved configuration or execution receipt. */
export interface H3CanonicalSetupInspection {
  readonly kind: 'inspection'
  readonly contextId: H3CanonicalSetupContextId
  readonly inspectionId: H3CanonicalInspectionId
  readonly revision: number
  readonly expiresAt: number
  readonly code: 'H3_CANONICAL_INSPECTED'
}

/** Inspection either reads current state or verifies an explicitly selected PNG. */
export type H3CanonicalSetupInspectResult = H3CanonicalSetupSummary | H3CanonicalSetupInspection

/** Save consumes an inspected selection and compares the authenticated namespace revision. */
export interface H3CanonicalSetupSaveRequest {
  readonly inspectionId: H3CanonicalInspectionId
  readonly expectedRevision: number
}

/** A durable saved configuration does not start trials, publish or enable supply. */
export interface H3CanonicalSetupSaveResult {
  readonly contextId: H3CanonicalSetupContextId
  readonly state: 'saved'
  readonly revision: number
}

/** Each sample requires a separate explicit command against a Host-issued context. */
export interface H3CanonicalTrialRequest {
  readonly contextId: H3CanonicalSetupContextId
  readonly revision: number
  readonly sample: 1 | 2
  readonly prompt: string
}

/** Draft consumers request fresh evidence, rather than sending a binding or an owner id. */
export interface H3CanonicalVerifiedBindingRequest {
  readonly contextId: H3CanonicalSetupContextId
  readonly revision: number
}

/** Explicit creation of a local draft from two current Host-verified canonical trials. */
export interface H3CanonicalSkillDraftRequest extends H3CanonicalVerifiedBindingRequest {
  readonly name: string
  readonly displayName: string
  readonly description: string
}

/** Local draft receipt; publication, review and supply require their existing separate actions. */
export interface H3CanonicalSkillDraftResult {
  readonly state: 'draft'
  readonly revision: number
  readonly name: string
  readonly displayName: string
  readonly published: false
}

/** Host-only resolver facts; this interface is not a browser response or an admission grant. */
export interface H3CanonicalManagedConfigState {
  readonly configPath: string
  readonly scopeId: string
  readonly revision: number
}
