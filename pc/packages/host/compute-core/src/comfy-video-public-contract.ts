/** Data-only publication contract for an owner-authored ComfyUI video workflow. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'

/** A separate ABI: fixed H3 and private image trials retain their existing identities. */
export const COMFY_VIDEO_RUNNER_ABI = 'qianshou.comfy-video-runner.v1' as const

const HASH = /^[a-f0-9]{64}$/u
const TASK = /^[a-z][a-z0-9_]{2,63}$/u
const NODE_ID = /^[0-9]{1,12}$/u
// Comfy custom nodes can use readable names such as "LayerUtility: PurgeVRAM V2".
// This is syntax only; the installed-node allowlist belongs to later runtime admission.
const CLASS = /^[A-Za-z][A-Za-z0-9_:. -]{0,95}$/u
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u
const SLOT = /^[a-z][a-z0-9_]{0,31}$/u
const TEXT_FIELDS = new Set(['text', 'prompt', 'positive', 'negative', 'negative_prompt'])
const INTEGER_FIELDS = new Set(['seed', 'noise_seed', 'width', 'height', 'frames', 'frame_count', 'length', 'fps', 'steps'])
// The v1 runner uploads images only; video-as-input needs a separate reviewed ABI.
const ARTIFACT_FIELDS = new Set(['image'])
const MP4_OUTPUT_CLASSES = new Set(['VHS_VideoCombine', 'SaveVideo'])
const MAX_GRAPH_NODES = 128
const MAX_GRAPH_BYTES = 256 * 1024

/** Only the named node input can be replaced when a task is later admitted. */
export type ComfyVideoInputSlot =
  | Readonly<{ name: string; kind: 'text'; nodeId: string; field: string; maxUtf8Bytes: number }>
  | Readonly<{ name: string; kind: 'integer'; nodeId: string; field: string; min: number; max: number }>
  | Readonly<{
    name: string
    kind: 'artifact_ref'
    nodeId: string
    field: 'image'
    mimeType: 'image/png' | 'image/jpeg'
    maxBytes: number
  }>

/** Public identity contains no graph bytes, local address, model name or owner file path. */
export interface ComfyVideoPublicContract {
  readonly schema: 'qianshou.comfy-video-public-contract.v1'
  readonly taskType: string
  readonly capabilityId: 'video.render'
  readonly graph: Readonly<{ format: 'comfyui-api'; sha256: string; nodeCount: number }>
  readonly inputSlots: readonly ComfyVideoInputSlot[]
  /** Exactly one declared output; the runner must still verify actual MP4 bytes. */
  readonly outputs: readonly [Readonly<{ nodeId: string; classType: string; kind: 'artifact_ref'; mimeType: 'video/mp4' }>]
  readonly runner: Readonly<{ abi: typeof COMFY_VIDEO_RUNNER_ABI; sourceSha256: string }>
  readonly dependencyManifestSha256: string
  readonly limits: Readonly<{
    maxDurationSeconds: number
    maxFrames: number
    maxWidth: number
    maxHeight: number
    maxVramMiB: number
    maxInputBytes: number
    maxOutputBytes: number
    timeoutSeconds: number
  }>
}

function invalid(): never { throw new ComputeError('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID', 400) }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}
function bounded(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid()
  return value as number
}
function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid()
  return value
}

/**
 * Parse an exact public declaration without granting installation, review or execution.
 * This checks fields and bounds; it does not approve custom nodes or their behavior.
 * @param value - Untrusted author or platform JSON, with no private graph or device fields.
 * @returns An immutable normalized v1 declaration.
 */
export function parseComfyVideoPublicContract(value: unknown): ComfyVideoPublicContract {
  const item = record(value)
  exact(item, ['schema', 'taskType', 'capabilityId', 'graph', 'inputSlots', 'outputs',
    'runner', 'dependencyManifestSha256', 'limits'])
  if (item.schema !== 'qianshou.comfy-video-public-contract.v1'
    || item.capabilityId !== 'video.render') invalid()
  const taskType = string(item.taskType, TASK)
  const graph = record(item.graph)
  exact(graph, ['format', 'sha256', 'nodeCount'])
  if (graph.format !== 'comfyui-api') invalid()
  const graphSha256 = string(graph.sha256, HASH)
  const nodeCount = bounded(graph.nodeCount, 1, MAX_GRAPH_NODES)

  if (!Array.isArray(item.inputSlots) || item.inputSlots.length < 1 || item.inputSlots.length > 16) invalid()
  const names = new Set<string>()
  const targets = new Set<string>()
  const inputSlots = item.inputSlots.map((raw: unknown): ComfyVideoInputSlot => {
    const slot = record(raw)
    const kind = slot.kind
    if (kind !== 'text' && kind !== 'integer' && kind !== 'artifact_ref') invalid()
    exact(slot, kind === 'text' ? ['name', 'kind', 'nodeId', 'field', 'maxUtf8Bytes']
      : kind === 'integer' ? ['name', 'kind', 'nodeId', 'field', 'min', 'max']
        : ['name', 'kind', 'nodeId', 'field', 'mimeType', 'maxBytes'])
    const name = string(slot.name, SLOT)
    const nodeId = string(slot.nodeId, NODE_ID)
    const field = string(slot.field, FIELD)
    if (names.has(name) || targets.has(`${nodeId}\u0000${field}`)) invalid()
    names.add(name)
    targets.add(`${nodeId}\u0000${field}`)
    if (kind === 'text') {
      if (!TEXT_FIELDS.has(field)) invalid()
      return Object.freeze({ name, kind, nodeId, field,
        maxUtf8Bytes: bounded(slot.maxUtf8Bytes, 1, 8192) })
    }
    if (kind === 'artifact_ref') {
      if (!ARTIFACT_FIELDS.has(field)
        || slot.mimeType !== 'image/png' && slot.mimeType !== 'image/jpeg') invalid()
      return Object.freeze({ name, kind, nodeId, field: 'image',
        mimeType: slot.mimeType,
        maxBytes: bounded(slot.maxBytes, 1, 256 * 1024 * 1024) })
    }
    if (!INTEGER_FIELDS.has(field)) invalid()
    const min = bounded(slot.min, 0, 2_147_483_647)
    const max = bounded(slot.max, 0, 2_147_483_647)
    if (min > max || ((field === 'width' || field === 'height') && (min < 64 || max > 4096))
      || ((field === 'frames' || field === 'frame_count' || field === 'length') && (min < 1 || max > 7200))
      || (field === 'fps' && (min < 1 || max > 120))
      || (field === 'steps' && (min < 1 || max > 200))) invalid()
    return Object.freeze({ name, kind, nodeId, field, min, max })
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

  if (!Array.isArray(item.outputs) || item.outputs.length !== 1) invalid()
  const output = record(item.outputs[0])
  exact(output, ['nodeId', 'classType', 'kind', 'mimeType'])
  if (output.kind !== 'artifact_ref' || output.mimeType !== 'video/mp4') invalid()
  const outputClassType = string(output.classType, CLASS)
  if (!MP4_OUTPUT_CLASSES.has(outputClassType)) invalid()
  const outputs = Object.freeze([Object.freeze({ nodeId: string(output.nodeId, NODE_ID),
    classType: outputClassType, kind: 'artifact_ref' as const,
    mimeType: 'video/mp4' as const })] as const)

  const runner = record(item.runner)
  exact(runner, ['abi', 'sourceSha256'])
  if (runner.abi !== COMFY_VIDEO_RUNNER_ABI) invalid()
  const sourceSha256 = string(runner.sourceSha256, HASH)
  const dependencyManifestSha256 = string(item.dependencyManifestSha256, HASH)
  const limits = record(item.limits)
  exact(limits, ['maxDurationSeconds', 'maxFrames', 'maxWidth', 'maxHeight', 'maxVramMiB',
    'maxInputBytes', 'maxOutputBytes', 'timeoutSeconds'])
  const normalizedLimits = Object.freeze({
    maxDurationSeconds: bounded(limits.maxDurationSeconds, 1, 120),
    maxFrames: bounded(limits.maxFrames, 1, 7200),
    maxWidth: bounded(limits.maxWidth, 64, 3840),
    maxHeight: bounded(limits.maxHeight, 64, 2160),
    maxVramMiB: bounded(limits.maxVramMiB, 1024, 65536),
    maxInputBytes: bounded(limits.maxInputBytes, 0, 256 * 1024 * 1024),
    maxOutputBytes: bounded(limits.maxOutputBytes, 1, 2_147_483_648),
    timeoutSeconds: bounded(limits.timeoutSeconds, 30, 3600),
  })
  if (normalizedLimits.maxFrames > normalizedLimits.maxDurationSeconds * 120) invalid()
  if (inputSlots.reduce((sum, slot) => sum + (slot.kind === 'text' ? slot.maxUtf8Bytes
    : slot.kind === 'artifact_ref' ? slot.maxBytes : 0), 0) > normalizedLimits.maxInputBytes
    || inputSlots.some(slot => slot.kind === 'integer' && (
      (slot.field === 'width' && slot.max > normalizedLimits.maxWidth)
      || (slot.field === 'height' && slot.max > normalizedLimits.maxHeight)
      || ((slot.field === 'frames' || slot.field === 'frame_count' || slot.field === 'length')
        && slot.max > normalizedLimits.maxFrames)))) invalid()
  return Object.freeze({ schema: 'qianshou.comfy-video-public-contract.v1', taskType,
    capabilityId: 'video.render', graph: Object.freeze({ format: 'comfyui-api', sha256: graphSha256,
      nodeCount }), inputSlots: Object.freeze(inputSlots), outputs,
    runner: Object.freeze({ abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256 }), dependencyManifestSha256,
    limits: normalizedLimits })
}

function canonicalJson(value: unknown, depth: number, ancestors: Set<object>): string {
  if (depth > 24) invalid()
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) invalid()
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    // An unpaired surrogate is not a portable UTF-8 value across the Windows and server runtimes.
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid()
    return JSON.stringify(value)
  }
  if (typeof value !== 'object' || ancestors.has(value)) invalid()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > 4096 || Object.keys(value).length !== value.length) invalid()
      return `[${value.map(entry => canonicalJson(entry, depth + 1, ancestors)).join(',')}]`
    }
    const item = record(value)
    if (Object.keys(item).some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) invalid()
    return `{${Object.keys(item).sort().map(key => `${canonicalJson(key, depth + 1, ancestors)}:${canonicalJson(item[key], depth + 1, ancestors)}`).join(',')}}`
  } finally { ancestors.delete(value) }
}

/**
 * Normalize a private API graph to the exact sorted-key JSON bytes that must be packaged locally.
 * This function never places graph bytes in the public declaration. A server compares the SHA of
 * these bytes rather than parsing and independently serializing floating-point values.
 * @param value - Untrusted ComfyUI API graph, not a ComfyUI editor workflow export.
 * @returns Canonical UTF-8 JSON for the owner-private package.
 */
export function canonicalComfyVideoApiGraphJson(value: unknown): string {
  const graph = record(value)
  const ids = Object.keys(graph)
  if (ids.length < 1 || ids.length > MAX_GRAPH_NODES || ids.some(id => !NODE_ID.test(id))) invalid()
  for (const id of ids) {
    const node = record(graph[id])
    if (!Object.keys(node).every(key => ['class_type', 'inputs', '_meta'].includes(key))
      || typeof node.class_type !== 'string' || !CLASS.test(node.class_type)) invalid()
    const inputs = record(node.inputs)
    if (Object.keys(inputs).length > 32 || Object.keys(inputs).some(key => !FIELD.test(key))) invalid()
    if (node._meta !== undefined) record(node._meta)
  }
  const json = canonicalJson(graph, 0, new Set())
  if (Buffer.byteLength(json, 'utf8') > MAX_GRAPH_BYTES) invalid()
  return json
}

/**
 * Hash exactly the canonical bytes intended for the private package; no graph bytes are returned.
 * This v1 digest does not replace the older insertion-order Comfy draft digest.
 * @param value - Untrusted owner-private ComfyUI API graph.
 * @returns The SHA-256 and bounded node count used in a public declaration.
 */
export function summarizeComfyVideoApiGraph(value: unknown): Readonly<{ sha256: string; nodeCount: number }> {
  const json = canonicalComfyVideoApiGraphJson(value)
  return Object.freeze({ sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
    nodeCount: Object.keys(record(value)).length })
}

/**
 * Reconcile a public declaration against owner-private graph bytes without exporting those bytes.
 * This is structural validation only; dependencies, MP4 bytes, nodes and executable behavior require separate trials.
 * @param value - Untrusted public declaration.
 * @param graphValue - The exact private graph held by the owner host.
 * @returns The parsed declaration only when its graph and input/output references still match.
 */
export function verifyComfyVideoPublicGraph(value: unknown, graphValue: unknown): ComfyVideoPublicContract {
  const contract = parseComfyVideoPublicContract(value)
  const summary = summarizeComfyVideoApiGraph(graphValue)
  if (summary.sha256 !== contract.graph.sha256 || summary.nodeCount !== contract.graph.nodeCount) invalid()
  const graph = record(graphValue)
  for (const slot of contract.inputSlots) {
    const node = record(graph[slot.nodeId])
    const input = record(node.inputs)[slot.field]
    if (slot.kind === 'integer' ? !Number.isSafeInteger(input) : typeof input !== 'string') invalid()
  }
  // Every image loaded by this v1 graph must come from a declared buyer artifact.
  // Otherwise a graph could silently depend on an owner-local file left in LoadImage.
  const imageSlots = contract.inputSlots.filter(slot => slot.kind === 'artifact_ref')
  const imageNodes = Object.entries(graph).filter(([, raw]) => record(raw).class_type === 'LoadImage')
  if (imageNodes.length !== imageSlots.length || imageNodes.some(([id]) =>
    !imageSlots.some(slot => slot.nodeId === id))
    || Object.values(graph).some(raw => /^(?:VHS_)?Load(?:Video|Audio|ImageMask)/u
      .test(String(record(raw).class_type)))) invalid()
  const output = contract.outputs[0]
  const node = record(graph[output.nodeId])
  if (node.class_type !== output.classType || !MP4_OUTPUT_CLASSES.has(output.classType)) invalid()
  const outputNodes = Object.values(graph).filter(raw => MP4_OUTPUT_CLASSES.has(record(raw).class_type as string))
  if (outputNodes.length !== 1 || outputNodes[0] !== graph[output.nodeId]) invalid()
  const outputInputs = record(node.inputs)
  if (output.classType === 'VHS_VideoCombine' && outputInputs.format !== 'video/h264-mp4') invalid()
  if (output.classType === 'SaveVideo' && outputInputs.format !== 'mp4'
    && outputInputs.format !== 'video/mp4') invalid()
  return contract
}

/**
 * Hash the normalized public declaration, excluding its own digest to prevent circular identity.
 * @param value - Untrusted exact v1 declaration.
 * @returns Versioned SHA-256 of sorted-key UTF-8 JSON.
 */
export function comfyVideoPublicContractDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(parseComfyVideoPublicContract(value), 0, new Set()), 'utf8').digest('hex')}`
}
