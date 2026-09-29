/** Host-local matching of a draft with registered adapter and caller-submitted digest claims. */
import { createHash, randomUUID } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { parsePluginDraftId, parsePluginDraftSpec,
  type LocalPluginDraft, type PluginDraftBinding, type PluginDraftOperation } from './plugin-draft.ts'
import { pluginDraftPlanManifest } from './plugin-draft-preview.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u
// A safe subset of draft binding refs: logical names only, never URLs, paths or commands.
const LOGICAL_BINDING_REF = /^[a-z][a-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const UNSAFE_BINDING_NAMESPACES = new Set(['file', 'http', 'https', 'cmd', 'exec', 'shell',
  'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'osascript', 'script'])
const MAX_SAMPLE_AGE_MS = 60 * 60 * 1000
const MAX_ADAPTERS = 128
const MAX_SAMPLE_DIGEST_CLAIMS = 512

/** Logical asset identities only. Neither a model path nor model bytes enter this declaration. */
export interface PluginAdapterAsset {
  readonly id: string
  readonly bytes: number
  readonly sha256: string
}

/** A Host-local adapter registration claim; registration alone does not verify implementation or execution. */
export interface HostPluginAdapter {
  readonly adapterId: string
  readonly adapterVersion: string
  readonly operationId: string
  readonly bindingKind: PluginDraftBinding['kind']
  readonly bindingRef: string
  readonly inputSchemaSha256: string
  readonly outputSchemaSha256: string
  readonly permissions: PluginDraftOperation['permissions']
  readonly dataScope: PluginDraftOperation['dataScope']
  readonly networkOrigins: PluginDraftOperation['networkOrigins']
  readonly dependencies: PluginDraftOperation['dependencies']
  readonly resources: PluginDraftOperation['resources']
  readonly assets: readonly PluginAdapterAsset[]
  /** Registration expiry, in Unix milliseconds; not evidence of independent review. */
  readonly validUntilMs: number
}

/** Caller-submitted digest claim. This API cannot attest that an adapter executed. */
export interface HostPluginSampleDigestClaim {
  readonly draft: LocalPluginDraft
  readonly operationId: string
  readonly adapterId: string
  readonly adapterVersion: string
  readonly inputSha256: string
  readonly outputSha256: string
  readonly assets: readonly PluginAdapterAsset[]
}

/** Opaque process-local record of claimed digests; never an execution or installation certificate. */
export interface HostPluginSampleDigestClaimRecord {
  readonly id: string
  readonly operationId: string
  readonly adapterId: string
  readonly adapterVersion: string
  readonly claimedAtMs: number
  readonly expiresAtMs: number
  readonly inputSha256: string
  readonly outputSha256: string
  readonly assets: readonly PluginAdapterAsset[]
}

export interface PluginAdapterSelection {
  readonly operationId: string
  readonly adapterId: string
  readonly adapterVersion: string
  readonly sampleDigestClaimId: string
}

/** Discoverable logical bindings. Registration and digest claims do not prove local execution. */
export interface HostPluginAdapterListing {
  readonly operationId: string
  readonly adapterId: string
  readonly adapterVersion: string
  readonly bindingKind: PluginDraftBinding['kind']
  readonly bindingRef: string
  readonly state: 'registered-needs-sample'
  /** A claimed sample digest is required for private metadata matching, not proof of a run. */
  readonly sampleRequired: true
  readonly executionVerified: false
  readonly validUntilMs: number
}

/** Untrusted private metadata only; never an install, publication or supply authority. */
export interface PrivatePluginCandidate {
  readonly format: 'qianshou.private-plugin-candidate.v1'
  readonly draftId: string
  readonly draftUpdatedAt: string
  readonly draftSha256: string
  readonly pluginId: string
  readonly version: string
  readonly operations: readonly {
    readonly operationId: string
    readonly adapterId: string
    readonly adapterVersion: string
    readonly bindingKind: PluginDraftBinding['kind']
    readonly bindingRef: string
    readonly inputSchemaSha256: string
    readonly outputSchemaSha256: string
    readonly permissions: PluginDraftOperation['permissions']
    readonly dataScope: PluginDraftOperation['dataScope']
    readonly platforms: readonly string[]
    readonly architectures: readonly string[]
    readonly assets: readonly PluginAdapterAsset[]
    readonly sampleDigestClaim: HostPluginSampleDigestClaimRecord
  }[]
  readonly candidateSha256: string
  readonly state: 'private-candidate'
  readonly packageProduced: false
  readonly executionVerified: false
  readonly installable: false
  readonly dispatchable: false
}

type Registered = { readonly adapter: HostPluginAdapter; readonly generation: string }
type StoredSample = { readonly receipt: HostPluginSampleDigestClaimRecord; readonly generation: string;
  readonly draftId: string; readonly draftUpdatedAt: string; readonly draftSha256: string }

function refused(code: string): ComputeError { return new ComputeError(code, 409) }
function digest(value: unknown): value is string { return typeof value === 'string' && SHA256.test(value) }
function logicalBindingRef(value: unknown): value is string {
  if (typeof value !== 'string' || !LOGICAL_BINDING_REF.test(value) || value.includes('..')) return false
  return !UNSAFE_BINDING_NAMESPACES.has(value.slice(0, value.indexOf(':')))
}
function key(adapterId: string, adapterVersion: string, operationId: string): string {
  return `${adapterId}\u0000${adapterVersion}\u0000${operationId}`
}
function order(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => order(a, b))
      .map(([field, item]) => `${JSON.stringify(field)}:${canonical(item)}`).join(',')}}`
  }
  const scalar = JSON.stringify(value)
  if (scalar === undefined) throw refused('COMPUTE_PLUGIN_ADAPTER_INVALID')
  return scalar
}
function sha(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  }
  return value
}
function normalizedAssets(value: readonly PluginAdapterAsset[]): readonly PluginAdapterAsset[] {
  if (!Array.isArray(value) || value.length > 64) throw refused('COMPUTE_PLUGIN_ADAPTER_ASSET_INVALID')
  const result = value.map(asset => {
    if (!ID.test(asset.id) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !digest(asset.sha256)) {
      throw refused('COMPUTE_PLUGIN_ADAPTER_ASSET_INVALID')
    }
    return { id: asset.id, bytes: asset.bytes, sha256: asset.sha256 }
  }).sort((a, b) => order(a.id, b.id))
  if (new Set(result.map(asset => asset.id)).size !== result.length) throw refused('COMPUTE_PLUGIN_ADAPTER_ASSET_INVALID')
  return result
}
function claim(operation: PluginDraftOperation): unknown {
  return { permissions: [...operation.permissions].sort(), dataScope: operation.dataScope,
    networkOrigins: [...operation.networkOrigins].sort(),
    dependencies: [...operation.dependencies].sort((a, b) => order(a.id, b.id)),
    resources: { ...operation.resources,
      ...(operation.resources.platforms === undefined ? {} : { platforms: [...operation.resources.platforms].sort() }),
      ...(operation.resources.architectures === undefined ? {} : { architectures: [...operation.resources.architectures].sort() }) } }
}
function registeredClaim(adapter: HostPluginAdapter): unknown {
  return { permissions: [...adapter.permissions].sort(), dataScope: adapter.dataScope,
    networkOrigins: [...adapter.networkOrigins].sort(),
    dependencies: [...adapter.dependencies].sort((a, b) => order(a.id, b.id)),
    resources: { ...adapter.resources,
      ...(adapter.resources.platforms === undefined ? {} : { platforms: [...adapter.resources.platforms].sort() }),
      ...(adapter.resources.architectures === undefined ? {} : { architectures: [...adapter.resources.architectures].sort() }) } }
}

/** Bounded Host-local registry. Disposing/replacing an adapter invalidates earlier digest claims. */
export class HostPluginAdapterRegistry {
  private readonly adapters = new Map<string, Registered>()
  private readonly samples = new Map<string, StoredSample>()
  private highestSeenTimeMs = -1

  constructor(private readonly host: { readonly platform: string;
    readonly architecture: string; readonly now?: () => number }) {}

  /** Register an exact contract claim; no executable callback or proof of execution is accepted. */
  register(adapter: HostPluginAdapter): () => void {
    const now = this.time()
    this.prune(now)
    if (!ID.test(adapter.adapterId) || !VERSION.test(adapter.adapterVersion) || !ID.test(adapter.operationId)
      || !['local-model', 'workflow', 'tool'].includes(adapter.bindingKind)
      || !logicalBindingRef(adapter.bindingRef)
      || !digest(adapter.inputSchemaSha256) || !digest(adapter.outputSchemaSha256)
      || !Number.isSafeInteger(adapter.validUntilMs) || adapter.validUntilMs <= now
      || !Array.isArray(adapter.resources.platforms) || !(adapter.resources.platforms as readonly string[]).includes(this.host.platform)
      || (adapter.resources.architectures !== undefined
        && !(adapter.resources.architectures as readonly string[]).includes(this.host.architecture))) {
      throw refused('COMPUTE_PLUGIN_ADAPTER_INVALID')
    }
    const assets = normalizedAssets(adapter.assets)
    const identity = key(adapter.adapterId, adapter.adapterVersion, adapter.operationId)
    if (this.adapters.has(identity)) throw refused('COMPUTE_PLUGIN_ADAPTER_DUPLICATE')
    if (this.adapters.size >= MAX_ADAPTERS) throw refused('COMPUTE_PLUGIN_ADAPTER_CAPACITY')
    const generation = randomUUID()
    this.adapters.set(identity, { adapter: freezeDeep({ ...structuredClone(adapter), assets }), generation })
    return () => {
      if (this.adapters.get(identity)?.generation === generation) this.adapters.delete(identity)
    }
  }

  /** Read only bounded logical binding names; never discover or probe unrelated software. */
  listBindings(): readonly HostPluginAdapterListing[] {
    const now = this.time()
    this.prune(now)
    return Object.freeze([...this.adapters.values()]
      .filter(({ adapter }) => now < adapter.validUntilMs)
      .map(({ adapter }): HostPluginAdapterListing => Object.freeze({ operationId: adapter.operationId,
        adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion,
        bindingKind: adapter.bindingKind, bindingRef: adapter.bindingRef,
        state: 'registered-needs-sample', sampleRequired: true, executionVerified: false,
        validUntilMs: adapter.validUntilMs }))
      .sort((a, b) => order(`${a.adapterId}\u0000${a.adapterVersion}\u0000${a.operationId}`,
        `${b.adapterId}\u0000${b.adapterVersion}\u0000${b.operationId}`)))
  }

  /** Pre-run contract check only. It creates no digest claim and grants no execution authority. */
  checkDraftOperation(draft: LocalPluginDraft, operationId: string,
    adapterId: string, adapterVersion: string): void {
    const checked = this.checkedDraftOperation(draft, operationId)
    this.match(checked.draft, checked.operation, adapterId, adapterVersion)
  }

  /** Record caller-claimed digests only; never expose this as execution verification or an agent tool. */
  recordSampleDigestClaim(submission: HostPluginSampleDigestClaim): HostPluginSampleDigestClaimRecord {
    const { draft, operation, draftSha256 } = this.checkedDraftOperation(submission.draft, submission.operationId)
    const registered = this.match(draft, operation, submission.adapterId, submission.adapterVersion)
    if (!digest(submission.inputSha256) || !digest(submission.outputSha256)
      || canonical(normalizedAssets(submission.assets)) !== canonical(registered.adapter.assets)) {
      throw refused('COMPUTE_PLUGIN_SAMPLE_INVALID')
    }
    const claimedAtMs = this.time()
    this.prune(claimedAtMs)
    if (this.adapters.get(key(submission.adapterId, submission.adapterVersion,
      submission.operationId))?.generation !== registered.generation) {
      throw refused('COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE')
    }
    if (this.samples.size >= MAX_SAMPLE_DIGEST_CLAIMS) throw refused('COMPUTE_PLUGIN_SAMPLE_CAPACITY')
    const receipt: HostPluginSampleDigestClaimRecord = Object.freeze({ id: randomUUID(), operationId: operation.id,
      adapterId: registered.adapter.adapterId, adapterVersion: registered.adapter.adapterVersion,
      claimedAtMs, expiresAtMs: Math.min(claimedAtMs + MAX_SAMPLE_AGE_MS, registered.adapter.validUntilMs),
      inputSha256: submission.inputSha256, outputSha256: submission.outputSha256,
      assets: registered.adapter.assets })
    this.samples.set(receipt.id, { receipt, generation: registered.generation,
      draftId: draft.id, draftUpdatedAt: draft.updatedAt, draftSha256 })
    return receipt
  }

  /** Withdraw one opaque claim after a later sample or archive step fails. Revocation only removes authority. */
  revokeSampleDigestClaim(id: string): void { this.samples.delete(id) }

  /** Match every operation and fresh digest claim; result remains untrusted private metadata. */
  admitPrivateCandidate(draft: LocalPluginDraft, selections: readonly PluginAdapterSelection[]): PrivatePluginCandidate {
    this.prune(this.time())
    const checked = this.checkedDraft(draft)
    if (!Array.isArray(selections) || selections.length !== checked.draft.spec.operations.length
      || new Set(selections.map(item => item.operationId)).size !== selections.length) {
      throw refused('COMPUTE_PLUGIN_ADAPTER_SELECTION_INVALID')
    }
    const operations = checked.draft.spec.operations.map(operation => {
      const selected = selections.find(item => item.operationId === operation.id)
      if (selected === undefined) throw refused('COMPUTE_PLUGIN_ADAPTER_SELECTION_INVALID')
      const registered = this.match(checked.draft, operation, selected.adapterId, selected.adapterVersion)
      const stored = this.samples.get(selected.sampleDigestClaimId)
      const now = this.time()
      if (stored === undefined || stored.generation !== registered.generation
        || stored.draftId !== checked.draft.id || stored.draftUpdatedAt !== checked.draft.updatedAt
        || stored.draftSha256 !== checked.draftSha256 || stored.receipt.operationId !== operation.id
        || stored.receipt.adapterId !== selected.adapterId || stored.receipt.adapterVersion !== selected.adapterVersion
        || now >= stored.receipt.expiresAtMs) throw refused('COMPUTE_PLUGIN_SAMPLE_STALE')
      const plan = pluginDraftPlanManifest(checked.draft).operations.find(item => item.id === operation.id)!
      return Object.freeze({ operationId: operation.id, adapterId: selected.adapterId,
        adapterVersion: selected.adapterVersion, bindingKind: operation.binding.kind,
        bindingRef: operation.binding.ref, inputSchemaSha256: plan.inputSchemaSha256,
        outputSchemaSha256: plan.outputSchemaSha256, permissions: Object.freeze([...operation.permissions]),
        dataScope: operation.dataScope, platforms: Object.freeze([...(operation.resources.platforms ?? [])]),
        architectures: Object.freeze([...(operation.resources.architectures ?? [])]),
        assets: registered.adapter.assets, sampleDigestClaim: stored.receipt })
    })
    const base = { format: 'qianshou.private-plugin-candidate.v1' as const,
      draftId: checked.draft.id, draftUpdatedAt: checked.draft.updatedAt, draftSha256: checked.draftSha256,
      pluginId: checked.draft.spec.pluginId, version: checked.draft.spec.version, operations }
    return Object.freeze({ ...base, candidateSha256: sha(base), state: 'private-candidate' as const,
      packageProduced: false as const, executionVerified: false as const,
      installable: false as const, dispatchable: false as const })
  }

  /** Recheck private metadata against live registrations and digest claim tokens. */
  recheckPrivateCandidate(draft: LocalPluginDraft, candidate: PrivatePluginCandidate): PrivatePluginCandidate {
    if (candidate?.format !== 'qianshou.private-plugin-candidate.v1'
      || !Array.isArray(candidate.operations)
      || candidate.operations.some(operation => typeof operation.sampleDigestClaim?.id !== 'string')) {
      throw refused('COMPUTE_PLUGIN_CANDIDATE_INVALID')
    }
    const selections = candidate.operations.map(operation => ({ operationId: operation.operationId,
      adapterId: operation.adapterId, adapterVersion: operation.adapterVersion,
      sampleDigestClaimId: operation.sampleDigestClaim.id }))
    const current = this.admitPrivateCandidate(draft, selections)
    if (candidate.candidateSha256 !== current.candidateSha256 || canonical(candidate) !== canonical(current)) {
      throw refused('COMPUTE_PLUGIN_CANDIDATE_INVALID')
    }
    return current
  }

  private time(): number {
    const now = (this.host.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0) throw refused('COMPUTE_PLUGIN_ADAPTER_CLOCK_INVALID')
    if (now < this.highestSeenTimeMs) throw refused('COMPUTE_PLUGIN_ADAPTER_CLOCK_ROLLBACK')
    this.highestSeenTimeMs = now
    return now
  }

  private prune(now: number): void {
    for (const [identity, registered] of this.adapters) {
      if (now >= registered.adapter.validUntilMs) this.adapters.delete(identity)
    }
    for (const [id, stored] of this.samples) {
      const registered = this.adapters.get(key(stored.receipt.adapterId,
        stored.receipt.adapterVersion, stored.receipt.operationId))
      if (now >= stored.receipt.expiresAtMs || registered?.generation !== stored.generation) this.samples.delete(id)
    }
  }

  private checkedDraft(draft: LocalPluginDraft): { draft: LocalPluginDraft; draftSha256: string } {
    parsePluginDraftId(draft.id)
    const spec = parsePluginDraftSpec(draft.spec)
    if (draft.state !== 'private-draft' || draft.installable !== false || draft.dispatchable !== false
      || !Number.isFinite(Date.parse(draft.updatedAt))) throw refused('COMPUTE_PLUGIN_DRAFT_NOT_PRIVATE')
    return { draft: { ...draft, spec }, draftSha256: sha({ id: draft.id, updatedAt: draft.updatedAt, spec }) }
  }

  private checkedDraftOperation(draft: LocalPluginDraft, operationId: string): {
    draft: LocalPluginDraft; operation: PluginDraftOperation; draftSha256: string } {
    const checked = this.checkedDraft(draft)
    const operation = checked.draft.spec.operations.find(item => item.id === operationId)
    if (operation === undefined) throw refused('COMPUTE_PLUGIN_OPERATION_UNKNOWN')
    return { ...checked, operation }
  }

  private match(draft: LocalPluginDraft, operation: PluginDraftOperation,
    adapterId: string, adapterVersion: string): Registered {
    const registered = this.adapters.get(key(adapterId, adapterVersion, operation.id))
    if (registered === undefined || this.time() >= registered.adapter.validUntilMs) {
      throw refused('COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE')
    }
    const adapter = registered.adapter
    const plan = pluginDraftPlanManifest(draft).operations.find(item => item.id === operation.id)!
    if (adapter.bindingKind !== operation.binding.kind || adapter.bindingRef !== operation.binding.ref
      || adapter.inputSchemaSha256 !== plan.inputSchemaSha256
      || adapter.outputSchemaSha256 !== plan.outputSchemaSha256
      || canonical(registeredClaim(adapter)) !== canonical(claim(operation))
      || !(operation.resources.platforms as readonly string[] | undefined)?.includes(this.host.platform)
      || (operation.resources.architectures !== undefined
        && !(operation.resources.architectures as readonly string[]).includes(this.host.architecture))) {
      throw refused('COMPUTE_PLUGIN_ADAPTER_MISMATCH')
    }
    return registered
  }
}
