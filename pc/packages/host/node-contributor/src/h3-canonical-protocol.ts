/** Pure canonical H3 wire parsing; no registration, readiness, network or GPU is performed. */
import { createHash } from 'node:crypto'

const ABI = 'qs.h3.canonical.qs_new4.vnext' as const
const SCHEMA = 'qs.h3.recipe-identity.canonical-vnext' as const
const JOB_SCHEMA = 'qs.h3.job-identity.canonical-vnext'
const HASH = /^[a-f0-9]{64}$/u
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const MEDIA_LIMIT = 16 * 1024 * 1024
const JSON_LIMIT = 64 * 1024
const ROLES = ['audioVae', 'clip', 'lora', 'unet', 'videoVae'] as const

/** A malformed wire packet; the message never includes server paths or response text. */
export class H3CanonicalProtocolError extends Error {
  /** Finite diagnostic; no server response text or private path is included. */
  readonly code = 'H3_CANONICAL_PROTOCOL_INVALID'
  constructor() {
    super('H3_CANONICAL_PROTOCOL_INVALID')
    this.name = 'H3CanonicalProtocolError'
  }
}

/** Actual canonical public measurement, not an installed-device credential. */
export interface H3CanonicalIdentity {
  readonly schemaVersion: typeof SCHEMA
  readonly workflow: 'qs_new4'
  readonly recipeVersion: '1.0.0-rc.1'
  readonly graphTemplateSha256: string
  readonly executionRecipeSha256: string
  readonly modelSha256: string
  readonly modelSetSha256: string
  readonly sourceManifestSha256: string
  readonly classOriginSha256: string
  readonly graphSha256: string
  readonly runtimeAbi: typeof ABI
  readonly weightSha256ByRole: Readonly<Record<typeof ROLES[number], string>>
}

/** The canonical job API accepts only these two expected public digests. */
export interface H3CanonicalPostExpected {
  readonly executionRecipeSha256: string
  readonly modelSha256: string
}

/** Host-owned job expectations; fixed software pins and authorization are checked by its consumer. */
export interface H3CanonicalJobExpectation {
  readonly jobId: string
  readonly adapterBase: string
  readonly identity: H3CanonicalIdentity
  readonly comfyFfmpegSha256: string
  readonly deliveryFfmpegSha256: string
}

/** Tiny completed-media metadata; it does not grant publication, supply or billing authority. */
export interface H3CanonicalCompletedJob {
  readonly state: 'completed'
  readonly jobId: string
  readonly sha256: string
  readonly bytes: number
  readonly modelLoadGenerationSha256: string
}

/** Finite local API states; raw error text, feedback paths and URLs are never projected. */
export type H3CanonicalJob = H3CanonicalCompletedJob | {
  readonly state: 'queued' | 'running' | 'failed' | 'cancelled'
  readonly jobId: string
}

/** Only these canonical local routes can be constructed. */
export type H3CanonicalEndpoint = { readonly kind: 'identity' | 'owner-identity' | 'jobs' }
  | { readonly kind: 'poll' | 'video'; readonly jobId: string }

function invalid(): never { throw new H3CanonicalProtocolError() }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function bounded(value: unknown): Record<string, unknown> {
  const result = record(value)
  let text: string
  try {
    text = JSON.stringify(result)
  } catch (_error) {
    // Encoding failures must not expose private response fields.
    invalid()
  }
  if (Buffer.byteLength(text) > JSON_LIMIT) invalid()
  return result
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid()
  return value
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function jobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID.test(value)) invalid()
  return value
}
function origin(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (_error) {
    // Invalid origin text is omitted from the public error.
    invalid()
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid()
  return url
}

/** Construct a fixed direct-loopback route, refusing credentials, alternate paths and job traversal.
 * @param base - Host-owned adapter origin, without query, fragment or credentials.
 * @param request - Fixed route kind and, for a job route, its received ASCII identifier.
 * @returns URL for a local identity, submission, polling or verified-media endpoint.
 */
export function canonicalH3Endpoint(base: string, request: H3CanonicalEndpoint): URL {
  const url = origin(base)
  switch (request.kind) {
    case 'identity': url.pathname = '/v1/recipes/qs_new4/identity'; break
    case 'owner-identity': url.pathname = '/v1/owner-runtime/identity'; break
    case 'jobs': url.pathname = '/v1/jobs'; break
    case 'poll': url.pathname = `/v1/jobs/${jobId(request.jobId)}`; break
    case 'video': url.pathname = `/v1/jobs/${jobId(request.jobId)}/video`; break
    default: invalid()
  }
  return url
}

/** Parse the actual twelve-field canonical recipe, including its production public-recipe digest.
 * @param value - Bounded JSON returned by the independent canonical identity endpoint.
 * @returns Immutable public measurements; software enrollment and real self-test remain separate.
 */
export function parseH3CanonicalIdentity(value: unknown): H3CanonicalIdentity {
  const row = bounded(value)
  exact(row, ['schemaVersion', 'workflow', 'recipeVersion', 'graphTemplateSha256', 'executionRecipeSha256',
    'modelSha256', 'modelSetSha256', 'sourceManifestSha256', 'classOriginSha256', 'graphSha256',
    'runtimeAbi', 'weightSha256ByRole'])
  if (row.schemaVersion !== SCHEMA || row.workflow !== 'qs_new4'
    || row.recipeVersion !== '1.0.0-rc.1' || row.runtimeAbi !== ABI) invalid()
  const graphSha256 = hash(row.graphSha256)
  const modelSha256 = hash(row.modelSha256)
  const sourceManifestSha256 = hash(row.sourceManifestSha256)
  const classOriginSha256 = hash(row.classOriginSha256)
  if (hash(row.graphTemplateSha256) !== graphSha256 || hash(row.modelSetSha256) !== modelSha256) invalid()
  const weights = record(row.weightSha256ByRole); exact(weights, ROLES)
  const weightSha256ByRole = Object.freeze({ audioVae: hash(weights.audioVae), clip: hash(weights.clip),
    lora: hash(weights.lora), unet: hash(weights.unet), videoVae: hash(weights.videoVae) })
  const recipe = { schemaVersion: SCHEMA, workflow: 'qs_new4', seconds: 5, graphSha256,
    modelSha256, sourceManifestSha256, classOriginSha256, runtimeAbi: ABI }
  const executionRecipeSha256 = digest(Buffer.from(JSON.stringify(recipe, Object.keys(recipe).sort())))
  if (hash(row.executionRecipeSha256) !== executionRecipeSha256) invalid()
  return Object.freeze({ schemaVersion: SCHEMA, workflow: 'qs_new4', recipeVersion: '1.0.0-rc.1',
    graphTemplateSha256: graphSha256, executionRecipeSha256, modelSha256, modelSetSha256: modelSha256,
    sourceManifestSha256, classOriginSha256, graphSha256, runtimeAbi: ABI, weightSha256ByRole })
}

/** Parse the exact canonical POST expectation; V2's extra private/input identity fields are rejected.
 * @param value - Two-digest expected object from a canonical submission or echoed job receipt.
 * @returns Only the public recipe and model digests; no caller-specified safety policy.
 */
export function parseH3CanonicalPostExpected(value: unknown): H3CanonicalPostExpected {
  const row = record(value); exact(row, ['executionRecipeSha256', 'modelSha256'])
  return Object.freeze({ executionRecipeSha256: hash(row.executionRecipeSha256), modelSha256: hash(row.modelSha256) })
}

const OUTER_KEYS = new Set(['job_id', 'id', 'phase', 'status', 'pct', 'percent', 'done', 'failed', 'cancelled',
  'error', 'video_url', 'file_url', 'elapsed_sec', 'progress', 'fed', 'recipe_identity',
  'comfy_model_load_generation_sha256', 'refs_taken', 'refs_order', 'node_took_ref_images',
  'feedback', 'recent_events', 'workflow', 'mode', 'preset', 'save_frames', 'frames'])
function videoUrl(value: unknown, expected: H3CanonicalJobExpectation, completed: boolean): void {
  if (!completed) { if (value !== null) invalid(); return }
  const url = canonicalH3Endpoint(expected.adapterBase, { kind: 'video', jobId: expected.jobId })
  if (value !== url.href && value !== url.pathname) invalid()
}

/** Parse submission/polling state against the same job, software measurement and actual encoders.
 * @param value - Bounded canonical job JSON; auxiliary feedback is never returned to the caller.
 * @param expected - Host-bound origin, job identifier, measured identity and two encoder byte hashes.
 * @returns Finite status, or hash-bound completed metadata after every final receipt check succeeds.
 */
export function parseH3CanonicalJob(value: unknown, expected: H3CanonicalJobExpectation): H3CanonicalJob {
  const row = bounded(value); const id = jobId(expected.jobId)
  origin(expected.adapterBase)
  if (Object.keys(row).some(key => !OUTER_KEYS.has(key)) || row.job_id !== id || row.id !== id) invalid()
  const status = row.status
  if (status !== 'queued' && status !== 'running' && status !== 'done'
    && status !== 'failed' && status !== 'cancelled') invalid()
  const completed = status === 'done'
  if (row.done !== completed || row.failed !== (status === 'failed') || row.cancelled !== (status === 'cancelled')) invalid()
  videoUrl(row.video_url, expected, completed); videoUrl(row.file_url, expected, completed)
  const receipt = record(row.recipe_identity); exact(receipt, ['schemaVersion', 'expected', 'actual', 'attested'])
  if (receipt.schemaVersion !== JOB_SCHEMA || receipt.attested !== completed) invalid()
  const echoed = parseH3CanonicalPostExpected(receipt.expected)
  if (echoed.executionRecipeSha256 !== expected.identity.executionRecipeSha256
    || echoed.modelSha256 !== expected.identity.modelSha256) invalid()
  if (!completed) {
    if (receipt.actual !== null || row.comfy_model_load_generation_sha256 !== undefined) invalid()
    return Object.freeze({ state: status, jobId: id })
  }
  const actual = record(receipt.actual)
  exact(actual, ['executionRecipeSha256', 'modelSha256', 'modelSetSha256', 'sourceManifestSha256',
    'classOriginSha256', 'deliverySha256', 'deliverySize', 'comfyFfmpegSha256', 'deliveryFfmpegSha256'])
  for (const key of ['executionRecipeSha256', 'modelSha256', 'modelSetSha256', 'sourceManifestSha256', 'classOriginSha256'] as const) {
    if (hash(actual[key]) !== expected.identity[key]) invalid()
  }
  if (hash(actual.comfyFfmpegSha256) !== expected.comfyFfmpegSha256
    || hash(actual.deliveryFfmpegSha256) !== expected.deliveryFfmpegSha256) invalid()
  if (!Number.isSafeInteger(actual.deliverySize) || Number(actual.deliverySize) < 1
    || Number(actual.deliverySize) > MEDIA_LIMIT) invalid()
  return Object.freeze({ state: 'completed', jobId: id, sha256: hash(actual.deliverySha256),
    bytes: Number(actual.deliverySize), modelLoadGenerationSha256: hash(row.comfy_model_load_generation_sha256) })
}

/** Copy and check bounded local MP4 bytes against the parsed final receipt; this grants no execution authority.
 * @param bytes - Media obtained from the fixed local verified-video endpoint.
 * @param completed - The same job's parsed, identity-bound terminal media metadata.
 * @returns A private byte copy after size, MP4 header and exact SHA256 agree.
 */
export function verifyH3CanonicalMedia(bytes: Uint8Array, completed: H3CanonicalCompletedJob): Buffer {
  if (bytes.byteLength < 8 || bytes.byteLength > MEDIA_LIMIT || bytes.byteLength !== completed.bytes) invalid()
  const copy = Buffer.from(bytes)
  if (copy.subarray(4, 8).toString('ascii') !== 'ftyp' || digest(copy) !== completed.sha256) invalid()
  return copy
}
