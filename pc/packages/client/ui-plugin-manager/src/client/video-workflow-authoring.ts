/** Browser-side guidance for an owner-selected ComfyUI API video graph. Host review remains authoritative. */

const MAX_FILE_BYTES = 256 * 1024
const NODE_ID = /^[0-9]{1,12}$/u
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_:. -]{0,95}$/u
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u
const TEXT_FIELDS = new Set(['text', 'prompt', 'positive'])
const FRAME_FIELDS = new Set(['length', 'frames', 'frame_count'])
const OUTPUT_CLASSES = new Set(['VHS_VideoCombine', 'SaveVideo'])

/** User-visible starting point for one video workflow draft. */
export type VideoWorkflowTemplate = 'text-to-video' | 'image-to-video'
/** Editable ComfyUI input discovered in an API-format graph. */
export interface VideoWorkflowField { readonly nodeId: string; readonly classType: string; readonly field: string }
/** Bounded graph summary used by the design wizard without exposing model names. */
export interface VideoWorkflowInspection {
  readonly graph: Readonly<Record<string, unknown>>
  readonly nodeCount: number
  readonly prompts: readonly VideoWorkflowField[]
  readonly images: readonly VideoWorkflowField[]
  readonly frames: readonly VideoWorkflowField[]
  readonly output: Readonly<{ nodeId: string; classType: string }>
}
/** Owner-selected input and MP4 output nodes retained with the private graph. */
export type VideoWorkflowMapping = Readonly<{
  prompt: Readonly<{ nodeId: string; field: string }>
  referenceImage?: Readonly<{ nodeId: string; field: 'image' }>
  frames?: Readonly<{ nodeId: string; field: 'length' | 'frames' | 'frame_count' }>
  outputNodeId: string
}>
/** Request to save the owner's graph and selected input nodes locally. */
export interface VideoWorkflowDraftSave {
  readonly displayName: string
  readonly template: VideoWorkflowTemplate
  readonly graph: Readonly<Record<string, unknown>>
  readonly mapping: VideoWorkflowMapping
}
/** Private draft identity returned by the Host; it grants no execution authority. */
export interface VideoWorkflowDraftReceipt {
  readonly id: string
  readonly displayName: string
  readonly state: 'private-draft'
  readonly graphSha256: string
  readonly installable: false
  readonly dispatchable: false
}
/** Local authenticated carrier for private draft reads and writes. */
export interface VideoWorkflowDraftTransport {
  save(request: VideoWorkflowDraftSave): Promise<VideoWorkflowDraftReceipt>
  list(): Promise<readonly VideoWorkflowDraftReceipt[]>
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

/** Only returns structural field choices; prompt text and model names stay out of the UI summary.
 * @param value - Parsed ComfyUI API-format graph.
 * @returns Bounded mapping choices, or null for an unsupported graph.
 */
export function inspectVideoApiGraph(value: unknown): VideoWorkflowInspection | null {
  const graph = record(value)
  if (graph === null) return null
  const ids = Object.keys(graph)
  if (ids.length < 1 || ids.length > 128 || ids.some(id => !NODE_ID.test(id))) return null
  const prompts: VideoWorkflowField[] = []
  const images: VideoWorkflowField[] = []
  const frames: VideoWorkflowField[] = []
  const outputs: Array<{ nodeId: string; classType: string }> = []
  for (const nodeId of ids) {
    const node = record(graph[nodeId])
    const classType = node?.class_type
    const inputs = record(node?.inputs)
    if (node === null || typeof classType !== 'string' || !CLASS_NAME.test(classType)
      || inputs === null || Object.keys(inputs).length > 32
      || Object.keys(inputs).some(field => !FIELD_NAME.test(field))) return null
    if (OUTPUT_CLASSES.has(classType)) {
      const format = inputs.format
      if (classType === 'VHS_VideoCombine' ? format !== 'video/h264-mp4'
        : format !== 'mp4' && format !== 'video/mp4') return null
      outputs.push({ nodeId, classType })
    }
    for (const [field, input] of Object.entries(inputs)) {
      const candidate = { nodeId, classType, field }
      if (TEXT_FIELDS.has(field) && typeof input === 'string') prompts.push(candidate)
      if (classType === 'LoadImage' && field === 'image' && typeof input === 'string') images.push(candidate)
      // ImageFromBatch.length trims preview frames; exposing it as generation length
      // would make an ordinary user alter the wrong node in H3-like graphs.
      if (classType !== 'ImageFromBatch' && FRAME_FIELDS.has(field)
        && Number.isSafeInteger(input) && Number(input) > 0) frames.push(candidate)
    }
  }
  const output = outputs[0]
  if (prompts.length < 1 || outputs.length !== 1 || output === undefined) return null
  return { graph, nodeCount: ids.length, prompts, images, frames, output }
}

/** Read an exact UTF-8 API export. The editor's UI-format JSON is intentionally refused.
 * @param file - Owner-selected JSON file.
 * @returns Bounded graph choices, or null for an invalid export.
 */
export async function readVideoApiGraphFile(file: File): Promise<VideoWorkflowInspection | null> {
  if (file.size < 1 || file.size > MAX_FILE_BYTES || !file.name.toLowerCase().endsWith('.json')) return null
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())) as unknown }
  catch { return null }
  return inspectVideoApiGraph(raw)
}
