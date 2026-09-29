/** Read-only canonical loopback HTTP; no submission, readiness or device authority is provided. */
import { request, type IncomingMessage } from 'node:http'
import { canonicalH3Endpoint, parseH3CanonicalIdentity, parseH3CanonicalJob, verifyH3CanonicalMedia,
  type H3CanonicalCompletedJob, type H3CanonicalIdentity, type H3CanonicalJob,
  type H3CanonicalJobExpectation } from './h3-canonical-protocol.ts'
import { parseH3OwnerRuntimeIdentity, parseH3WitnessedJob,
  type H3OwnerRuntimeIdentity, type H3WitnessedJob, type H3WitnessedJobExpectation } from './h3-owner-witness.ts'

const JSON_LIMIT = 64 * 1024
const MEDIA_LIMIT = 16 * 1024 * 1024
const MAX_TIMEOUT_MS = 180_000

/** Finite HTTP diagnostics that omit response bodies, local paths and caller abort reasons. */
export type H3CanonicalTransportCode = 'H3_CANONICAL_REQUEST_INVALID' | 'H3_CANONICAL_READ_UNAVAILABLE'
  | 'H3_CANONICAL_RESPONSE_INVALID' | 'H3_CANONICAL_RESPONSE_TOO_LARGE'
  | 'H3_CANONICAL_READ_ABORTED' | 'H3_CANONICAL_READ_TIMEOUT'

/** A rejected local read; its message contains only the finite diagnostic code. */
export class H3CanonicalTransportError extends Error {
  constructor(readonly code: H3CanonicalTransportCode) {
    super(code)
    this.name = 'H3CanonicalTransportError'
  }
}

/** Explicit per-read deadline; security byte limits and route selection are not configurable. */
export interface H3CanonicalReadOptions {
  /** Whole HTTP operation deadline, including headers and streamed body, from 1 to 180000 ms. */
  readonly timeoutMs: number
  /** Optional caller cancellation; its private reason is not returned. */
  readonly signal?: AbortSignal
}

function fail(code: H3CanonicalTransportCode): never {
  throw new H3CanonicalTransportError(code)
}

async function getBytes(url: URL, media: boolean, options: H3CanonicalReadOptions): Promise<Buffer> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
    fail('H3_CANONICAL_REQUEST_INVALID')
  }
  if (options.signal?.aborted) fail('H3_CANONICAL_READ_ABORTED')
  const lifetime = new AbortController()
  const abort = (): void => { lifetime.abort(new H3CanonicalTransportError('H3_CANONICAL_READ_ABORTED')) }
  const timer = setTimeout(() => {
    lifetime.abort(new H3CanonicalTransportError('H3_CANONICAL_READ_TIMEOUT'))
  }, options.timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  let response: IncomingMessage | undefined
  try {
    // agent:false uses a direct one-operation Node connection, without a fetch dispatcher or proxy environment.
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const operation = request(url, { method: 'GET', agent: false, signal: lifetime.signal,
        headers: { Accept: media ? 'video/mp4' : 'application/json', 'Accept-Encoding': 'identity' } }, resolve)
      operation.once('error', reject)
      operation.end()
    })
    const limit = media ? MEDIA_LIMIT : JSON_LIMIT
    const expectedType = media ? 'video/mp4' : 'application/json'
    const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    const encoding = response.headers['content-encoding']
    if (response.statusCode !== 200 || contentType !== expectedType
      || (encoding !== undefined && encoding !== 'identity')) fail('H3_CANONICAL_RESPONSE_INVALID')
    const length = response.headers['content-length']
    if (length !== undefined) {
      if (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length))) fail('H3_CANONICAL_RESPONSE_INVALID')
      if (Number(length) > limit) fail('H3_CANONICAL_RESPONSE_TOO_LARGE')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const value of response) {
      const part: unknown = value
      lifetime.signal.throwIfAborted()
      if (!Buffer.isBuffer(part)) fail('H3_CANONICAL_RESPONSE_INVALID')
      size += part.byteLength
      if (size > limit) fail('H3_CANONICAL_RESPONSE_TOO_LARGE')
      chunks.push(Buffer.from(part))
    }
    lifetime.signal.throwIfAborted()
    if (!response.complete) fail('H3_CANONICAL_RESPONSE_INVALID')
    return Buffer.concat(chunks, size)
  } catch (error) {
    const reason: unknown = lifetime.signal.reason
    if (lifetime.signal.aborted && reason instanceof H3CanonicalTransportError) throw reason
    if (error instanceof H3CanonicalTransportError) throw error
    return fail('H3_CANONICAL_READ_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    response?.destroy()
  }
}

function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch (_error) {
    // Invalid UTF-8 or JSON is not returned as private server text.
    fail('H3_CANONICAL_RESPONSE_INVALID')
  }
}

/** Read the fixed public identity endpoint once; this does not approve software or run a self-test.
 * @param base - Direct loopback adapter origin without credentials, query or alternate path.
 * @param options - Whole-operation deadline and optional caller cancellation.
 * @returns The actual exact twelve-field canonical public measurement.
 */
export async function readH3CanonicalIdentity(base: string, options: H3CanonicalReadOptions): Promise<H3CanonicalIdentity> {
  const url = canonicalH3Endpoint(base, { kind: 'identity' })
  return parseH3CanonicalIdentity(json(await getBytes(url, false, options)))
}

/** Read current owner-process measurements from the fixed loopback route, without starting work.
 * @param base - Trusted direct-loopback canonical origin.
 * @param identity - Independently measured public recipe for matching source and class pins.
 * @param options - Whole-operation deadline and optional cancellation.
 * @returns Exact owner measurements after its self-digest and the public software pins agree.
 */
export async function readH3OwnerRuntimeIdentity(
  base: string, identity: H3CanonicalIdentity, options: H3CanonicalReadOptions,
): Promise<H3OwnerRuntimeIdentity> {
  const url = canonicalH3Endpoint(base, { kind: 'owner-identity' })
  return parseH3OwnerRuntimeIdentity(json(await getBytes(url, false, options)), identity)
}

/** Read a witnessed job once; no submission, retry or polling loop is performed.
 * @param expected - Same job, software, encoders and owner measurements captured before submission.
 * @param options - Whole-operation deadline and optional cancellation.
 * @returns Finite same-witness status; legacy or stale receipts are refused.
 */
export async function readH3WitnessedJob(
  expected: H3WitnessedJobExpectation, options: H3CanonicalReadOptions,
): Promise<H3WitnessedJob> {
  const url = canonicalH3Endpoint(expected.adapterBase, { kind: 'poll', jobId: expected.jobId })
  return parseH3WitnessedJob(json(await getBytes(url, false, options)), expected)
}

/** Download media only for the same witnessed job and origin, without following returned URLs.
 * @param expected - Captured submitting operation's job, source, encoders and process witness.
 * @param completed - That operation's parsed completed result, retaining its origin and witness.
 * @param options - Whole-operation deadline and optional cancellation.
 * @returns Independent MP4 byte copy after owner, job, origin, terminal size and hash agree.
 */
export async function readH3WitnessedMedia(
  expected: H3WitnessedJobExpectation, completed: H3WitnessedJob,
  options: H3CanonicalReadOptions,
): Promise<Buffer> {
  const owner = parseH3OwnerRuntimeIdentity(expected.owner, expected.identity)
  const origin = canonicalH3Endpoint(expected.adapterBase, { kind: 'jobs' }).origin
  if (completed.state !== 'completed' || completed.jobId !== expected.jobId
    || completed.ownerRuntimeWitnessSha256 !== owner.ownerRuntimeWitnessSha256
    || completed.executionRecipeSha256 !== expected.identity.executionRecipeSha256
    || completed.modelSha256 !== expected.identity.modelSha256
    || completed.adapterOrigin !== origin || owner.comfyFfmpegSha256 !== expected.comfyFfmpegSha256
    || owner.deliveryFfmpegSha256 !== expected.deliveryFfmpegSha256) fail('H3_CANONICAL_REQUEST_INVALID')
  return readH3CanonicalMedia(expected, completed, options)
}

/** Read one Host-bound job using only its fixed poll route, without polling loops or retry.
 * @param expected - The same received job identifier, origin, public identity and encoder hashes.
 * @param options - Whole-operation deadline and optional caller cancellation.
 * @returns Finite status after stage1 checks, without private feedback, errors or URLs.
 */
export async function readH3CanonicalJob(expected: H3CanonicalJobExpectation, options: H3CanonicalReadOptions): Promise<H3CanonicalJob> {
  const url = canonicalH3Endpoint(expected.adapterBase, { kind: 'poll', jobId: expected.jobId })
  return parseH3CanonicalJob(json(await getBytes(url, false, options)), expected)
}

/** Download only the same completed job's fixed video route; returned URLs are never followed.
 * @param expected - Host-bound job and origin used for the preceding exact job parse.
 * @param completed - That job's parsed terminal size, SHA and model-load generation.
 * @param options - Whole-operation deadline and optional caller cancellation.
 * @returns A private MP4 byte copy after bounded streaming, exact size, header and SHA agree.
 */
export async function readH3CanonicalMedia(
  expected: H3CanonicalJobExpectation, completed: H3CanonicalCompletedJob, options: H3CanonicalReadOptions,
): Promise<Buffer> {
  if (completed.jobId !== expected.jobId) fail('H3_CANONICAL_REQUEST_INVALID')
  const url = canonicalH3Endpoint(expected.adapterBase, { kind: 'video', jobId: expected.jobId })
  return verifyH3CanonicalMedia(await getBytes(url, true, options), completed)
}
