/** Authenticated, owner-local H3 setup. None of these actions publishes or grants supply. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Short-lived inspection of the exact selected local files. */
export type H3OwnerInspectionId = Branded<'H3OwnerInspectionId'>
/** One explicit local generation, retained across Host restarts without automatic retry. */
export type H3OwnerSelfTestId = Branded<'H3OwnerSelfTestId'>
/** Host-issued context binds a command to the inspected authenticated owner/profile/revision. */
export type H3OwnerSetupContextId = Branded<'H3OwnerSetupContextId'>

/** Existing owner files and a loopback adapter; managed runtime/output paths are Host-owned. */
export interface H3OwnerSetupSelection {
  readonly runtime: 'v2' | 'canonical'
  readonly pythonPath: string
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly firstFramePath: string
  readonly workflowPath: string
  readonly modelPath: string
  readonly adapterBase: string
  /** Actual adapter output root, distinct from the Host-owned local-trial workspace. */
  readonly adapterOutputRoot: string
}

/** Successful file inspection; adapter availability is independent of saving a configuration. */
export interface H3OwnerSetupInspection {
  readonly contextId: H3OwnerSetupContextId
  readonly kind: 'inspection'
  readonly inspectionId: H3OwnerInspectionId
  readonly revision: number
  readonly expiresAt: number
  readonly adapterAvailable: boolean
  readonly code: 'H3_SETUP_INSPECTED' | 'H3_SETUP_ADAPTER_UNAVAILABLE'
}

/** First-screen managed state read without subprocesses, GPU, or platform requests. */
export interface H3OwnerSetupSummary {
  readonly contextId: H3OwnerSetupContextId
  readonly kind: 'current'
  readonly runtime: 'v2' | null
  readonly revision: number
  readonly configured: boolean
  readonly state: 'unconfigured' | 'saved' | H3OwnerSelfTestStatus['state']
  readonly code: 'H3_SETUP_NOT_CONFIGURED' | 'H3_SETUP_SAVED' | H3OwnerSelfTestStatus['code']
  readonly operation?: H3OwnerSelfTestStatus
}

/** Inspection either reads current configuration or reviews a user's explicit file selection. */
export type H3OwnerSetupInspectResult = H3OwnerSetupSummary | H3OwnerSetupInspection

/** Save consumes the inspection and compares the current owner/profile revision. */
export interface H3OwnerSetupSaveRequest {
  readonly inspectionId: H3OwnerInspectionId
  readonly expectedRevision: number
}

/** Private provider observation; paths and scope ids are not needed in browser responses. */
export interface H3OwnerManagedConfigState {
  readonly configPath: string
  readonly revision: number
  readonly scopeId: string
}

/** A saved configuration has no generation or platform approval evidence. */
export interface H3OwnerSetupSaveResult {
  readonly contextId: H3OwnerSetupContextId
  readonly state: 'saved'
  readonly revision: number
}

/** Only this explicit request may start the five-second local video trial. */
export interface H3OwnerSelfTestRequest {
  readonly contextId: H3OwnerSetupContextId
  readonly revision: number
  readonly prompt: string
}

/** Real local operation state; ready means local evidence only, never platform approval. */
export interface H3OwnerSelfTestStatus {
  readonly operationId: H3OwnerSelfTestId
  readonly revision: number
  readonly state: 'pending' | 'unknown' | 'ready' | 'failed'
  readonly code: 'H3_SETUP_SELF_TEST_PENDING' | 'H3_SETUP_SELF_TEST_UNKNOWN'
    | 'H3_SETUP_SELF_TEST_VERIFIED' | 'H3_SETUP_SELF_TEST_FAILED'
  readonly startedAt: number
  readonly finishedAt?: number
}

/** An explicit local draft request, using a current real trial rather than a caller's binding. */
export interface H3SkillDraftRequest {
  readonly contextId: H3OwnerSetupContextId
  readonly revision: number
  readonly name: string
  readonly displayName: string
  readonly description: string
}

/** Only the local skill has been created; no cloud publication or supply grant is implied. */
export interface H3SkillDraftResult {
  readonly state: 'draft'
  readonly revision: number
  readonly name: string
  readonly displayName: string
  readonly published: false
}

/** Canonical setup has independent commands, revisions and local trial records. */
export type { H3CanonicalSetupContextId, H3CanonicalInspectionId, H3CanonicalTrialId, H3CanonicalSetupSelection,
  H3CanonicalSetupInspectResult, H3CanonicalSetupSummary, H3CanonicalSetupInspection, H3CanonicalSetupSaveRequest,
  H3CanonicalSetupSaveResult, H3CanonicalTrialRequest, H3CanonicalTrialStatus, H3CanonicalSkillDraftRequest,
  H3CanonicalSkillDraftResult }
  from './h3-canonical-owner-setup-types.ts'
