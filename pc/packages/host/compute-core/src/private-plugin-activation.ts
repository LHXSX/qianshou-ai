/** Owner-approved PRIVATE activation and conversation use of trusted Host callbacks. */
import { ComputeError } from './errors.ts'
import { buildOfflinePluginDeclaration, type OfflinePluginDeclaration } from './offline-plugin-declaration.ts'
import type { VerifiedOfflinePluginActivationMaterial } from './offline-plugin-artifact.ts'
import { parsePluginDraftId, type LocalPluginDraft, type LocalPluginDraftStore } from './plugin-draft.ts'
import type { PrivateOfflinePluginArtifactStore } from './private-offline-plugin-artifact-store.ts'
import { PrivatePluginActivationLedger, type PrivatePluginActivationRecord } from './private-plugin-activation-ledger.ts'
import type { PrivatePluginInvocationLedger } from './private-plugin-invocation-ledger.ts'
import type { HostPluginSampleWorkbench } from './private-plugin-sample-workbench.ts'

/** Host approval service. The agent may request, but cannot manufacture, `allowed-once`. */
export interface PrivatePluginOwnerApproval {
  readonly request: (request: {
    readonly agent: unknown
    readonly toolName: string
    readonly callId?: unknown
    readonly reason: string
    readonly signal: AbortSignal
  }) => Promise<string>
}

/** Status of an installed private archive, recalculated from current Host facts. */
export interface PrivatePluginActivationSummary extends PrivatePluginActivationRecord {
  readonly state: 'active-private' | 'unavailable-private'
  readonly scope: 'private-local'
  /** Current declaration match does not pin the Host package's executable code digest. */
  readonly implementationDigestVerified: false
  readonly dispatchable: false
  readonly publishable: false
}

/** Bounded conversation output from one current Host callback. */
export interface PrivatePluginOperationResult {
  readonly pluginId: string
  readonly version: string
  readonly packageSha256: string
  readonly operationId: string
  readonly output: unknown
  readonly state: 'completed-private'
  /** True when this Host call ID already completed with the same exact input. */
  readonly replayed: boolean
  readonly implementationDigestVerified: false
  readonly dispatchable: false
  readonly publishable: false
}

/** Host-only declaration bytes and a safe preview of one privately activated version. */
export interface PreparedPrivatePluginSubmission {
  readonly preview: Omit<OfflinePluginDeclaration, 'bytes'> & {
    readonly packageBytes: number
    readonly sourcePrivatePackageSha256: string
    readonly sourceCandidateSha256: string
  }
  /** Keep the ZIP in Host memory; no model tool, Connection route or Client Remote returns it. */
  readonly archive: Buffer
}

interface Authority {
  readonly agent: unknown
  readonly callId?: unknown
  readonly signal: AbortSignal
}
interface Pinned {
  readonly draft: LocalPluginDraft
  readonly material: VerifiedOfflinePluginActivationMaterial
  readonly record: PrivatePluginActivationRecord
}

function refused(code: string, status = 409): ComputeError { return new ComputeError(code, status) }
function sameBinding(left: PrivatePluginActivationRecord, right: PrivatePluginActivationRecord): boolean {
  return left.pluginId === right.pluginId && left.displayName === right.displayName
    && left.version === right.version
    && left.packageSha256 === right.packageSha256 && left.candidateSha256 === right.candidateSha256
    && left.draftId === right.draftId && left.draftUpdatedAt === right.draftUpdatedAt
    && JSON.stringify(left.operations) === JSON.stringify(right.operations)
}
function summary(row: PrivatePluginActivationRecord,
  state: PrivatePluginActivationSummary['state']): PrivatePluginActivationSummary {
  return { ...row, state, scope: 'private-local', implementationDigestVerified: false,
    dispatchable: false, publishable: false }
}

/** Host-only orchestrator. It never loads archive code or contributes a public capability. */
export class PrivatePluginActivationHost {
  private readonly stop = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly options: {
    readonly drafts: Pick<LocalPluginDraftStore, 'list'>
    readonly artifacts: PrivateOfflinePluginArtifactStore
    readonly workbench: HostPluginSampleWorkbench
    readonly ledger: PrivatePluginActivationLedger
    readonly invocations: PrivatePluginInvocationLedger
    readonly approval?: PrivatePluginOwnerApproval
  }) {}

  /** List persisted installs, showing unavailable when their current archive, draft or adapter fails validation. */
  async list(): Promise<readonly PrivatePluginActivationSummary[]> {
    if (this.stop.signal.aborted) throw refused('COMPUTE_CLOSED', 503)
    const rows = await this.options.ledger.list()
    return Promise.all(rows.map(async (row) => {
      try {
        const current = await this.prepare(row.packageSha256, row.candidateSha256)
        return summary(row, sameBinding(row, current.record) ? 'active-private' : 'unavailable-private')
      } catch { return summary(row, 'unavailable-private') }
    }))
  }

  /** Recheck one active private sample archive and current adapters before preparing a data-only submission.
   * @param input - Exact saved revision, private archive, operation capabilities and Host cancellation.
   * @returns Safe preview plus Host-only ZIP bytes; neither approval nor upload occurs.
   */
  prepareSubmission(input: {
    readonly draftId: string
    readonly expectedUpdatedAt: string
    readonly packageSha256: string
    readonly candidateSha256: string
    readonly capabilityIds: Readonly<Record<string, string>>
    readonly signal: AbortSignal
  }): Promise<PreparedPrivatePluginSubmission> {
    return this.track(async (signal) => {
      const draftId = parsePluginDraftId(input.draftId)
      signal.throwIfAborted()
      return this.options.artifacts.withActivationArchive(input.packageSha256, input.candidateSha256,
        async () => this.options.ledger.withPackageLock(input.packageSha256, input.candidateSha256, async () => {
          signal.throwIfAborted()
          const active = await this.options.ledger.find(input.packageSha256, input.candidateSha256)
          if (active.draftId !== draftId || active.draftUpdatedAt !== input.expectedUpdatedAt) {
            throw refused('COMPUTE_PRIVATE_PLUGIN_DRAFT_STALE')
          }
          const current = await this.prepare(input.packageSha256, input.candidateSha256)
          if (!sameBinding(active, current.record)) throw refused('COMPUTE_PRIVATE_PLUGIN_CHANGED')
          signal.throwIfAborted()
          const declaration = buildOfflinePluginDeclaration({ draft: current.draft,
            capabilityIds: input.capabilityIds })
          const { bytes, ...preview } = declaration
          return { preview: { ...preview, packageBytes: bytes.length,
            sourcePrivatePackageSha256: input.packageSha256,
            sourceCandidateSha256: input.candidateSha256 }, archive: bytes }
        }))
    }, input.signal)
  }

  /** Ask the owner for this exact archive, recheck all live contracts, then persist a private install. */
  activate(packageSha256: string, candidateSha256: string,
    authority: Authority): Promise<PrivatePluginActivationSummary> {
    return this.track(async (signal) => {
      const before = await this.prepare(packageSha256, candidateSha256)
      const operations = before.material.spec.operations
      const permissions = [...new Set(operations.flatMap(operation => operation.permissions))]
      await this.approve({ ...authority, signal }, 'plugin_private_activate',
        `在这台电脑私有启用插件「${before.material.spec.displayName}」 ${before.record.pluginId}@${before.record.version}；制品 SHA-256 ${packageSha256}，候选 SHA-256 ${candidateSha256}；操作 ${operations.map(item => item.id).join('、')}；权限 ${permissions.length ? permissions.join('、') : '无额外权限'}。只绑定当前已安装 Host 适配器，不执行 ZIP 代码，不上架、出售或开放接单。仅授权本次启用吗？`)
      signal.throwIfAborted()
      return this.options.artifacts.withActivationArchive(packageSha256, candidateSha256,
        async () => this.options.ledger.withPackageLock(packageSha256, candidateSha256, async () => {
          const current = await this.prepare(packageSha256, candidateSha256)
          if (!sameBinding(before.record, current.record)) throw refused('COMPUTE_PRIVATE_PLUGIN_CHANGED')
          signal.throwIfAborted()
          const persisted = await this.options.ledger.activate(current.record)
          return summary(persisted, 'active-private')
        }))
    }, authority.signal)
  }

  /** Remove the exact private install after owner approval. Future calls fail closed. */
  uninstall(packageSha256: string, candidateSha256: string,
    authority: Authority): Promise<PrivatePluginActivationRecord & { readonly state: 'uninstalled-private' }> {
    return this.track(async (signal) => {
      const row = await this.options.ledger.find(packageSha256, candidateSha256)
      await this.approve({ ...authority, signal }, 'plugin_private_uninstall',
        `从这台电脑卸载私有插件 ${row.pluginId}@${row.version}；制品 SHA-256 ${packageSha256}。卸载后对话不能再调用这些操作；私有 ZIP 和调用记录仍留在本机，需另行清理。仅授权本次卸载吗？`)
      signal.throwIfAborted()
      return this.options.ledger.withPackageLock(packageSha256, candidateSha256, async () => {
        const current = await this.options.ledger.find(packageSha256, candidateSha256)
        if (!sameBinding(row, current)) throw refused('COMPUTE_PRIVATE_PLUGIN_CHANGED')
        signal.throwIfAborted()
        const removed = await this.options.ledger.uninstall(packageSha256, candidateSha256)
        return { ...removed, state: 'uninstalled-private' }
      })
    }, authority.signal)
  }

  /** Execute one installed operation after a fresh one-shot owner approval for the exact input digest. */
  run(packageSha256: string, candidateSha256: string, operationId: string, input: unknown,
    authority: Authority): Promise<PrivatePluginOperationResult> {
    return this.track(async (signal) => {
      if (typeof authority.callId !== 'string') throw refused('COMPUTE_PRIVATE_PLUGIN_CALL_ID_REQUIRED', 400)
      const row = await this.options.ledger.find(packageSha256, candidateSha256)
      const before = await this.prepare(packageSha256, candidateSha256)
      if (!sameBinding(row, before.record)) throw refused('COMPUTE_PRIVATE_PLUGIN_CHANGED')
      const digest = this.options.workbench.privateOperationInputSha256(before.draft,
        before.material.candidate, operationId, input)
      const operation = before.material.spec.operations.find(item => item.id === operationId)
      if (operation === undefined) throw refused('COMPUTE_PRIVATE_PLUGIN_OPERATION_UNKNOWN')
      await this.approve({ ...authority, signal }, 'plugin_private_run',
        `在这台电脑调用私有插件 ${row.pluginId}@${row.version} 的 ${operationId}；制品 SHA-256 ${packageSha256}；本次输入 SHA-256 ${digest}；权限 ${operation.permissions.length ? operation.permissions.join('、') : '无额外权限'}；数据范围 ${operation.dataScope}；网络来源 ${operation.networkOrigins.length ? operation.networkOrigins.join('、') : '无'}。同一调用 ID 的重试返回原结果，未决调用阻止该操作重做。结果只在当前对话返回，不上传市场或开放接单。仅授权这一次调用吗？`)
      signal.throwIfAborted()
      return this.options.artifacts.withActivationArchive(packageSha256, candidateSha256,
        async () => this.options.ledger.withPackageLock(packageSha256, candidateSha256, async () => {
          const currentRow = await this.options.ledger.find(packageSha256, candidateSha256)
          const current = await this.prepare(packageSha256, candidateSha256)
          if (!sameBinding(row, currentRow) || !sameBinding(row, current.record)
            || this.options.workbench.privateOperationInputSha256(current.draft,
              current.material.candidate, operationId, input) !== digest) {
            throw refused('COMPUTE_PRIVATE_PLUGIN_CHANGED')
          }
          const invoked = await this.options.workbench.withPrivateOperationLane(current.draft,
            current.material.candidate, operationId, input, signal, async (execute) => {
              const reservation = await this.options.invocations.reserve({ callId: authority.callId as string,
                packageSha256, candidateSha256, operationId, inputSha256: digest })
              if (!reservation.created) return { output: reservation.record.output, replayed: true }
              const produced = await execute()
              const completed = await this.options.invocations.complete(reservation.record, produced)
              return { output: completed.output, replayed: false }
            })
          const after = await this.options.ledger.find(packageSha256, candidateSha256)
          if (!sameBinding(row, after)) throw refused('COMPUTE_PRIVATE_PLUGIN_CHANGED')
          return { pluginId: row.pluginId, version: row.version, packageSha256,
            operationId, output: invoked.output, state: 'completed-private', replayed: invoked.replayed,
            implementationDigestVerified: false, dispatchable: false, publishable: false }
        }))
    }, authority.signal)
  }

  /** Abort accepted work and wait for cooperative Host callbacks to settle. */
  async close(): Promise<void> {
    this.stop.abort()
    await Promise.allSettled([...this.pending])
  }

  private async prepare(packageSha256: string, candidateSha256: string): Promise<Pinned> {
    const material = await this.options.artifacts.loadForActivation(packageSha256, candidateSha256)
    const draft = (await this.options.drafts.list()).find(item => item.id === material.candidate.draftId)
    if (draft === undefined || draft.updatedAt !== material.candidate.draftUpdatedAt
      || JSON.stringify(draft.spec) !== JSON.stringify(material.spec)) {
      throw refused('COMPUTE_PRIVATE_PLUGIN_DRAFT_STALE')
    }
    this.options.workbench.assertPrivateCandidate(draft, material.candidate)
    const record: PrivatePluginActivationRecord = {
      pluginId: material.verified.pluginId, displayName: material.spec.displayName,
      version: material.verified.version,
      packageSha256, candidateSha256, draftId: draft.id, draftUpdatedAt: draft.updatedAt,
      installedAt: new Date().toISOString(),
      operations: material.candidate.operations.map(item => ({ operationId: item.operationId,
        adapterId: item.adapterId, adapterVersion: item.adapterVersion })),
    }
    return { draft, material, record }
  }

  private async approve(authority: Authority, toolName: string, reason: string): Promise<void> {
    if (!authority.agent || !this.options.approval) throw refused('COMPUTE_PRIVATE_PLUGIN_OWNER_APPROVAL_REQUIRED', 403)
    const outcome = await this.options.approval.request({ agent: authority.agent,
      toolName, callId: authority.callId, reason, signal: authority.signal })
    if (outcome !== 'allowed-once') throw refused('COMPUTE_PRIVATE_PLUGIN_OWNER_APPROVAL_REQUIRED', 403)
  }

  private track<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.stop.signal.aborted) return Promise.reject(refused('COMPUTE_CLOSED', 503))
    const combined = AbortSignal.any([signal, this.stop.signal])
    const operation = run(combined)
    this.pending.add(operation)
    void operation.finally(() => this.pending.delete(operation)).catch(() => {})
    return operation
  }
}
