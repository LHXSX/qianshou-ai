/** Canonical setup uses separate authenticated RPC methods and never falls back to V2. */
import type {
  H3CanonicalSetupSelection, H3CanonicalSetupInspectResult, H3CanonicalSetupSaveRequest,
  H3CanonicalSetupSaveResult, H3CanonicalTrialRequest, H3CanonicalTrialStatus,
  H3CanonicalSkillDraftRequest, H3CanonicalSkillDraftResult,
} from '@deepseek-ai/dsh-host-qianshou-plugin-catalog/types'

type RemoteResult = { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** Current Catalog RPC supplies authority and private runtime evidence internally. */
export interface H3CanonicalSetupRemote {
  inspectH3CanonicalSetup(this: void, selection?: H3CanonicalSetupSelection): Promise<RemoteResult>
  saveH3CanonicalSetup(this: void, request: H3CanonicalSetupSaveRequest): Promise<RemoteResult>
  startH3CanonicalTrial(this: void, request: H3CanonicalTrialRequest): Promise<RemoteResult>
  h3CanonicalTrialStatus(this: void, operationId: H3CanonicalTrialStatus['operationId']): Promise<RemoteResult>
  createH3CanonicalSkillDraft(this: void, request: H3CanonicalSkillDraftRequest): Promise<RemoteResult>
}

/** Read-only calls cannot submit GPU jobs; each trial has its own explicit command. */
export interface H3CanonicalSetupTransport {
  inspect(this: void, selection?: H3CanonicalSetupSelection): Promise<H3CanonicalSetupInspectResult>
  save(this: void, request: H3CanonicalSetupSaveRequest): Promise<H3CanonicalSetupSaveResult>
  start(this: void, request: H3CanonicalTrialRequest): Promise<H3CanonicalTrialStatus>
  status(this: void, operationId: H3CanonicalTrialStatus['operationId']): Promise<H3CanonicalTrialStatus>
  draft(this: void, request: H3CanonicalSkillDraftRequest): Promise<H3CanonicalSkillDraftResult>
}

function invalid(): never { throw new Error('H3_SETUP_INVALID_RESPONSE') }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(row: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): void {
  if (!keys.every(key => Object.hasOwn(row, key))
    || !Object.keys(row).every(key => keys.includes(key) || optional.includes(key))) invalid()
}
function uuid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function trial(value: unknown): H3CanonicalTrialStatus {
  const row = record(value)
  exact(row, ['operationId', 'revision', 'sample', 'state', 'code', 'startedAt'], ['finishedAt'])
  const codes: Record<string, string> = { pending: 'H3_CANONICAL_TRIAL_PENDING',
    unknown: 'H3_CANONICAL_TRIAL_UNKNOWN', ready: 'H3_CANONICAL_TRIAL_VERIFIED' }
  if (!uuid(row.operationId) || !revision(row.revision) || row.revision < 1 || (row.sample !== 1 && row.sample !== 2)
    || typeof row.state !== 'string' || codes[row.state] !== row.code
    || typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt) || row.startedAt <= 0
    || (row.finishedAt !== undefined && (typeof row.finishedAt !== 'number'
      || !Number.isFinite(row.finishedAt) || row.finishedAt < row.startedAt))
    || (row.state === 'ready' && row.finishedAt === undefined)) invalid()
  return row as unknown as H3CanonicalTrialStatus
}
function inspection(value: unknown): H3CanonicalSetupInspectResult {
  const row = record(value)
  if (row.kind === 'inspection') {
    exact(row, ['kind', 'contextId', 'inspectionId', 'revision', 'expiresAt', 'code'])
    if (!uuid(row.contextId) || !uuid(row.inspectionId) || !revision(row.revision)
      || typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.expiresAt <= 0
      || row.code !== 'H3_CANONICAL_INSPECTED') invalid()
  } else if (row.kind === 'current') {
    exact(row, ['kind', 'contextId', 'runtime', 'configured', 'revision', 'state', 'code', 'samples'])
    if (!uuid(row.contextId) || !revision(row.revision) || typeof row.configured !== 'boolean'
      || row.runtime !== (row.configured ? 'canonical' : null) || !Array.isArray(row.samples) || row.samples.length > 2) invalid()
    const samples = row.samples.map(trial)
    if (samples.some(item => item.revision !== row.revision)
      || new Set(samples.map(item => item.sample)).size !== samples.length
      || new Set(samples.map(item => item.operationId)).size !== samples.length) invalid()
    const state = !row.configured ? 'unconfigured' : samples.some(item => item.state === 'unknown') ? 'unknown'
      : samples.some(item => item.state === 'pending') ? 'pending' : samples.length === 2 ? 'ready' : 'saved'
    const codes = { unconfigured: 'H3_CANONICAL_NOT_CONFIGURED', saved: 'H3_CANONICAL_SAVED',
      pending: 'H3_CANONICAL_TRIAL_PENDING', unknown: 'H3_CANONICAL_TRIAL_UNKNOWN', ready: 'H3_CANONICAL_TRIAL_VERIFIED' }
    const sharedAdmissionUnknown = row.configured && row.state === 'unknown'
      && row.code === codes.unknown && (state === 'saved' || state === 'ready')
    if ((!sharedAdmissionUnknown && (row.state !== state || row.code !== codes[state]))
      || (!row.configured && samples.length > 0)
      || (row.configured && row.revision < 1) || (samples.some(item => item.sample === 2)
        && !samples.some(item => item.sample === 1 && item.state === 'ready'))) invalid()
  } else invalid()
  return row as unknown as H3CanonicalSetupInspectResult
}
function valueOf(result: RemoteResult): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Validate canonical wire responses without starting, retrying or selecting an old runtime.
 * @param remote Current authenticated Catalog service.
 * @returns Separate canonical setup commands and pure state readers.
 */
export function createH3CanonicalSetupTransport(remote: H3CanonicalSetupRemote): H3CanonicalSetupTransport {
  return {
    async inspect(selection) { return inspection(valueOf(await remote.inspectH3CanonicalSetup(selection))) },
    async save(request) {
      const row = record(valueOf(await remote.saveH3CanonicalSetup(request)))
      exact(row, ['contextId', 'state', 'revision'])
      if (!uuid(row.contextId) || row.state !== 'saved' || !revision(row.revision)
        || row.revision <= request.expectedRevision) invalid()
      return row as unknown as H3CanonicalSetupSaveResult
    },
    async start(request) {
      const result = trial(valueOf(await remote.startH3CanonicalTrial(request)))
      if (result.revision !== request.revision || result.sample !== request.sample) invalid()
      return result
    },
    async status(operationId) {
      const result = trial(valueOf(await remote.h3CanonicalTrialStatus(operationId)))
      if (result.operationId !== operationId) invalid()
      return result
    },
    async draft(request) {
      const row = record(valueOf(await remote.createH3CanonicalSkillDraft(request)))
      exact(row, ['state', 'revision', 'name', 'displayName', 'published'])
      if (row.state !== 'draft' || row.revision !== request.revision || row.name !== request.name
        || row.displayName !== request.displayName || row.published !== false) invalid()
      return row as unknown as H3CanonicalSkillDraftResult
    },
  }
}
