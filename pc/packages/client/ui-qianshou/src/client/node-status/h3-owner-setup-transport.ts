/** Narrow authenticated Host calls for local H3 setup; reading never starts a trial. */
import type {
  H3OwnerSetupSelection, H3OwnerSetupInspectResult, H3OwnerSetupSaveRequest,
  H3OwnerSetupSaveResult, H3OwnerSelfTestRequest, H3OwnerSelfTestStatus,
  H3SkillDraftRequest, H3SkillDraftResult,
} from '@deepseek-ai/dsh-host-qianshou-plugin-catalog/types'

type RemoteResult = { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** The existing Catalog RPC service supplies identity and private paths internally. */
export interface H3OwnerSetupRemote {
  inspectH3OwnerSetup(this: void, selection?: H3OwnerSetupSelection): Promise<RemoteResult>
  saveH3OwnerSetup(this: void, request: H3OwnerSetupSaveRequest): Promise<RemoteResult>
  startH3OwnerSelfTest(this: void, request: H3OwnerSelfTestRequest): Promise<RemoteResult>
  h3OwnerSelfTestStatus(this: void, operationId: H3OwnerSelfTestStatus['operationId']): Promise<RemoteResult>
  createH3SkillDraft(this: void, request: H3SkillDraftRequest): Promise<RemoteResult>
}

/** Client operations return verified semantic states, without private config locations. */
export interface H3OwnerSetupTransport {
  inspect(this: void, selection?: H3OwnerSetupSelection): Promise<H3OwnerSetupInspectResult>
  save(this: void, request: H3OwnerSetupSaveRequest): Promise<H3OwnerSetupSaveResult>
  start(this: void, request: H3OwnerSelfTestRequest): Promise<H3OwnerSelfTestStatus>
  status(this: void, operationId: H3OwnerSelfTestStatus['operationId']): Promise<H3OwnerSelfTestStatus>
  draft(this: void, request: H3SkillDraftRequest): Promise<H3SkillDraftResult>
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('H3_SETUP_INVALID_RESPONSE')
  return value as Record<string, unknown>
}

function exact(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (!required.every(key => Object.hasOwn(row, key))
    || !Object.keys(row).every(key => required.includes(key) || optional.includes(key))) throw new Error('H3_SETUP_INVALID_RESPONSE')
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function context(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
}

function operation(value: unknown): H3OwnerSelfTestStatus {
  const row = record(value)
  exact(row, ['operationId', 'revision', 'state', 'code', 'startedAt'], ['finishedAt'])
  const codes: Record<string, string> = {
    pending: 'H3_SETUP_SELF_TEST_PENDING', unknown: 'H3_SETUP_SELF_TEST_UNKNOWN',
    ready: 'H3_SETUP_SELF_TEST_VERIFIED', failed: 'H3_SETUP_SELF_TEST_FAILED',
  }
  if (typeof row.operationId !== 'string' || row.operationId.length === 0 || row.operationId.length > 200
    || !revision(row.revision) || typeof row.state !== 'string' || codes[row.state] !== row.code
    || typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt) || row.startedAt <= 0
    || (row.finishedAt !== undefined && (typeof row.finishedAt !== 'number'
      || !Number.isFinite(row.finishedAt) || row.finishedAt < row.startedAt))) throw new Error('H3_SETUP_INVALID_RESPONSE')
  return row as unknown as H3OwnerSelfTestStatus
}

function inspection(value: unknown): H3OwnerSetupInspectResult {
  const row = record(value)
  if (row.kind === 'inspection') {
    exact(row, ['kind', 'contextId', 'inspectionId', 'revision', 'expiresAt', 'adapterAvailable', 'code'])
    if (typeof row.inspectionId !== 'string' || row.inspectionId.length === 0 || row.inspectionId.length > 200
      || !context(row.contextId) || !revision(row.revision) || typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)
      || row.expiresAt <= 0 || typeof row.adapterAvailable !== 'boolean'
      || row.code !== (row.adapterAvailable ? 'H3_SETUP_INSPECTED' : 'H3_SETUP_ADAPTER_UNAVAILABLE')) throw new Error('H3_SETUP_INVALID_RESPONSE')
  } else if (row.kind === 'current') {
    exact(row, ['kind', 'contextId', 'runtime', 'revision', 'configured', 'state', 'code'], ['operation'])
    if (!context(row.contextId) || !revision(row.revision) || typeof row.configured !== 'boolean'
      || (row.runtime !== null && row.runtime !== 'v2')
      || (row.configured && row.runtime === null) || (!row.configured && row.state !== 'unconfigured')) throw new Error('H3_SETUP_INVALID_RESPONSE')
    if (row.operation !== undefined) {
      const status = operation(row.operation)
      if (status.revision !== row.revision || status.state !== row.state || status.code !== row.code) throw new Error('H3_SETUP_INVALID_RESPONSE')
    } else if (row.state === 'unconfigured' ? row.code !== 'H3_SETUP_NOT_CONFIGURED'
      : row.state !== 'saved' || row.code !== 'H3_SETUP_SAVED') throw new Error('H3_SETUP_INVALID_RESPONSE')
  } else throw new Error('H3_SETUP_INVALID_RESPONSE')
  return row as unknown as H3OwnerSetupInspectResult
}

function valueOf(result: RemoteResult): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Read verified setup responses from the authenticated Catalog without retries.
 * @param remote The current Catalog RPC service.
 * @returns Operations that preserve Host identity and response validation.
 */
export function createH3OwnerSetupTransport(remote: H3OwnerSetupRemote): H3OwnerSetupTransport {
  return {
    async inspect(selection) { return inspection(valueOf(await remote.inspectH3OwnerSetup(selection))) },
    async save(request) {
      const row = record(valueOf(await remote.saveH3OwnerSetup(request)))
      exact(row, ['state', 'contextId', 'revision'])
      if (row.state !== 'saved' || !context(row.contextId) || !revision(row.revision)
        || row.revision <= request.expectedRevision) throw new Error('H3_SETUP_INVALID_RESPONSE')
      return row as unknown as H3OwnerSetupSaveResult
    },
    async start(request) {
      const result = operation(valueOf(await remote.startH3OwnerSelfTest(request)))
      if (result.revision !== request.revision) throw new Error('H3_SETUP_INVALID_RESPONSE')
      return result
    },
    async status(operationId) {
      const result = operation(valueOf(await remote.h3OwnerSelfTestStatus(operationId)))
      if (result.operationId !== operationId) throw new Error('H3_SETUP_INVALID_RESPONSE')
      return result
    },
    async draft(request) {
      const row = record(valueOf(await remote.createH3SkillDraft(request)))
      exact(row, ['state', 'revision', 'name', 'displayName', 'published'])
      if (row.state !== 'draft' || row.revision !== request.revision || row.name !== request.name
        || row.displayName !== request.displayName || row.published !== false) throw new Error('H3_SETUP_INVALID_RESPONSE')
      return row as unknown as H3SkillDraftResult
    },
  }
}
