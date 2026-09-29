/** Bounded, read-only inspection of an owner-supplied ComfyUI API workflow. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'

const MAX_BYTES = 256 * 1024
const MAX_NODES = 128
const NODE_ID = /^[0-9]{1,12}$/u
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,95}$/u
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u
const TEXT_FIELDS = new Set(['text', 'prompt', 'negative_prompt', 'positive', 'negative'])
const SEED_FIELDS = new Set(['seed', 'noise_seed'])
const SIZE_FIELDS = new Set(['width', 'height'])
const MODEL_FIELDS = new Set(['ckpt_name', 'unet_name', 'clip_name', 'vae_name', 'lora_name', 'model_name'])
const IMAGE_OUTPUT_CLASSES = new Set(['SaveImage', 'SaveImageWebsocket'])

/** A structural input field. The inspection never returns its value. */
export interface ComfyWorkflowField {
  readonly nodeId: string
  readonly classType: string
  readonly field: string
}

/** Structural candidates for the owner to map; none is an executable binding. */
export interface ComfyWorkflowInspection {
  readonly format: 'comfyui-api-workflow'
  readonly sha256: string
  readonly nodeCount: number
  readonly classTypes: readonly string[]
  readonly textFields: readonly ComfyWorkflowField[]
  readonly seedFields: readonly ComfyWorkflowField[]
  readonly sizeFields: readonly ComfyWorkflowField[]
  readonly modelFields: readonly ComfyWorkflowField[]
  readonly imageOutputNodes: readonly { readonly nodeId: string; readonly classType: string }[]
  readonly state: 'needs-owner-mapping'
  readonly installable: false
  readonly dispatchable: false
}

function invalid(): ComputeError { return new ComputeError('COMPUTE_COMFY_WORKFLOW_INVALID', 400) }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Inspect a ComfyUI API export supplied in the conversation without reading files or executing nodes.
 * @param value - Untrusted API-format JSON object, not the editor's UI workflow format.
 * @returns Sanitized candidate fields and a digest for later owner review.
 */
export function inspectComfyApiWorkflow(value: unknown): ComfyWorkflowInspection {
  const graph = object(value)
  if (graph === null) throw invalid()
  const ids = Object.keys(graph)
  if (ids.length === 0 || ids.length > MAX_NODES || ids.some(id => !NODE_ID.test(id))) throw invalid()
  let serialized: string
  try { serialized = JSON.stringify(graph) } catch { throw invalid() }
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw invalid()

  const textFields: ComfyWorkflowField[] = []
  const seedFields: ComfyWorkflowField[] = []
  const sizeFields: ComfyWorkflowField[] = []
  const modelFields: ComfyWorkflowField[] = []
  const imageOutputNodes: Array<{ nodeId: string; classType: string }> = []
  const classTypes = new Set<string>()
  for (const nodeId of ids.sort((a, b) => Number(a) - Number(b))) {
    const node = object(graph[nodeId])
    const classType = node?.class_type
    const inputs = object(node?.inputs)
    if (node === null || typeof classType !== 'string' || !CLASS_NAME.test(classType)
      || inputs === null || Object.keys(inputs).length > 32) throw invalid()
    classTypes.add(classType)
    if (IMAGE_OUTPUT_CLASSES.has(classType)) imageOutputNodes.push({ nodeId, classType })
    for (const field of Object.keys(inputs)) {
      if (!FIELD_NAME.test(field)) throw invalid()
      const item = { nodeId, classType, field }
      const value = inputs[field]
      if (TEXT_FIELDS.has(field) && typeof value === 'string') textFields.push(item)
      if (SEED_FIELDS.has(field) && typeof value === 'number' && Number.isSafeInteger(value)) seedFields.push(item)
      if (SIZE_FIELDS.has(field) && typeof value === 'number' && Number.isSafeInteger(value)) sizeFields.push(item)
      if (MODEL_FIELDS.has(field) && typeof value === 'string') modelFields.push(item)
    }
  }
  return {
    format: 'comfyui-api-workflow', sha256: createHash('sha256').update(serialized).digest('hex'),
    nodeCount: ids.length, classTypes: [...classTypes].sort(), textFields, seedFields, sizeFields,
    modelFields, imageOutputNodes, state: 'needs-owner-mapping', installable: false, dispatchable: false,
  }
}
