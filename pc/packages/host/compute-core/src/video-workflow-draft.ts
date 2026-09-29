/** Owner-private ComfyUI video graph drafts. Saving a graph grants no runtime authority. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canonicalComfyVideoApiGraphJson, summarizeComfyVideoApiGraph } from './comfy-video-public-contract.ts'
import { ComputeError } from './errors.ts'

const DRAFT_ID = /^video_draft_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const NODE_ID = /^[0-9]{1,12}$/u
const TEXT_FIELD = new Set(['text', 'prompt', 'positive'])
const FRAME_FIELD = new Set(['length', 'frames', 'frame_count'])
const OUTPUT_CLASS = new Set(['VHS_VideoCombine', 'SaveVideo'])
const MAX_GRAPH_BYTES = 256 * 1024
const MAX_STORE_BYTES = 32 * 1024 * 1024
const MAX_DRAFTS = 100

type Ref = Readonly<{ nodeId: string; field: string }>
/** Private binding of owner-editable inputs to graph nodes and an MP4 output. */
export interface VideoWorkflowDraftMapping {
  readonly prompt: Ref
  readonly referenceImage?: Readonly<{ nodeId: string; field: 'image' }>
  readonly frames?: Readonly<{ nodeId: string; field: 'length' | 'frames' | 'frame_count' }>
  readonly outputNodeId: string
}
/** Safe owner-facing metadata for a saved graph; no graph or model bytes. */
export interface VideoWorkflowDraftSummary {
  readonly id: string
  readonly displayName: string
  readonly template: 'text-to-video' | 'image-to-video'
  readonly state: 'private-draft'
  readonly graphSha256: string
  readonly nodeCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly installable: false
  readonly dispatchable: false
}
/** Trusted Host-only readback for an exact draft revision; never expose through the owner HTTP route. */
export interface PrivateVideoWorkflowDraft {
  readonly summary: VideoWorkflowDraftSummary
  readonly graphJson: string
  readonly mapping: VideoWorkflowDraftMapping
}
interface StoredVideoWorkflowDraft extends VideoWorkflowDraftSummary {
  readonly graph: unknown
  readonly mapping: VideoWorkflowDraftMapping
}
interface SaveRequest {
  readonly id?: string
  readonly expectedUpdatedAt?: string
  readonly displayName: string
  readonly template: 'text-to-video' | 'image-to-video'
  readonly graph: unknown
  readonly mapping: VideoWorkflowDraftMapping
}

function invalid(): never { throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_INVALID', 400) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: readonly string[], required = allowed): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid()
}
function ref(value: unknown, allowed: ReadonlySet<string>): Ref {
  const item = object(value)
  fields(item, ['nodeId', 'field'])
  if (typeof item.nodeId !== 'string' || !NODE_ID.test(item.nodeId)
    || typeof item.field !== 'string' || !allowed.has(item.field)) invalid()
  return { nodeId: item.nodeId, field: item.field }
}
function parseMapping(value: unknown, template: SaveRequest['template'], graph: Record<string, unknown>): VideoWorkflowDraftMapping {
  const item = object(value)
  fields(item, ['prompt', 'referenceImage', 'frames', 'outputNodeId'], ['prompt', 'outputNodeId'])
  const prompt = ref(item.prompt, TEXT_FIELD)
  const referenceImage = item.referenceImage === undefined ? undefined : ref(item.referenceImage, new Set(['image']))
  const frames = item.frames === undefined ? undefined : ref(item.frames, FRAME_FIELD)
  if (template === 'image-to-video' ? referenceImage === undefined : referenceImage !== undefined) invalid()
  // A fixed local filename cannot silently become a buyer input. This first draft ABI
  // supports exactly one declared image slot; other media loaders need a later contract.
  const images = Object.entries(graph).filter(([, raw]) => object(raw).class_type === 'LoadImage')
  if (images.length !== (template === 'image-to-video' ? 1 : 0)
    || images.some(([nodeId]) => referenceImage?.nodeId !== nodeId)
    || Object.values(graph).some(raw => /^(?:VHS_)?Load(?:Video|Audio|ImageMask)/u.test(String(object(raw).class_type)))) invalid()
  if (typeof item.outputNodeId !== 'string' || !NODE_ID.test(item.outputNodeId)) invalid()
  const readInput = (selected: Ref): unknown => {
    if (!Object.hasOwn(graph, selected.nodeId)) invalid()
    return object(object(graph[selected.nodeId]).inputs)[selected.field]
  }
  if (frames !== undefined && object(graph[frames.nodeId]).class_type === 'ImageFromBatch') invalid()
  if (typeof readInput(prompt) !== 'string'
    || (referenceImage !== undefined && typeof readInput(referenceImage) !== 'string')
    || (frames !== undefined && (!Number.isSafeInteger(readInput(frames))
      || (readInput(frames) as number) < 1 || (readInput(frames) as number) > 7200))) invalid()
  if (!Object.hasOwn(graph, item.outputNodeId)) invalid()
  const output = object(graph[item.outputNodeId])
  if (typeof output.class_type !== 'string' || !OUTPUT_CLASS.has(output.class_type)) invalid()
  const format = object(output.inputs).format
  if (output.class_type === 'VHS_VideoCombine' ? format !== 'video/h264-mp4'
    : format !== 'mp4' && format !== 'video/mp4') invalid()
  const outputs = Object.values(graph).filter(raw => OUTPUT_CLASS.has(object(raw).class_type as string))
  if (outputs.length !== 1 || outputs[0] !== output) invalid()
  return { prompt, ...(referenceImage === undefined ? {} : { referenceImage: referenceImage as { nodeId: string; field: 'image' } }),
    ...(frames === undefined ? {} : { frames: frames as { nodeId: string; field: 'length' | 'frames' | 'frame_count' } }),
    outputNodeId: item.outputNodeId }
}

function parseSave(value: unknown): SaveRequest {
  const item = object(value)
  fields(item, ['id', 'expectedUpdatedAt', 'displayName', 'template', 'graph', 'mapping'],
    ['displayName', 'template', 'graph', 'mapping'])
  if ((item.id !== undefined && (typeof item.id !== 'string' || !DRAFT_ID.test(item.id)))
    || (item.id === undefined ? item.expectedUpdatedAt !== undefined
      : typeof item.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(item.expectedUpdatedAt)))
    || typeof item.displayName !== 'string' || item.displayName.trim() !== item.displayName
    || item.displayName.length < 2 || item.displayName.length > 80
    || /[\u0000-\u001f\u007f]/u.test(item.displayName)
    || (item.template !== 'text-to-video' && item.template !== 'image-to-video')) invalid()
  const graphJson = canonicalComfyVideoApiGraphJson(item.graph)
  if (Buffer.byteLength(graphJson, 'utf8') > MAX_GRAPH_BYTES) invalid()
  const graph = JSON.parse(graphJson) as Record<string, unknown>
  const mapping = parseMapping(item.mapping, item.template, graph)
  return { ...(item.id === undefined ? {} : { id: item.id, expectedUpdatedAt: item.expectedUpdatedAt as string }),
    displayName: item.displayName, template: item.template, graph, mapping }
}

function summary(item: StoredVideoWorkflowDraft): VideoWorkflowDraftSummary {
  const { id, displayName, template, state, graphSha256, nodeCount, createdAt, updatedAt, installable, dispatchable } = item
  return { id, displayName, template, state, graphSha256, nodeCount, createdAt, updatedAt, installable, dispatchable }
}

/** Private durable graph store; never sends graph bytes to Shanghai or lists them to the UI. */
export class VideoWorkflowDraftStore {
  constructor(private readonly path: string) { if (!isAbsolute(path)) invalid() }

  private async read(): Promise<StoredVideoWorkflowDraft[]> {
    let file
    try {
      const info = await lstat(this.path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_STORE_BYTES) invalid()
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const bytes = await file.readFile()
      if (bytes.byteLength > MAX_STORE_BYTES) invalid()
      const root = object(JSON.parse(bytes.toString('utf8')) as unknown)
      fields(root, ['version', 'drafts'])
      if (root.version !== 1 || !Array.isArray(root.drafts) || root.drafts.length > MAX_DRAFTS) invalid()
      const seen = new Set<string>()
      return root.drafts.map((raw: unknown): StoredVideoWorkflowDraft => {
        const item = object(raw)
        fields(item, ['id', 'displayName', 'template', 'state', 'graphSha256', 'nodeCount',
          'createdAt', 'updatedAt', 'installable', 'dispatchable', 'graph', 'mapping'])
        const parsed = parseSave({ displayName: item.displayName, template: item.template,
          graph: item.graph, mapping: item.mapping })
        const graph = summarizeComfyVideoApiGraph(parsed.graph)
        if (typeof item.id !== 'string' || !DRAFT_ID.test(item.id) || seen.has(item.id)
          || item.graphSha256 !== graph.sha256 || item.nodeCount !== graph.nodeCount
          || item.state !== 'private-draft' || item.installable !== false || item.dispatchable !== false
          || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
          || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) invalid()
        seen.add(item.id)
        return { id: item.id, displayName: parsed.displayName, template: parsed.template,
          state: 'private-draft', graphSha256: graph.sha256, nodeCount: graph.nodeCount,
          createdAt: item.createdAt, updatedAt: item.updatedAt, installable: false,
          dispatchable: false, graph: parsed.graph, mapping: parsed.mapping }
      })
    } catch { throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_STORE_INVALID', 503) }
    finally { await file.close() }
  }

  /** List private draft metadata without disclosing workflow graph bytes.
   * @returns Owner-local draft summaries.
   */
  async list(): Promise<VideoWorkflowDraftSummary[]> { return (await this.read()).map(summary) }

  /** Read an immutable draft revision inside the trusted Host process.
   * @param id - Local draft identity.
   * @param expectedGraphSha256 - Graph digest recorded before dispatch.
   * @returns Canonical graph and binding only when the digest still matches.
   */
  async readPrivate(id: string, expectedGraphSha256: string): Promise<PrivateVideoWorkflowDraft> {
    if (!DRAFT_ID.test(id) || !/^[a-f0-9]{64}$/u.test(expectedGraphSha256)) invalid()
    const draft = (await this.read()).find(item => item.id === id)
    if (draft === undefined) throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_NOT_FOUND', 404)
    if (draft.graphSha256 !== expectedGraphSha256) throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_CHANGED', 409)
    return { summary: summary(draft), graphJson: canonicalComfyVideoApiGraphJson(draft.graph), mapping: draft.mapping }
  }

  /** Atomically save an owner-private graph without installing or advertising it.
   * @param value - Untrusted owner request validated with the graph.
   * @returns Identity and exact digest of the saved revision.
   */
  async save(value: unknown): Promise<VideoWorkflowDraftSummary> {
    const request = parseSave(value)
    const graph = summarizeComfyVideoApiGraph(request.graph)
    const parent = dirname(this.path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_STORE_INVALID', 503)
    }
    return withFileLock(this.path, async () => {
      const current = await this.read()
      const previous = request.id === undefined ? undefined : current.find(item => item.id === request.id)
      if (request.id !== undefined && previous === undefined) throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_NOT_FOUND', 404)
      if (previous !== undefined && previous.updatedAt !== request.expectedUpdatedAt) {
        throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_CHANGED', 409)
      }
      if (previous === undefined && current.length >= MAX_DRAFTS) throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_CAPACITY', 409)
      const now = new Date().toISOString()
      const item: StoredVideoWorkflowDraft = { id: previous?.id ?? `video_draft_${randomUUID()}`,
        displayName: request.displayName, template: request.template, state: 'private-draft',
        graphSha256: graph.sha256, nodeCount: graph.nodeCount, createdAt: previous?.createdAt ?? now,
        updatedAt: now, installable: false, dispatchable: false, graph: request.graph, mapping: request.mapping }
      const content = JSON.stringify({ version: 1, drafts: [item, ...current.filter(draft => draft.id !== item.id)] })
      if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_CAPACITY', 409)
      await writeFileAtomic(this.path, content, { mode: 0o600, dirMode: 0o700 })
      return summary(item)
    })
  }
}
