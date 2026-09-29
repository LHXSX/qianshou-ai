/** Host-owned sample execution for arbitrary registered plugin operations.
 *
 * Registration must happen in trusted Host code. This is an in-process trial,
 * not a sandbox, signature, owner approval, install or supply admission.
 */
import { randomUUID } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { HostPluginAdapterRegistry, type HostPluginAdapter, type PrivatePluginCandidate,
  type HostPluginAdapterListing, type PluginAdapterSelection } from './plugin-adapter-admission.ts'
import { parsePluginDraftId, parsePluginDraftSpec, type LocalPluginDraft } from './plugin-draft.ts'
import { buildOfflinePluginArtifact, matchesPluginDraftSchema, offlinePluginSampleSha256,
  type OfflinePluginArtifact, type OfflinePluginSample } from './offline-plugin-artifact.ts'

const MAX_SAMPLE_BYTES = 64 * 1024

export interface HostPluginSampleAdapter {
  readonly contract: HostPluginAdapter
  /** Trusted Host implementation. It must stop its own work and settle on abort;
   * otherwise the trial deliberately waits, because an in-process callback cannot be killed safely. */
  readonly run: (input: unknown, signal: AbortSignal) => Promise<unknown> | unknown
}

export interface PrivatePluginExecutedSample {
  readonly operationId: string
  readonly adapterId: string
  readonly adapterVersion: string
  readonly inputSha256: string
  readonly outputSha256: string
  readonly sampleDigestClaimId: string
  /** A callback returned an output; independent code review is not implied. */
  readonly scope: 'host-registered-in-process-callback'
  readonly sampleExecuted: true
}

export interface PrivatePluginSampleRun {
  readonly format: 'qianshou.private-plugin-sample-run.v1'
  readonly id: string
  readonly draftId: string
  readonly candidate: PrivatePluginCandidate
  /** Data-only archive containing sample I/O; keep private if inputs are sensitive. */
  readonly artifact: OfflinePluginArtifact
  readonly samples: readonly PrivatePluginExecutedSample[]
  /** Bounded actual outputs for an owner-facing trial preview; never include artifact bytes in a model tool result. */
  readonly results: readonly { readonly operationId: string; readonly output: unknown }[]
  readonly reviewVerified: false
  readonly installable: false
  readonly dispatchable: false
}

type RegisteredRunner = { readonly contract: HostPluginAdapter; readonly run: HostPluginSampleAdapter['run'] }

function refused(code: string): ComputeError { return new ComputeError(code, 409) }
function key(adapterId: string, adapterVersion: string, operationId: string): string {
  return `${adapterId}\u0000${adapterVersion}\u0000${operationId}`
}
function freezeJson(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
}
function jsonSample(value: unknown, limit: number): { readonly value: unknown; readonly sha256: string } {
  let copy: unknown
  try { copy = structuredClone(value) }
  catch { throw refused('COMPUTE_PLUGIN_SAMPLE_JSON_INVALID') }
  let encoded: string | undefined
  try { encoded = JSON.stringify(copy) }
  catch { throw refused('COMPUTE_PLUGIN_SAMPLE_JSON_INVALID') }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > Math.min(limit, MAX_SAMPLE_BYTES)) {
    throw refused('COMPUTE_PLUGIN_SAMPLE_SIZE_INVALID')
  }
  try {
    const sha256 = offlinePluginSampleSha256(copy)
    freezeJson(copy)
    return { value: copy, sha256 }
  }
  catch { throw refused('COMPUTE_PLUGIN_SAMPLE_JSON_INVALID') }
}

/** A private registry whose executable callbacks are never supplied by a draft or agent call. */
export class HostPluginSampleWorkbench {
  private readonly registry: HostPluginAdapterRegistry
  private readonly runners = new Map<string, RegisteredRunner>()
  private readonly activeRunners = new Set<string>()

  constructor(host: { readonly platform: string; readonly architecture: string; readonly now?: () => number }) {
    this.registry = new HostPluginAdapterRegistry(host)
  }

  register(adapter: HostPluginSampleAdapter): () => void {
    if (typeof adapter.run !== 'function') throw refused('COMPUTE_PLUGIN_SAMPLE_RUNNER_INVALID')
    const contract = structuredClone(adapter.contract)
    const identity = key(contract.adapterId, contract.adapterVersion, contract.operationId)
    const disposeContract = this.registry.register(contract)
    const registered = { contract, run: adapter.run }
    this.runners.set(identity, registered)
    return () => {
      if (this.runners.get(identity) === registered) {
        this.runners.delete(identity)
        disposeContract()
      }
    }
  }

  listBindings(): readonly HostPluginAdapterListing[] { return this.registry.listBindings() }

  /** Check every pinned operation against its current trusted Host callback and exact draft declaration. */
  assertPrivateCandidate(draft: LocalPluginDraft, candidate: PrivatePluginCandidate): void {
    const spec = parsePluginDraftSpec(draft.spec)
    if (candidate.draftId !== draft.id || candidate.draftUpdatedAt !== draft.updatedAt
      || candidate.pluginId !== spec.pluginId || candidate.version !== spec.version
      || candidate.operations.length !== spec.operations.length) {
      throw refused('COMPUTE_PRIVATE_PLUGIN_CANDIDATE_STALE')
    }
    for (const [index, operation] of spec.operations.entries()) {
      this.currentRunner(draft, candidate, operation.id, index)
    }
  }

  /** Validate one conversation input before asking the owner to authorize its exact digest. */
  privateOperationInputSha256(draft: LocalPluginDraft, candidate: PrivatePluginCandidate,
    operationId: string, input: unknown): string {
    this.assertPrivateCandidate(draft, candidate)
    const operation = draft.spec.operations.find(item => item.id === operationId)
    if (operation === undefined) throw refused('COMPUTE_PRIVATE_PLUGIN_OPERATION_UNKNOWN')
    const sample = jsonSample(input, operation.resources.maxInputBytes)
    if (!matchesPluginDraftSchema(sample.value, operation.inputSchema)) {
      throw refused('COMPUTE_PRIVATE_PLUGIN_INPUT_SCHEMA_INVALID')
    }
    return sample.sha256
  }

  /** Execute only a current trusted callback; validate both JSON schemas and recheck its registration. */
  async runPrivateOperation(draft: LocalPluginDraft, candidate: PrivatePluginCandidate,
    operationId: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    return this.withPrivateOperationLane(draft, candidate, operationId, input, signal,
      execute => execute())
  }

  /** Occupy the current adapter before a durable invocation reservation, then permit at most one callback. */
  async withPrivateOperationLane<T>(draft: LocalPluginDraft, candidate: PrivatePluginCandidate,
    operationId: string, input: unknown, signal: AbortSignal,
    action: (execute: () => Promise<unknown>) => Promise<T>): Promise<T> {
    this.assertPrivateCandidate(draft, candidate)
    const index = draft.spec.operations.findIndex(item => item.id === operationId)
    if (index < 0) throw refused('COMPUTE_PRIVATE_PLUGIN_OPERATION_UNKNOWN')
    const operation = draft.spec.operations[index]!
    const runner = this.currentRunner(draft, candidate, operationId, index)
    const sampleInput = jsonSample(input, operation.resources.maxInputBytes)
    if (!matchesPluginDraftSchema(sampleInput.value, operation.inputSchema)) {
      throw refused('COMPUTE_PRIVATE_PLUGIN_INPUT_SCHEMA_INVALID')
    }
    const release = this.occupy([runner])
    try {
      let executed = false
      return await action(async () => {
        if (executed) throw refused('COMPUTE_PRIVATE_PLUGIN_ALREADY_EXECUTED')
        executed = true
        signal.throwIfAborted()
        if (this.currentRunner(draft, candidate, operationId, index) !== runner) {
          throw refused('COMPUTE_PRIVATE_PLUGIN_ADAPTER_UNAVAILABLE')
        }
        const output = await runBounded(runner.run, structuredClone(sampleInput.value), signal,
          Math.min(operation.resources.maxRunMs, 120_000))
        signal.throwIfAborted()
        if (this.currentRunner(draft, candidate, operationId, index) !== runner) {
          throw refused('COMPUTE_PRIVATE_PLUGIN_ADAPTER_UNAVAILABLE')
        }
        const sampleOutput = jsonSample(output, operation.resources.maxOutputBytes)
        if (!matchesPluginDraftSchema(sampleOutput.value, operation.outputSchema)) {
          throw refused('COMPUTE_PRIVATE_PLUGIN_OUTPUT_SCHEMA_INVALID')
        }
        return sampleOutput.value
      })
    } finally {
      release()
    }
  }

  private occupy(runners: readonly RegisteredRunner[]): () => void {
    const identities = [...new Set(runners.map(runner =>
      `${runner.contract.adapterId}\u0000${runner.contract.adapterVersion}`))]
    if (identities.some(identity => this.activeRunners.has(identity))) {
      throw refused('COMPUTE_PRIVATE_PLUGIN_ADAPTER_BUSY')
    }
    for (const identity of identities) this.activeRunners.add(identity)
    return () => { for (const identity of identities) this.activeRunners.delete(identity) }
  }

  private currentRunner(draft: LocalPluginDraft, candidate: PrivatePluginCandidate,
    operationId: string, index: number): RegisteredRunner {
    const pinned = candidate.operations[index]
    if (pinned?.operationId !== operationId) throw refused('COMPUTE_PRIVATE_PLUGIN_CANDIDATE_STALE')
    this.registry.checkDraftOperation(draft, operationId, pinned.adapterId, pinned.adapterVersion)
    const runner = this.runners.get(key(pinned.adapterId, pinned.adapterVersion, operationId))
    if (runner === undefined || JSON.stringify([...runner.contract.assets].sort((a, b) => a.id.localeCompare(b.id)))
      !== JSON.stringify([...pinned.assets].sort((a, b) => a.id.localeCompare(b.id)))) {
      throw refused('COMPUTE_PRIVATE_PLUGIN_ADAPTER_UNAVAILABLE')
    }
    return runner
  }

  /** Run each operation exactly once, verify output schema and bind fresh digests to this draft revision. */
  async runPrivateSamples(draft: LocalPluginDraft,
    inputs: readonly { readonly operationId: string; readonly input: unknown }[],
    signal: AbortSignal): Promise<PrivatePluginSampleRun> {
    const id = parsePluginDraftId(draft.id)
    const spec = parsePluginDraftSpec(draft.spec)
    if (draft.state !== 'private-draft' || draft.installable !== false || draft.dispatchable !== false
      || typeof draft.createdAt !== 'string' || typeof draft.updatedAt !== 'string'
      || draft.createdAt.length > 40 || draft.updatedAt.length > 40
      || !Number.isFinite(Date.parse(draft.createdAt)) || !Number.isFinite(Date.parse(draft.updatedAt))
      || !Array.isArray(inputs) || inputs.length !== spec.operations.length
      || new Set(inputs.map(item => item.operationId)).size !== inputs.length) {
      throw refused('COMPUTE_PLUGIN_SAMPLE_DRAFT_INVALID')
    }
    const savedDraft: LocalPluginDraft = { id, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
      state: 'private-draft', installable: false, dispatchable: false,
      readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' },
      spec: structuredClone(spec) }
    signal.throwIfAborted()
    const bindings = this.registry.listBindings()
    const selected = spec.operations.map(operation => {
      const matches = bindings.filter(item => item.operationId === operation.id
        && item.bindingKind === operation.binding.kind && item.bindingRef === operation.binding.ref)
      const input = inputs.find(item => item.operationId === operation.id)
      if (matches.length !== 1 || input === undefined) throw refused('COMPUTE_PLUGIN_SAMPLE_ADAPTER_UNAVAILABLE')
      const match = matches[0]!
      const runner = this.runners.get(key(match.adapterId, match.adapterVersion, match.operationId))
      if (runner === undefined) throw refused('COMPUTE_PLUGIN_SAMPLE_ADAPTER_UNAVAILABLE')
      // Every contract must match before any operation is allowed to run.
      this.registry.checkDraftOperation(savedDraft, operation.id, match.adapterId, match.adapterVersion)
      const sampleInput = jsonSample(input.input, operation.resources.maxInputBytes)
      if (!matchesPluginDraftSchema(sampleInput.value, operation.inputSchema)) {
        throw refused('COMPUTE_PLUGIN_SAMPLE_INPUT_SCHEMA_INVALID')
      }
      return { operation, sampleInput, match, runner }
    })
    const selections: PluginAdapterSelection[] = []
    const samples: OfflinePluginSample[] = []
    const executed: PrivatePluginExecutedSample[] = []
    const results: Array<{ readonly operationId: string; readonly output: unknown }> = []
    const release = this.occupy(selected.map(item => item.runner))
    try {
      for (const item of selected) {
        signal.throwIfAborted()
        if (this.runners.get(key(item.match.adapterId, item.match.adapterVersion, item.match.operationId)) !== item.runner) {
          throw refused('COMPUTE_PLUGIN_SAMPLE_ADAPTER_UNAVAILABLE')
        }
        const output = await runBounded(item.runner.run, structuredClone(item.sampleInput.value),
          signal, item.operation.resources.maxRunMs)
        signal.throwIfAborted()
        if (this.runners.get(key(item.match.adapterId, item.match.adapterVersion, item.match.operationId)) !== item.runner) {
          throw refused('COMPUTE_PLUGIN_SAMPLE_ADAPTER_UNAVAILABLE')
        }
        const sampleOutput = jsonSample(output, item.operation.resources.maxOutputBytes)
        if (!matchesPluginDraftSchema(sampleOutput.value, item.operation.outputSchema)) {
          throw refused('COMPUTE_PLUGIN_SAMPLE_OUTPUT_SCHEMA_INVALID')
        }
        const claim = this.registry.recordSampleDigestClaim({ draft: savedDraft, operationId: item.operation.id,
          adapterId: item.match.adapterId, adapterVersion: item.match.adapterVersion,
          inputSha256: item.sampleInput.sha256, outputSha256: sampleOutput.sha256,
          assets: item.runner.contract.assets })
        selections.push({ operationId: item.operation.id, adapterId: item.match.adapterId,
          adapterVersion: item.match.adapterVersion, sampleDigestClaimId: claim.id })
        samples.push({ operationId: item.operation.id, input: item.sampleInput.value, output: sampleOutput.value })
        results.push(Object.freeze({ operationId: item.operation.id, output: sampleOutput.value }))
        executed.push(Object.freeze({ operationId: item.operation.id, adapterId: item.match.adapterId,
          adapterVersion: item.match.adapterVersion, inputSha256: item.sampleInput.sha256,
          outputSha256: sampleOutput.sha256, sampleDigestClaimId: claim.id,
          scope: 'host-registered-in-process-callback', sampleExecuted: true }))
      }
      const candidate = this.registry.admitPrivateCandidate(savedDraft, selections)
      // This validates the exact sample JSON against the bounded draft schemas.
      const artifact = buildOfflinePluginArtifact({ registry: this.registry, draft: savedDraft, candidate, samples })
      return Object.freeze({ format: 'qianshou.private-plugin-sample-run.v1', id: randomUUID(),
        draftId: savedDraft.id, candidate, artifact, samples: Object.freeze(executed),
        results: Object.freeze(results),
        reviewVerified: false, installable: false, dispatchable: false })
    } catch (error) {
      for (const selection of selections) this.registry.revokeSampleDigestClaim(selection.sampleDigestClaimId)
      throw error
    } finally {
      release()
    }
  }
}

async function runBounded(run: HostPluginSampleAdapter['run'], input: unknown,
  signal: AbortSignal, maxRunMs: number): Promise<unknown> {
  signal.throwIfAborted()
  const startedAt = Date.now()
  const controller = new AbortController()
  let stopped: 'aborted' | 'timeout' | undefined
  const aborted = () => { stopped = 'aborted'; controller.abort() }
  signal.addEventListener('abort', aborted, { once: true })
  if (signal.aborted) aborted()
  const timer = setTimeout(() => {
    if (stopped === undefined) stopped = 'timeout'
    controller.abort()
  }, maxRunMs)
  try {
    controller.signal.throwIfAborted()
    // Wait for a cooperative Host callback to settle before returning even after abort.
    // In-process callbacks cannot be forcibly killed; arbitrary third-party code needs process isolation.
    const result = await run(input, controller.signal)
    if (stopped !== undefined || signal.aborted || Date.now() - startedAt >= maxRunMs) {
      throw refused(stopped === 'aborted' || signal.aborted
        ? 'COMPUTE_PLUGIN_SAMPLE_ABORTED' : 'COMPUTE_PLUGIN_SAMPLE_TIMEOUT')
    }
    return result
  } catch (error) {
    if (stopped !== undefined || signal.aborted || Date.now() - startedAt >= maxRunMs) {
      throw refused(stopped === 'aborted' || signal.aborted
        ? 'COMPUTE_PLUGIN_SAMPLE_ABORTED' : 'COMPUTE_PLUGIN_SAMPLE_TIMEOUT')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', aborted)
  }
}
