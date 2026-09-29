/** Host-only, read-only contract for a private ComfyUI adapter candidate. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { parsePluginDraftId, type LocalPluginDraftStore } from './plugin-draft.ts'
import { parseStoredPrivateComfyDraftAsset } from './comfy-draft-asset.ts'
import { inspectComfyApiWorkflow } from './comfy-workflow-inspection.ts'
import { preflightLocalComfyWorkflow } from './comfy-workflow-preflight.ts'

const ID = /^[A-Za-z0-9._:-]{1,128}$/u
const SHA256 = /^[0-9a-f]{64}$/u

/** The only executor identity currently implemented by the Host for this graph family. */
export const PRIVATE_COMFY_EXECUTOR_CAPABILITY = 'comfy.private.sample'
export const PRIVATE_COMFY_EXECUTOR_VERSION = '1.0.0'

export interface PrivateComfyAdapterCandidateInput {
  readonly ownerId: string
  readonly draftId: string
  readonly operationId: string
  /** Exact graph digest shown to the owner at the private bind step. */
  readonly expectedGraphSha256: string
  /** Exact draft revision from the owner-scoped private store. */
  readonly expectedDraftUpdatedAt: string
  readonly port: number
  /** Version observed by trusted Host code, never accepted from an agent tool or market package. */
  readonly executor: { readonly capabilityId: string; readonly version: string }
  readonly signal: AbortSignal
}

/** A local review artifact, deliberately lacking executable graph bytes and all admission flags. */
export interface PrivateComfyAdapterCandidate {
  readonly format: 'qianshou.comfy-private-adapter-candidate.v1'
  readonly ownerId: string
  readonly draftId: string
  readonly operationId: string
  readonly draftUpdatedAt: string
  readonly graphSha256: string
  readonly nodeCount: number
  readonly nodeContractSha256: string
  readonly modelSelectorSha256: string
  readonly mappingSha256: string
  readonly loopbackPort: number
  readonly executor: { readonly capabilityId: typeof PRIVATE_COMFY_EXECUTOR_CAPABILITY;
    readonly version: typeof PRIVATE_COMFY_EXECUTOR_VERSION }
  readonly candidateSha256: string
  readonly state: 'needs-owner-runtime-review'
  readonly runnable: false
  readonly installable: false
  readonly dispatchable: false
}

function denied(code: string): ComputeError { return new ComputeError(code, 409) }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/**
 * Re-read the owner-scoped private draft and live loopback node options before making a review
 * candidate. The caller must supply the real account-scoped Host store and actual Host executor
 * identity. A candidate is never an approval to install, execute, publish or receive an order.
 */
export async function planPrivateComfyAdapterCandidate(value: PrivateComfyAdapterCandidateInput,
  options: { readonly drafts: Pick<LocalPluginDraftStore, 'list' | 'readComfyAsset'>;
    readonly fetcher?: typeof fetch }): Promise<PrivateComfyAdapterCandidate> {
  if (!value || !options || !options.drafts || !value.signal
    || typeof value.ownerId !== 'string' || !ID.test(value.ownerId)
    || typeof value.operationId !== 'string' || !ID.test(value.operationId)
    || typeof value.expectedGraphSha256 !== 'string' || !SHA256.test(value.expectedGraphSha256)
    || typeof value.expectedDraftUpdatedAt !== 'string' || !Number.isFinite(Date.parse(value.expectedDraftUpdatedAt))
    || !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535) {
    throw new ComputeError('COMPUTE_COMFY_ADAPTER_CANDIDATE_INVALID', 400)
  }
  const draftId = parsePluginDraftId(value.draftId)
  value.signal.throwIfAborted()
  if (value.executor?.capabilityId !== PRIVATE_COMFY_EXECUTOR_CAPABILITY
    || value.executor.version !== PRIVATE_COMFY_EXECUTOR_VERSION) {
    throw denied('COMPUTE_COMFY_ADAPTER_EXECUTOR_MISMATCH')
  }
  const draft = (await options.drafts.list()).find(item => item.id === draftId)
  if (!draft || draft.updatedAt !== value.expectedDraftUpdatedAt) throw denied('COMPUTE_COMFY_ADAPTER_DRAFT_CHANGED')
  const operation = draft.spec.operations.find(item => item.id === value.operationId)
  if (operation?.binding.kind !== 'workflow' || !operation.binding.ref.startsWith('comfy:')) {
    throw denied('COMPUTE_COMFY_ADAPTER_OWNER_BINDING_REQUIRED')
  }
  let rawAsset
  try { rawAsset = await options.drafts.readComfyAsset(draftId, value.operationId) }
  catch { throw denied('COMPUTE_COMFY_ADAPTER_OWNER_BINDING_REQUIRED') }
  const asset = parseStoredPrivateComfyDraftAsset(rawAsset)
  if (asset.operationId !== value.operationId || asset.graphSha256 !== value.expectedGraphSha256) {
    throw denied('COMPUTE_COMFY_ADAPTER_GRAPH_CHANGED')
  }
  const outputs = Object.values(asset.graph).filter(node => node.class_type === 'SaveImage' || node.class_type === 'SaveImageWebsocket')
  if (outputs.length !== 1 || outputs[0]?.class_type !== 'SaveImage'
    || asset.graph[asset.mapping.outputNodeId] !== outputs[0]) {
    throw denied('COMPUTE_COMFY_ADAPTER_OUTPUT_UNSUPPORTED')
  }
  const inspection = inspectComfyApiWorkflow(asset.graph)
  // A custom selector outside this bounded list cannot be proven available by the generic preflight.
  if (inspection.modelFields.length === 0) throw denied('COMPUTE_COMFY_ADAPTER_MODEL_UNVERIFIED')
  const preflight = await preflightLocalComfyWorkflow({ workflow: asset.graph, port: value.port },
    value.signal, options.fetcher)
  if (preflight.sha256 !== asset.graphSha256 || preflight.nodeCount !== asset.nodeCount
    || preflight.nodes.length !== asset.nodeCount
    || preflight.nodes.some(node => node.available !== true
      || node.modelFields.some(field => field.selectable !== true))) {
    throw denied('COMPUTE_COMFY_ADAPTER_PREFLIGHT_FAILED')
  }
  const nodeContract = preflight.nodes.map(node => ({ nodeId: node.nodeId, classType: node.classType }))
  const modelSelectors = inspection.modelFields.map(item => ({ nodeId: item.nodeId, classType: item.classType,
    field: item.field, value: asset.graph[item.nodeId]?.inputs[item.field] }))
  const fieldsSeen = preflight.nodes.flatMap(node => node.modelFields.map(field => `${node.nodeId}\u0000${field.field}`))
  if (fieldsSeen.length !== modelSelectors.length
    || modelSelectors.some(item => !fieldsSeen.includes(`${item.nodeId}\u0000${item.field}`))) {
    throw denied('COMPUTE_COMFY_ADAPTER_PREFLIGHT_FAILED')
  }
  const contract = {
    format: 'qianshou.comfy-private-adapter-candidate.v1' as const,
    ownerId: value.ownerId, draftId, operationId: value.operationId, draftUpdatedAt: draft.updatedAt,
    graphSha256: asset.graphSha256, nodeCount: asset.nodeCount,
    nodeContractSha256: hash(nodeContract), modelSelectorSha256: hash(modelSelectors),
    mappingSha256: hash(asset.mapping), loopbackPort: value.port,
    executor: { capabilityId: PRIVATE_COMFY_EXECUTOR_CAPABILITY,
      version: PRIVATE_COMFY_EXECUTOR_VERSION } as const,
  }
  return { ...contract, candidateSha256: hash(contract), state: 'needs-owner-runtime-review',
    runnable: false, installable: false, dispatchable: false }
}
