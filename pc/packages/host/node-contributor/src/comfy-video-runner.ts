/** One bounded, owner-private ComfyUI video execution; publication and order admission stay external. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { canonicalComfyVideoApiGraphJson, comfyVideoPublicContractDigest,
  verifyComfyVideoPublicGraph, type ComfyVideoPublicContract,
} from '@deepseek-ai/dsh-compute-core/comfy-video-public-contract'
import { executeNativeProgram, type NativeProgramRunner } from './command-artifact.ts'

const HASH = /^[a-f0-9]{64}$/u
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.mp4$/u
const MAX_JSON_BYTES = 512 * 1024
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

/** Bytes delivered to this owner for one input slot; no buyer-controlled filesystem path is accepted. */
export interface ComfyVideoPrivateArtifact {
  readonly mimeType: 'image/png' | 'image/jpeg'
  readonly bytes: Uint8Array
  readonly sha256: string
}

/** The Host must derive these fields from a reviewed installation and a durable one-shot reservation. */
export interface ComfyVideoRunAdmission {
  readonly publicContract: unknown
  /** Exact canonical bytes stored privately on this owner device, never sent to Shanghai. */
  readonly privateGraphJson: string
  readonly approvedContractDigest: string
  readonly approvedDependencyManifestSha256: string
  readonly approvedRunnerSourceSha256: string
  readonly allowedClassTypes: readonly string[]
  /** Durable local attempt ID, reserved before /prompt. ComfyUI assigns a different prompt ID. */
  readonly attemptId: string
  /** Fails unless this prompt is reserved under the current owner and task lease. */
  readonly assertReserved: (signal: AbortSignal) => Promise<void>
  /** Atomically spend the one-shot reservation before the only /prompt request. */
  readonly beforePromptSubmit: (signal: AbortSignal) => Promise<void>
  /** Durably bind the ComfyUI-returned prompt ID before polling or accepting output. */
  readonly recordPromptId: (promptId: string, signal: AbortSignal) => Promise<void>
  /** Rechecks installed software, owner policy and local resource admission against the reviewed package. */
  readonly assertCurrent: (signal: AbortSignal) => Promise<void>
}

/** One admitted local attempt, with Host-owned paths and task values. */
export interface ComfyVideoRunInput {
  readonly admission: ComfyVideoRunAdmission
  readonly values: Readonly<Record<string, string | number | ComfyVideoPrivateArtifact>>
  readonly port: number
  readonly workspacePath: string
  readonly ffprobePath: string
  readonly signal: AbortSignal
}

/** Test seams do not grant review or dispatch authority. */
export interface ComfyVideoRunDependencies {
  readonly fetcher?: typeof fetch
  readonly program?: NativeProgramRunner
  readonly pollIntervalMs?: number
}

/** Verified temporary output; the Host must still upload and reconcile it under a task lease. */
export interface ComfyVideoLocalResult {
  readonly path: string
  readonly filename: 'result.mp4'
  readonly contentType: 'video/mp4'
  readonly bytes: number
  readonly sha256: string
  readonly promptId: string
  readonly durationSeconds: number
  readonly width: number
  readonly height: number
  readonly frames: number
}

function fail(code: string, status = 422): never { throw new ComputeError(code, status) }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }
function endpoint(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
  return `http://127.0.0.1:${port}`
}
function imageBytes(value: ComfyVideoPrivateArtifact, maxBytes: number): Buffer {
  if (!(value.bytes instanceof Uint8Array) || value.bytes.length < 8
    || value.bytes.length > Math.min(MAX_UPLOAD_BYTES, maxBytes) || !HASH.test(value.sha256)) {
    fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
  }
  const bytes = Buffer.from(value.bytes)
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (hash(bytes) !== value.sha256 || value.mimeType === 'image/png' && !bytes.subarray(0, 8).equals(png)
    || value.mimeType === 'image/jpeg' && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)) {
    fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
  }
  return bytes
}
function prepare(admission: ComfyVideoRunAdmission, values: ComfyVideoRunInput['values']): {
  contract: ComfyVideoPublicContract
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  images: readonly { filename: string; mimeType: 'image/png' | 'image/jpeg'; bytes: Buffer; nodeId: string; field: string }[]
} {
  if (!PROMPT_ID.test(admission.attemptId) || typeof admission.privateGraphJson !== 'string'
    || typeof admission.assertReserved !== 'function' || typeof admission.assertCurrent !== 'function'
    || typeof admission.beforePromptSubmit !== 'function'
    || typeof admission.recordPromptId !== 'function'
    || !Array.isArray(admission.allowedClassTypes) || !object(values)) {
    fail('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID', 409)
  }
  let parsed: unknown
  try { parsed = JSON.parse(admission.privateGraphJson) as unknown }
  catch { fail('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID', 409) }
  if (canonicalComfyVideoApiGraphJson(parsed) !== admission.privateGraphJson) {
    fail('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID', 409)
  }
  const contract = verifyComfyVideoPublicGraph(admission.publicContract, parsed)
  if (comfyVideoPublicContractDigest(contract) !== admission.approvedContractDigest
    || contract.dependencyManifestSha256 !== admission.approvedDependencyManifestSha256
    || contract.runner.sourceSha256 !== admission.approvedRunnerSourceSha256) {
    fail('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID', 409)
  }
  const graph = parsed as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  const classes = new Set(admission.allowedClassTypes)
  if (classes.size !== admission.allowedClassTypes.length
    || Object.values(graph).some(node => !classes.has(node.class_type))
    || Object.keys(values).length !== contract.inputSlots.length
    || !contract.inputSlots.every(slot => Object.hasOwn(values, slot.name))) {
    fail('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID', 409)
  }
  const copy = structuredClone(graph)
  const images: { filename: string; mimeType: 'image/png' | 'image/jpeg'; bytes: Buffer; nodeId: string; field: string }[] = []
  for (const slot of contract.inputSlots) {
    const value = values[slot.name]
    const node = copy[slot.nodeId]
    if (!node) fail('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID', 409)
    if (slot.kind === 'text') {
      if (typeof value !== 'string' || !value.isWellFormed()
        || Buffer.byteLength(value, 'utf8') > slot.maxUtf8Bytes) fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
      node.inputs[slot.field] = value
    } else if (slot.kind === 'integer') {
      if (!Number.isSafeInteger(value) || (value as number) < slot.min || (value as number) > slot.max) {
        fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
      }
      node.inputs[slot.field] = value
    } else {
      const supplied = object(value)
      if (supplied?.mimeType !== slot.mimeType) {
        fail('COMPUTE_COMFY_VIDEO_INPUT_UNSUPPORTED')
      }
      const artifact = supplied as unknown as ComfyVideoPrivateArtifact
      const bytes = imageBytes(artifact, slot.maxBytes)
      const filename = `qs_${randomUUID().replaceAll('-', '')}.${slot.mimeType === 'image/png' ? 'png' : 'jpg'}`
      images.push({ filename, mimeType: slot.mimeType, bytes, nodeId: slot.nodeId, field: slot.field })
    }
  }
  const output = copy[contract.outputs[0].nodeId]
  if (!output) fail('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID', 409)
  const outputPrefix = `qs_${admission.attemptId.replaceAll('-', '')}`
  output.inputs.filename_prefix = outputPrefix
  // The owner-private graph can contain model names and local input filenames.
  // Never embed Comfy/VHS graph metadata in a video delivered to a buyer.
  if (output.class_type === 'VHS_VideoCombine') output.inputs.save_metadata = false
  // Auxiliary frame PNGs are permitted, but private graph prefixes must never
  // choose their output directories or collide with another attempt's files.
  for (const [nodeId, node] of Object.entries(copy)) {
    if (node.class_type === 'SaveImage') node.inputs.filename_prefix = `${outputPrefix}_frame_${nodeId}`
  }
  for (const node of Object.values(copy)) {
    for (const [field, raw] of Object.entries(node.inputs)) {
      if (!['width', 'height', 'frames', 'frame_count', 'length'].includes(field)) continue
      if (!Number.isSafeInteger(raw)
        || (field === 'width' && ((raw as number) < 64 || (raw as number) > contract.limits.maxWidth))
        || (field === 'height' && ((raw as number) < 64 || (raw as number) > contract.limits.maxHeight))
        || (['frames', 'frame_count', 'length'].includes(field)
          && ((raw as number) < 1 || (raw as number) > contract.limits.maxFrames))) {
        fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
      }
    }
  }
  return { contract, graph: copy, images }
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const length = response.headers.get('content-length')
  if (type !== 'application/json' || !response.body || response.headers.get('content-encoding')
    || length && (!/^\d+$/u.test(length) || Number(length) > MAX_JSON_BYTES)) {
    fail('COMPUTE_COMFY_VIDEO_RESPONSE_INVALID')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let complete = false
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) { complete = true; break }
      size += part.value.byteLength
      if (size > MAX_JSON_BYTES) fail('COMPUTE_COMFY_VIDEO_RESPONSE_INVALID')
      chunks.push(part.value)
    }
  } finally {
    if (!complete) { try { await reader.cancel() } catch (_error) { /* The bounded read already failed. */ } }
    reader.releaseLock()
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
    const item = object(value)
    if (!item) fail('COMPUTE_COMFY_VIDEO_RESPONSE_INVALID')
    return item
  } catch { fail('COMPUTE_COMFY_VIDEO_RESPONSE_INVALID') }
}

async function request(fetcher: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted()
  return fetcher(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    redirect: 'manual', cache: 'no-store' })
}

async function uploadImage(fetcher: typeof fetch, base: string,
  image: { filename: string; mimeType: 'image/png' | 'image/jpeg'; bytes: Buffer }, signal: AbortSignal): Promise<void> {
  const body = new FormData()
  body.set('image', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.filename)
  body.set('overwrite', 'false')
  let response: Response
  try { response = await request(fetcher, `${base}/upload/image`, { method: 'POST', body }, signal) }
  catch { fail('COMPUTE_COMFY_VIDEO_UPLOAD_UNKNOWN', 409) }
  if (response.status !== 200) fail('COMPUTE_COMFY_VIDEO_UPLOAD_UNKNOWN', 409)
  let result: Record<string, unknown>
  try { result = await boundedJson(response) }
  catch { fail('COMPUTE_COMFY_VIDEO_UPLOAD_UNKNOWN', 409) }
  if (result.name !== image.filename || result.subfolder !== '' || result.type !== 'input') {
    fail('COMPUTE_COMFY_VIDEO_UPLOAD_UNKNOWN', 409)
  }
}

type History = { status: 'pending' } | { status: 'failed' }
  | { status: 'completed'; filename: string; subfolder: string }

async function readHistory(fetcher: typeof fetch, base: string, promptId: string,
  outputNodeId: string, outputPrefix: string, signal: AbortSignal): Promise<History> {
  let response: Response
  try { response = await request(fetcher, `${base}/history/${promptId}`, { method: 'GET' }, signal) }
  catch { fail('COMPUTE_COMFY_VIDEO_HISTORY_UNKNOWN', 503) }
  if (response.status === 404) return { status: 'pending' }
  if (response.status !== 200) fail('COMPUTE_COMFY_VIDEO_HISTORY_UNKNOWN', 503)
  const payload = await boundedJson(response)
  const job = object(payload[promptId])
  if (!job) return { status: 'pending' }
  const status = object(job.status)?.status_str
  if (status === 'error') return { status: 'failed' }
  if (status !== 'success') return { status: 'pending' }
  const output = object(object(job.outputs)?.[outputNodeId])
  const candidates = output?.gifs ?? output?.videos
  if (!Array.isArray(candidates) || candidates.length !== 1) fail('COMPUTE_COMFY_VIDEO_RESPONSE_INVALID')
  const media = object(candidates[0])
  if (!media || typeof media.filename !== 'string' || !FILE.test(media.filename)
    || !media.filename.startsWith(`${outputPrefix}_`)
    || !/^[0-9]{5,8}\.mp4$/u.test(media.filename.slice(outputPrefix.length + 1))
    || media.subfolder !== ''
    || media.type !== 'output') fail('COMPUTE_COMFY_VIDEO_RESPONSE_INVALID')
  return { status: 'completed', filename: media.filename, subfolder: media.subfolder }
}

async function download(fetcher: typeof fetch, base: string, history: Extract<History, { status: 'completed' }>,
  workspacePath: string, maxBytes: number, signal: AbortSignal): Promise<{ path: string; bytes: number; sha256: string }> {
  const query = new URLSearchParams({ filename: history.filename, subfolder: history.subfolder, type: 'output' })
  let response: Response
  try { response = await request(fetcher, `${base}/view?${query}`, { method: 'GET' }, signal) }
  catch { fail('COMPUTE_COMFY_VIDEO_OUTPUT_UNKNOWN', 503) }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const length = response.headers.get('content-length')
  if (response.status !== 200 || !response.body || !['video/mp4', 'application/octet-stream'].includes(type ?? '')
    || response.headers.get('content-encoding')
    || length && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    fail('COMPUTE_COMFY_VIDEO_OUTPUT_INVALID')
  }
  const path = join(workspacePath, 'result.mp4')
  const handle = await open(path, 'wx', 0o600)
  const reader = response.body.getReader()
  const digest = createHash('sha256')
  let size = 0
  let header = Buffer.alloc(0)
  let complete = false
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) { complete = true; break }
      size += part.value.byteLength
      if (size > maxBytes) fail('COMPUTE_COMFY_VIDEO_OUTPUT_LIMIT', 413)
      if (header.length < 12) header = Buffer.concat([header, Buffer.from(part.value.subarray(0, 12 - header.length))])
      digest.update(part.value)
      await handle.writeFile(part.value)
    }
    if (size < 12 || header.toString('ascii', 4, 8) !== 'ftyp'
      || length !== null && size !== Number(length)) fail('COMPUTE_COMFY_VIDEO_OUTPUT_INVALID')
    await handle.sync()
    return { path, bytes: size, sha256: digest.digest('hex') }
  } finally {
    if (!complete) { try { await reader.cancel() } catch (_error) { /* The bounded download already failed. */ } }
    reader.releaseLock()
    await handle.close()
  }
}

function probeNumber(value: unknown): number {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || number <= 0) fail('COMPUTE_COMFY_VIDEO_OUTPUT_INVALID')
  return number
}

async function verifyVideo(path: string, ffprobePath: string, limits: ComfyVideoPublicContract['limits'],
  signal: AbortSignal, program: NativeProgramRunner): Promise<{ durationSeconds: number; width: number; height: number; frames: number }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)))
  let result: { stdout: string }
  try {
    result = await program(ffprobePath,
      ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path],
      { signal, timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true, env })
  } catch { fail('COMPUTE_COMFY_VIDEO_OUTPUT_INVALID') }
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout) as unknown }
  catch { fail('COMPUTE_COMFY_VIDEO_OUTPUT_INVALID') }
  const data = object(parsed)
  const durationSeconds = probeNumber(object(data?.format)?.duration)
  const streams = data?.streams
  if (!Array.isArray(streams) || streams.filter(item => object(item)?.codec_type === 'video').length !== 1) {
    fail('COMPUTE_COMFY_VIDEO_OUTPUT_INVALID')
  }
  const video = object(streams.find(item => object(item)?.codec_type === 'video'))
  const width = probeNumber(video?.width)
  const height = probeNumber(video?.height)
  const frames = probeNumber(video?.nb_read_frames)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(frames)
    || !['h264', 'hevc', 'av1'].includes(String(video?.codec_name))
    || width > limits.maxWidth || height > limits.maxHeight
    || frames > limits.maxFrames || durationSeconds > limits.maxDurationSeconds + 0.1) {
    fail('COMPUTE_COMFY_VIDEO_OUTPUT_INVALID')
  }
  return { durationSeconds, width, height, frames }
}

/**
 * Execute one already reviewed and durably reserved private ComfyUI graph on this Windows owner.
 * It never retries /prompt, approves a skill, advertises a worker or charges an order. A lost
 * submission remains unknown and must be reconciled by the caller using its original prompt ID.
 * @param input - Host-owned admission, one task's bounded values and trusted local runtime paths.
 * @param dependencies - Transport and probe seams used by deterministic fixtures.
 * @returns A verified private MP4 in the task workspace, before any upload or order completion.
 */
export async function runComfyVideoLocally(input: ComfyVideoRunInput,
  dependencies: ComfyVideoRunDependencies = {}): Promise<ComfyVideoLocalResult> {
  input.signal.throwIfAborted()
  const { contract, graph, images } = prepare(input.admission, input.values)
  const base = endpoint(input.port)
  const pollMs = dependencies.pollIntervalMs ?? 1_000
  if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 5_000
    || !isAbsolute(input.workspacePath) || !isAbsolute(input.ffprobePath)) {
    fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
  }
  const root = await realpath(input.workspacePath)
  const directory = await lstat(input.workspacePath)
  const probeStat = await lstat(input.ffprobePath)
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || !probeStat.isFile() || probeStat.isSymbolicLink()) fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
  await access(input.ffprobePath, constants.X_OK)
  const abort = new AbortController()
  const cancel = (): void => { abort.abort() }
  const timer = setTimeout(cancel, contract.limits.timeoutSeconds * 1000)
  input.signal.addEventListener('abort', cancel, { once: true })
  if (input.signal.aborted) cancel()
  const signal = abort.signal
  const fetcher = dependencies.fetcher ?? fetch
  const program = dependencies.program ?? executeNativeProgram
  const deadline = Date.now() + contract.limits.timeoutSeconds * 1000
  let submittedKnown = false
  try {
    signal.throwIfAborted()
    await input.admission.assertReserved(signal)
    await input.admission.assertCurrent(signal)
    for (const image of images) {
      await uploadImage(fetcher, base, image, signal)
      const node = graph[image.nodeId]
      if (!node) fail('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID', 409)
      node.inputs[image.field] = image.filename
    }
    await input.admission.assertReserved(signal)
    await input.admission.assertCurrent(signal)
    const body = JSON.stringify({ prompt: graph, client_id: input.admission.attemptId })
    if (Buffer.byteLength(body, 'utf8') > 512 * 1024) fail('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
    await input.admission.beforePromptSubmit(signal)
    let submitted: Response
    try { submitted = await request(fetcher, `${base}/prompt`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body }, signal) }
    catch { fail('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN', 409) }
    if (submitted.status === 400) fail('COMPUTE_COMFY_VIDEO_PROMPT_REJECTED')
    if (submitted.status !== 200) fail('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN', 409)
    let reply: Record<string, unknown>
    try { reply = await boundedJson(submitted) }
    catch { fail('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN', 409) }
    if (typeof reply.prompt_id !== 'string' || !PROMPT_ID.test(reply.prompt_id) || reply.error
      || object(reply.node_errors) && Object.keys(reply.node_errors as object).length > 0) {
      fail('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN', 409)
    }
    const promptId = reply.prompt_id
    try { await input.admission.recordPromptId(promptId, signal) }
    catch { fail('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN', 409) }
    submittedKnown = true
    let history: History = { status: 'pending' }
    while (history.status === 'pending') {
      signal.throwIfAborted()
      if (Date.now() >= deadline) fail('COMPUTE_COMFY_VIDEO_HISTORY_UNKNOWN', 503)
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal })
      history = await readHistory(fetcher, base, promptId, contract.outputs[0].nodeId,
        `qs_${input.admission.attemptId.replaceAll('-', '')}`, signal)
    }
    if (history.status === 'failed') fail('COMPUTE_COMFY_VIDEO_EXECUTION_FAILED')
    const output = await download(fetcher, base, history, root, contract.limits.maxOutputBytes, signal)
    const metadata = await verifyVideo(output.path, input.ffprobePath, contract.limits, signal, program)
    await input.admission.assertReserved(signal)
    await input.admission.assertCurrent(signal)
    const after = await lstat(input.workspacePath)
    const file = await lstat(output.path)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== directory.dev
      || after.ino !== directory.ino || await realpath(input.workspacePath) !== root
      || !file.isFile() || file.isSymbolicLink() || file.size !== output.bytes) {
      fail('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED', 409)
    }
    const handle = await open(output.path, 'r')
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== file.dev || opened.ino !== file.ino
        || opened.size !== file.size) fail('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED', 409)
      const digest = createHash('sha256')
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
        if (!Buffer.isBuffer(chunk)) fail('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED', 409)
        digest.update(chunk)
      }
      if (digest.digest('hex') !== output.sha256) fail('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED', 409)
    } finally { await handle.close() }
    const finalFile = await lstat(output.path)
    if (!finalFile.isFile() || finalFile.isSymbolicLink() || finalFile.dev !== file.dev
      || finalFile.ino !== file.ino || finalFile.size !== file.size
      || finalFile.mtimeMs !== file.mtimeMs || finalFile.ctimeMs !== file.ctimeMs
      || await realpath(input.workspacePath) !== root) fail('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED', 409)
    signal.throwIfAborted()
    return { path: output.path, filename: 'result.mp4', contentType: 'video/mp4',
      bytes: output.bytes, sha256: output.sha256, promptId, ...metadata }
  } catch (error) {
    if (submittedKnown && signal.aborted) fail('COMPUTE_COMFY_VIDEO_HISTORY_UNKNOWN', 503)
    throw error
  } finally { clearTimeout(timer); input.signal.removeEventListener('abort', cancel) }
}
