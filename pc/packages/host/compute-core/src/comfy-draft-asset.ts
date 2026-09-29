/** Private, data-only ComfyUI graph binding for a local plugin design draft. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { inspectComfyApiWorkflow, type ComfyWorkflowField } from './comfy-workflow-inspection.ts'

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const NODE_ID = /^[0-9]{1,12}$/u
const SENSITIVE_FIELD = /(?:api_?key|secret|token|password|authorization|cookie|credential|private_?key)/iu
const SENSITIVE_LOCATION = /(?:url|endpoint|host|path|directory|folder)/iu
const FILE_FIELD = /^(?:image|video|audio|file|filename|input_file|output_file)$/iu
const SAFE_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u
const UNSAFE_VALUE = /(?:https?:\/\/|file:\/\/|-----BEGIN )/iu

function unsafeValue(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return UNSAFE_VALUE.test(value) || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized) || normalized.split('/').includes('..')
}

export interface ComfyDraftFieldRef { readonly nodeId: string; readonly field: string }

/** Owner-confirmed input and output nodes; these do not authorize execution. */
export interface ComfyDraftMapping {
  readonly prompt: ComfyDraftFieldRef
  readonly negativePrompt?: ComfyDraftFieldRef
  readonly seed?: ComfyDraftFieldRef
  readonly width?: ComfyDraftFieldRef
  readonly height?: ComfyDraftFieldRef
  readonly outputNodeId: string
}

export interface PrivateComfyDraftAsset {
  readonly format: 'qianshou.comfy-private-binding.v1'
  readonly operationId: string
  readonly graphSha256: string
  readonly nodeCount: number
  readonly mapping: ComfyDraftMapping
  /** Never returned to a model-facing read or included in a package preview. */
  readonly graph: Readonly<Record<string, { readonly class_type: string; readonly inputs: Readonly<Record<string, unknown>> }>>
}

export interface ComfyDraftAssetSummary {
  readonly operationId: string
  readonly graphSha256: string
  readonly nodeCount: number
  readonly state: 'stored-needs-trial'
  readonly runnable: false
  readonly installable: false
  readonly dispatchable: false
}

function invalid(): ComputeError { return new ComputeError('COMPUTE_COMFY_DRAFT_ASSET_INVALID', 400) }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function only(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).every(name => names.includes(name))
}
function fieldRef(value: unknown, candidates: readonly ComfyWorkflowField[]): ComfyDraftFieldRef {
  const item = record(value)
  if (item === null || !only(item, ['nodeId', 'field']) || typeof item.nodeId !== 'string'
    || typeof item.field !== 'string' || !candidates.some(candidate => candidate.nodeId === item.nodeId && candidate.field === item.field)) throw invalid()
  return { nodeId: item.nodeId, field: item.field }
}

/** Validate and normalize a supplied graph without touching files or a ComfyUI server. */
export function preparePrivateComfyDraftAsset(value: unknown): PrivateComfyDraftAsset {
  const request = record(value)
  if (request === null || !only(request, ['operationId', 'workflow', 'mapping'])
    || typeof request.operationId !== 'string' || !OPERATION_ID.test(request.operationId)) throw invalid()
  const inspection = inspectComfyApiWorkflow(request.workflow)
  const original = record(request.workflow)
  const mapping = record(request.mapping)
  if (original === null || mapping === null || !only(mapping, ['prompt', 'negativePrompt', 'seed', 'width', 'height', 'outputNodeId'])) throw invalid()
  const prompt = fieldRef(mapping.prompt, inspection.textFields)
  const negativePrompt = mapping.negativePrompt === undefined ? undefined : fieldRef(mapping.negativePrompt, inspection.textFields)
  if (negativePrompt !== undefined && negativePrompt.nodeId === prompt.nodeId && negativePrompt.field === prompt.field) throw invalid()
  const seed = mapping.seed === undefined ? undefined : fieldRef(mapping.seed, inspection.seedFields)
  const width = mapping.width === undefined ? undefined : fieldRef(mapping.width, inspection.sizeFields.filter(item => item.field === 'width'))
  const height = mapping.height === undefined ? undefined : fieldRef(mapping.height, inspection.sizeFields.filter(item => item.field === 'height'))
  const outputNodeId = mapping.outputNodeId
  if (typeof outputNodeId !== 'string' || !inspection.imageOutputNodes.some(item => item.nodeId === outputNodeId)) throw invalid()
  const normalized: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}
  for (const nodeId of Object.keys(original).sort((a, b) => Number(a) - Number(b))) {
    const node = record(original[nodeId])
    const inputs = record(node?.inputs)
    if (node === null || inputs === null || !only(node, ['class_type', 'inputs', '_meta'])
      || typeof node.class_type !== 'string') throw invalid()
    const safeInputs: Record<string, unknown> = {}
    for (const [field, raw] of Object.entries(inputs)) {
      if (SENSITIVE_FIELD.test(field) || SENSITIVE_LOCATION.test(field)) throw invalid()
      if (field === 'filename_prefix') {
        if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/u.test(raw)) throw invalid()
        safeInputs[field] = raw
        continue
      }
      if (Array.isArray(raw)) {
        if (raw.length !== 2 || typeof raw[0] !== 'string' || !NODE_ID.test(raw[0])
          || !Object.hasOwn(original, raw[0]) || typeof raw[1] !== 'number'
          || !Number.isSafeInteger(raw[1]) || raw[1] < 0 || raw[1] > 255) throw invalid()
        safeInputs[field] = [raw[0], raw[1]]
      } else if (typeof raw === 'string') {
        if ((FILE_FIELD.test(field) && !SAFE_FILE_NAME.test(raw))
          || Buffer.byteLength(raw) > 8192 || /[\u0000\u007f]/u.test(raw)
          || unsafeValue(raw)) throw invalid()
        safeInputs[field] = raw
      } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        safeInputs[field] = raw
      } else if (typeof raw === 'boolean') {
        safeInputs[field] = raw
      } else throw invalid()
    }
    normalized[nodeId] = { class_type: node.class_type, inputs: safeInputs }
  }
  const bytes = JSON.stringify(normalized)
  if (Buffer.byteLength(bytes) > 256 * 1024) throw invalid()
  return { format: 'qianshou.comfy-private-binding.v1', operationId: request.operationId,
    graphSha256: createHash('sha256').update(bytes).digest('hex'), nodeCount: inspection.nodeCount,
    mapping: { prompt, ...(negativePrompt === undefined ? {} : { negativePrompt }),
      ...(seed === undefined ? {} : { seed }), ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }), outputNodeId }, graph: normalized }
}

/** Revalidate private disk bytes, including their graph checksum, before internal readback. */
export function parseStoredPrivateComfyDraftAsset(value: unknown): PrivateComfyDraftAsset {
  const stored = record(value)
  if (stored === null || !only(stored, ['format', 'operationId', 'graphSha256', 'nodeCount', 'mapping', 'graph'])
    || stored.format !== 'qianshou.comfy-private-binding.v1') throw invalid()
  const parsed = preparePrivateComfyDraftAsset({ operationId: stored.operationId, workflow: stored.graph, mapping: stored.mapping })
  if (stored.graphSha256 !== parsed.graphSha256 || stored.nodeCount !== parsed.nodeCount
    || JSON.stringify(stored.graph) !== JSON.stringify(parsed.graph)) throw invalid()
  return parsed
}

/** Safe model-facing receipt; prompts, model filenames and graph metadata stay private. */
export function privateComfyDraftAssetSummary(asset: PrivateComfyDraftAsset): ComfyDraftAssetSummary {
  return { operationId: asset.operationId, graphSha256: asset.graphSha256, nodeCount: asset.nodeCount,
    state: 'stored-needs-trial', runnable: false, installable: false, dispatchable: false }
}
