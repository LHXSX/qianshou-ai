/** Owner-configured H3 execution. Preparation never starts a GPU job. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { ComputeCapabilityId, ComputeError, type ComputeExecutor } from '@deepseek-ai/dsh-compute-core'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI, parseNativeH3ContractBinding,
  type NativeH3ExecutionBindingV2,
  type NativeH3AuthorBinding } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import type { ArtifactOrderAdapter } from './artifact-order.ts'
import { createCommandArtifactAdapter, executeNativeProgram, type NativeProgramRunner } from './command-artifact.ts'

/** SHA256 of the fixed, audited H3 node entry source. */
export const H3_NODE_ENTRY_SHA256 = NATIVE_H3_RUNTIME.entrySha256
/** SHA256 of the fixed, audited H3 runtime source. */
export const H3_RUNTIME_SHA256 = NATIVE_H3_RUNTIME.runtimeSha256
const LIMIT = 16 * 1024 * 1024
/** The pinned runtime's fixed negative prompt, hashed as raw UTF-8 bytes. */
export const H3_FIXED_NEGATIVE = 'second person, crowd, extra figure, distant front-facing face, face drift, '
  + 'warm light, amber light, orange light, magenta light, purple light, sunset, '
  + 'warm color grade, on-screen text, subtitles, watermark, logo, image tearing, '
  + 'extra limbs, deformed hands, background music'

/** Author paths and workflow belong only to this PC, never to buyer parameters. */
export interface H3OwnerConfig {
  readonly schema: 'qianshou.h3-owner.v1'
  readonly pythonPath: string
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly entryPath: string
  readonly runtimePath: string
  readonly firstFramePath: string
  readonly workflowPath: string
  readonly modelPath: string
  readonly workflow: string
  readonly adapterBase: string
  readonly outputRoot: string
  readonly selfTestReceiptPath: string
}

/** Local proof state; service health alone does not establish generated output. */
export interface H3VideoReadiness {
  readonly configured: boolean
  readonly ready: boolean
  readonly code: string
}

/** Read the real loopback adapter's active graph and model bytes identity. */
export type H3ExecutionIdentityReader = (config: H3OwnerConfig, signal: AbortSignal) => Promise<{
  readonly executionRecipeSha256: string
  readonly modelSha256: string
  readonly firstFrameSha256?: string
}>

function fail(code: string): never { throw new ComputeError(code, 409) }
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('H3_OWNER_CONFIG_INVALID')
  return value as Record<string, unknown>
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
}

/** Read at most max+1 bytes from the same regular-file descriptor and reject any mutation.
 * @param path - Owner-controlled absolute local path.
 * @param max - Maximum admitted byte count.
 * @returns Stable file bytes; links, growth and path replacement are refused.
 */
export async function readH3BoundedFile(path: string, max: number): Promise<Buffer> {
  if (!isAbsolute(path) || !Number.isSafeInteger(max) || max < 1 || max > LIMIT) fail('H3_LOCAL_FILE_INVALID')
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > max) fail('H3_LOCAL_FILE_INVALID')
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev
      || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) {
      fail('H3_LOCAL_FILE_CHANGED')
    }
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1 - total))
      const read = await handle.read(chunk, 0, chunk.length, null)
      if (read.bytesRead === 0) break
      total += read.bytesRead
      if (total > max) fail('H3_LOCAL_FILE_INVALID')
      chunks.push(chunk.subarray(0, read.bytesRead))
    }
    const after = await handle.stat()
    const current = await lstat(path)
    if (total !== stat.size || !current.isFile() || current.isSymbolicLink()
      || [after, current].some(value => value.ino !== stat.ino || value.dev !== stat.dev
        || value.mtimeMs !== stat.mtimeMs || value.ctimeMs !== stat.ctimeMs || value.size !== stat.size)) {
      fail('H3_LOCAL_FILE_CHANGED')
    }
    return Buffer.concat(chunks, total)
  } finally { await handle.close() }
}

const regular = readH3BoundedFile

async function readAdapterJson(response: Response, signal: AbortSignal, code: string): Promise<Record<string, unknown>> {
  if (!response.body) fail(code)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 64 * 1024) fail('H3_ADAPTER_RESPONSE_TOO_LARGE')
      chunks.push(chunk.value)
    }
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
      return value as Record<string, unknown>
    } catch { fail(code) }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Read the fixed loopback recipe endpoint using hashes of this PC's actual PNG and fixed negative bytes.
 * @param config - Owner-only adapter origin and installed first frame.
 * @param signal - Caller cancellation; hashing and network reads are bounded.
 * @param fetchImpl - Host HTTP implementation; neither redirects nor cookies are admitted.
 * @returns Actual execution recipe and five-weight-set identities, without any model path or bytes.
 */
export async function readH3ExecutionIdentity(
  config: H3OwnerConfig, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<{ readonly executionRecipeSha256: string; readonly modelSha256: string; readonly firstFrameSha256: string }> {
  signal.throwIfAborted()
  if (config.workflow !== 'qs_new4') fail('H3_ATTESTED_WORKFLOW_UNSUPPORTED')
  const base = new URL(config.adapterBase)
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    fail('H3_NODE_ADAPTER_MUST_BE_LOOPBACK')
  }
  const first = await regular(config.firstFramePath, LIMIT)
  if (!first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('H3_OWNER_FIRST_FRAME_INVALID')
  const firstFrameSha256 = hash(first)
  const negativeSha256 = hash(Buffer.from(H3_FIXED_NEGATIVE, 'utf8'))
  const endpoint = new URL('/v1/recipes/qs_new4/identity', base)
  endpoint.searchParams.set('firstFrameSha256', firstFrameSha256)
  endpoint.searchParams.set('negativeSha256', negativeSha256)
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  const response = await fetchImpl(endpoint, { signal: boundedSignal, redirect: 'error', credentials: 'omit',
    cache: 'no-store', headers: { Accept: 'application/json' } })
  if (!response.ok) fail('H3_EXECUTION_IDENTITY_UNAVAILABLE')
  const value = await readAdapterJson(response, boundedSignal, 'H3_RECIPE_IDENTITY_INVALID')
  const keys = ['schemaVersion', 'workflow', 'recipeVersion', 'graphTemplateSha256', 'builderSourceSha256',
    'firstFrameSha256', 'negativeSha256', 'executionRecipeSha256', 'modelSha256', 'modelSetSha256', 'weightSha256ByRole']
  const hashes = ['graphTemplateSha256', 'builderSourceSha256', 'firstFrameSha256', 'negativeSha256',
    'executionRecipeSha256', 'modelSha256', 'modelSetSha256']
  const weights = value.weightSha256ByRole
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schemaVersion !== 'qs.h3.recipe-identity.v1' || value.workflow !== config.workflow
    || typeof value.recipeVersion !== 'string' || !value.recipeVersion.isWellFormed()
    || value.recipeVersion.length < 1 || value.recipeVersion.length > 128
    || hashes.some(key => typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(value[key]))
    || value.firstFrameSha256 !== firstFrameSha256 || value.negativeSha256 !== negativeSha256
    || value.modelSetSha256 !== value.modelSha256 || !weights || typeof weights !== 'object' || Array.isArray(weights)
    || Object.keys(weights).sort().join(',') !== 'audioVae,clip,lora,unet,videoVae'
    || Object.values(weights).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) {
    fail('H3_RECIPE_IDENTITY_INVALID')
  }
  if (!first.equals(await regular(config.firstFramePath, LIMIT))) fail('H3_LOCAL_FILE_CHANGED')
  return { executionRecipeSha256: String(value.executionRecipeSha256), modelSha256: String(value.modelSha256), firstFrameSha256 }
}

/** Read an explicit owner config; no default model, path, or workflow is inferred.
 * @param path - Absolute path of the private owner configuration.
 * @returns Validated local paths, fixed workflow and loopback adapter origin.
 */
export async function readH3OwnerConfig(path: string): Promise<H3OwnerConfig> {
  if (!isAbsolute(path)) fail('H3_OWNER_CONFIG_INVALID')
  const value = row(JSON.parse((await regular(path, 16 * 1024)).toString('utf8')))
  const keys = ['adapterBase', 'outputRoot', 'entryPath', 'ffmpegPath', 'ffprobePath', 'firstFramePath',
    'modelPath', 'pythonPath', 'runtimePath', 'schema', 'selfTestReceiptPath', 'workflow', 'workflowPath']
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schema !== 'qianshou.h3-owner.v1') fail('H3_OWNER_CONFIG_INVALID')
  for (const key of keys.filter(key => key.endsWith('Path') || key === 'outputRoot')) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || value[key].includes('\0')) {
      fail('H3_OWNER_CONFIG_INVALID')
    }
  }
  if (typeof value.workflow !== 'string' || !/^qs_[A-Za-z0-9_-]{1,96}$/u.test(value.workflow)) {
    fail('H3_OWNER_WORKFLOW_INVALID')
  }
  const endpoint = new URL(String(value.adapterBase))
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    fail('H3_NODE_ADAPTER_MUST_BE_LOOPBACK')
  }
  return value as unknown as H3OwnerConfig
}

/** Hash the actual configured input and binding facts without loading model weights into memory.
 * @param config - Validated private owner configuration.
 * @returns SHA256 of stable owner paths, pinned sources, input bytes and model file facts.
 */
export async function h3OwnerIdentity(config: H3OwnerConfig): Promise<string> {
  const first = await regular(config.firstFramePath, LIMIT)
  if (!first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('H3_OWNER_FIRST_FRAME_INVALID')
  const entry = await regular(config.entryPath, 256 * 1024)
  const runtime = await regular(config.runtimePath, 256 * 1024)
  if (hash(entry) !== H3_NODE_ENTRY_SHA256 || hash(runtime) !== H3_RUNTIME_SHA256) fail('H3_RUNTIME_SOURCE_CHANGED')
  const workflow = await regular(config.workflowPath, 2 * 1024 * 1024)
  row(JSON.parse(workflow.toString('utf8')))
  const model = await lstat(config.modelPath)
  if (!model.isFile() || model.isSymbolicLink() || model.size < 1) fail('H3_OWNER_MODEL_NOT_INSTALLED')
  const outputRoot = await lstat(config.outputRoot)
  if (!outputRoot.isDirectory() || outputRoot.isSymbolicLink()) fail('H3_OWNER_OUTPUT_ROOT_INVALID')
  const resolvedOutputRoot = await realpath(config.outputRoot)
  const pathIdentity = (value: string): string => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value)
  if (pathIdentity(resolvedOutputRoot) !== pathIdentity(config.outputRoot)) fail('H3_OWNER_OUTPUT_ROOT_INVALID')
  for (const program of [config.pythonPath, config.ffmpegPath, config.ffprobePath]) {
    const stat = await lstat(program)
    if (!stat.isFile()) fail('H3_LOCAL_EXECUTABLE_UNAVAILABLE')
    await access(program, constants.X_OK)
  }
  return hash(Buffer.from(canonical({ ...config, firstSha256: hash(first), workflowSha256: hash(workflow),
    modelSize: model.size, modelMtimeMs: Math.floor(model.mtimeMs) })))
}

/** Host-only v2 preparation. The public binding contains no paths; the local digest retains v1 private identity semantics. */
export interface NativeH3LocalIdentityV2 {
  readonly binding: NativeH3ExecutionBindingV2
  readonly localOwnerConfigDigest: string
}

/** Read actual video bytes and probe its duration/stream; a job's done flag is insufficient.
 * @param path - Absolute path of the generated regular MP4 file.
 * @param ffprobePath - Owner-configured local ffprobe executable.
 * @param signal - Cancellation for file and bounded probe work.
 * @param program - Controlled native subprocess runner.
 * @returns Byte count and SHA256 after video probing and unchanged-byte revalidation.
 */
export async function verifyH3Video(
  path: string, ffprobePath: string, signal: AbortSignal, program: NativeProgramRunner = executeNativeProgram,
): Promise<{ bytes: number; sha256: string }> {
  signal.throwIfAborted()
  const bytes = await regular(path, LIMIT)
  if (bytes.subarray(4, 8).toString('ascii') !== 'ftyp') fail('H3_LOCAL_OUTPUT_INVALID')
  const { stdout } = await program(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    { signal, timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true })
  const probe = row(JSON.parse(stdout))
  const duration = Number(row(probe.format).duration)
  const streams = probe.streams
  if (!Number.isFinite(duration) || duration < 4.8 || duration > 5.3 || !Array.isArray(streams)
    || !streams.some(item => row(item).codec_type === 'video' && Number(row(item).width) > 0
      && Number(row(item).height) > 0 && ['h264', 'hevc', 'av1'].includes(String(row(item).codec_name)))) {
    fail('H3_LOCAL_OUTPUT_INVALID')
  }
  if (!bytes.equals(await regular(path, LIMIT))) fail('H3_LOCAL_FILE_CHANGED')
  return { bytes: bytes.length, sha256: hash(bytes) }
}

/** Buyer text and the two public parameters only; no paths, endpoint, workflow or dry run.
 * @param inline - Well-formed buyer video description.
 * @param params - Fixed five seconds and optional bounded integer seed.
 * @returns Validated recipe JSON and the fixed MP4 output format.
 */
export function prepareH3OrderInput(
  inline: string, params: Readonly<Record<string, unknown>>,
): { recipeJson: string; outputFormat: 'mp4' } {
  if (typeof inline !== 'string' || !inline.trim() || Array.from(inline.trim()).length > 7000
    || !inline.isWellFormed() || Object.keys(params).some(key => !['seconds', 'seed'].includes(key))
    || (params.seconds !== undefined && params.seconds !== 5)
    || (params.seed !== undefined && (!Number.isSafeInteger(params.seed) || Number(params.seed) < 1
      || Number(params.seed) > 2147483647))) fail('H3_PUBLIC_INPUT_INVALID')
  return { recipeJson: JSON.stringify({ prompt: inline.trim(), seconds: 5,
    ...(params.seed === undefined ? {} : { seed: params.seed }) }), outputFormat: 'mp4' }
}

/** Owns a fixed configuration generation; readiness revalidates health and the owner's prior real trial.
 * @param configPath - Explicit private owner configuration path, or empty when unconfigured.
 * @param fetchImpl - Loopback health and identity HTTP transport.
 * @param program - Controlled native subprocess runner for probes and real jobs.
 * @param readExecutionIdentity - Reader of the actual active graph and model byte identities.
 * @returns Provider that verifies an existing real trial, exposes native identity and reports readiness.
 */
export function createH3VideoProvider(
  configPath: string, fetchImpl: typeof fetch = fetch, program: NativeProgramRunner = executeNativeProgram,
  readExecutionIdentity: H3ExecutionIdentityReader = (config, signal) => readH3ExecutionIdentity(config, signal, fetchImpl),
): {
  readonly loadAndSelfTest: () => Promise<ArtifactOrderAdapter | null>
  readonly nativeAuthorBinding: () => Promise<NativeH3AuthorBinding>
  readonly nativeAuthorBindingV2: () => Promise<NativeH3LocalIdentityV2>
  readonly status: () => H3VideoReadiness
} {
  let status: H3VideoReadiness = { configured: configPath !== '', ready: false,
    code: configPath === '' ? 'H3_OWNER_CONFIG_NOT_CONFIGURED' : 'H3_NOT_CHECKED' }
  let selectedIdentity: string | undefined
  const prepare = async (signal: AbortSignal): Promise<{ config: H3OwnerConfig; identity: string }> => {
    const config = await readH3OwnerConfig(configPath)
    const identity = await h3OwnerIdentity(config)
    if (selectedIdentity !== undefined && selectedIdentity !== identity) fail('H3_OWNER_CONFIGURATION_CHANGED')
    const response = await fetchImpl(new URL('/health', config.adapterBase), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error', credentials: 'omit',
    })
    if (!response.ok) fail('H3_ADAPTER_UNAVAILABLE')
    const health = await readAdapterJson(response, signal, 'H3_ADAPTER_HEALTH_INVALID')
    if (health.ok !== true || !Array.isArray(health.workflows) || !health.workflows.includes(config.workflow)) {
      fail('H3_OWNER_WORKFLOW_UNAVAILABLE')
    }
    let receipt: Record<string, unknown>
    try { receipt = row(JSON.parse((await regular(config.selfTestReceiptPath, 16 * 1024)).toString('utf8'))) }
    catch { fail('H3_REAL_SELF_TEST_REQUIRED') }
    if (receipt.schema !== 'qianshou.h3-self-test.v1' || receipt.generationExecuted !== true
      || receipt.ownerIdentity !== identity || typeof receipt.videoPath !== 'string'
      || !isAbsolute(receipt.videoPath)) fail('H3_REAL_SELF_TEST_REQUIRED')
    const output = await verifyH3Video(receipt.videoPath, config.ffprobePath, signal, program)
    if (receipt.sha256 !== output.sha256 || receipt.bytes !== output.bytes) fail('H3_SELF_TEST_OUTPUT_CHANGED')
    selectedIdentity = identity
    return { config, identity }
  }
  const loadAndSelfTest = async (): Promise<ArtifactOrderAdapter | null> => {
    if (configPath === '') return null
    try {
      const { identity } = await prepare(new AbortController().signal)
      await nativeAuthorBinding()
      status = { configured: true, ready: true, code: 'H3_REAL_SELF_TEST_VERIFIED' }
      const digest = `sha256:${hash(Buffer.from(H3_NODE_ENTRY_SHA256 + '\0' + H3_RUNTIME_SHA256))}`
      return createCommandArtifactAdapter({
        taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref', contractVersion: 'v1',
        artifactDigest: digest, packageDigest: `sha256:${identity}`, outputFormats: ['mp4'],
        maxInputBytes: 32 * 1024, prepareRequest: prepareH3OrderInput,
        async command({ recipeJson, workspacePath, signal }) {
          const { config } = await prepare(signal)
          const native = await nativeAuthorBinding()
          const root = await realpath(workspacePath)
          return { program: config.pythonPath, args: [config.entryPath], timeoutMs: 1_500_000,
            env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP,
              TMP: process.env.TMP, EC_PARAMS: recipeJson, EC_OUTPUT_DIR: root,
              H3_RUNTIME_SCRIPT: config.runtimePath, H3_ADAPTER_BASE: config.adapterBase.replace(/\/$/u, ''),
              H3_ADAPTER_OUTPUT_ROOT: config.outputRoot,
              H3_EXPECTED_EXECUTION_RECIPE_SHA256: native.executionRecipeSha256,
              H3_EXPECTED_MODEL_SHA256: native.modelSha256,
              H3_FIRST_FRAME_PATH: config.firstFramePath, H3_WORKFLOW: config.workflow,
              H3_FFMPEG: config.ffmpegPath },
            normalizeResult(value: unknown) {
              const result = row(value)
              if (result.status !== 'ok' || result.delivery_state !== 'pending_node_upload'
                || typeof result.video_path !== 'string') fail('H3_GENERATION_FAILED')
              const local = row(result.local_output)
              const actual = row(result.execution_identity)
              if (Object.keys(actual).sort().join(',') !== 'executionRecipeSha256,modelSha256'
                || actual.executionRecipeSha256 !== native.executionRecipeSha256
                || actual.modelSha256 !== native.modelSha256) fail('H3_EXECUTION_IDENTITY_CHANGED')
              if (typeof local.sha256 !== 'string' || typeof local.size_bytes !== 'number') fail('H3_LOCAL_OUTPUT_INVALID')
              return { path: result.video_path, filename: 'result.mp4', contentType: 'video/mp4',
                bytes: local.size_bytes, sha256: local.sha256 }
            },
            async verifyOutput(output, outputSignal) {
              const verified = await verifyH3Video(output.path, config.ffprobePath, outputSignal, program)
              if (verified.sha256 !== output.sha256 || verified.bytes !== output.bytes) fail('H3_LOCAL_OUTPUT_CHANGED')
              const after = await nativeAuthorBinding()
              if (after.ownerConfigDigest !== native.ownerConfigDigest) fail('H3_EXECUTION_IDENTITY_CHANGED')
            },
          }
        },
      }, program)
    } catch (error) {
      status = { configured: true, ready: false,
        code: error instanceof ComputeError ? error.code : 'H3_PREPARATION_FAILED' }
      return null
    }
  }
  const nativeAuthorBinding = async (): Promise<NativeH3AuthorBinding> => {
    const signal = new AbortController().signal
    const { config, identity } = await prepare(signal)
    const observed = await readExecutionIdentity(config, signal)
    const actual = { executionRecipeSha256: observed.executionRecipeSha256, modelSha256: observed.modelSha256 }
    const binding = parseNativeH3ContractBinding({ runtimeAbi: NATIVE_H3_RUNTIME_ABI,
      runtime: NATIVE_H3_RUNTIME, ...actual,
      ownerConfigDigest: `sha256:${hash(Buffer.from(canonical({ ownerIdentity: identity, ...actual })))}` })
    // The prior generation must have used these exact active graph/model identities.
    // An old successful video or the old model stat based identity is insufficient.
    const receipt = row(JSON.parse((await regular(config.selfTestReceiptPath, 16 * 1024)).toString('utf8')))
    let tested: NativeH3AuthorBinding
    try { tested = parseNativeH3ContractBinding(receipt.nativeBinding) }
    catch { fail('H3_NATIVE_SELF_TEST_REQUIRED') }
    if (JSON.stringify(tested) !== JSON.stringify(binding)) fail('H3_NATIVE_SELF_TEST_CHANGED')
    return binding
  }
  const nativeAuthorBindingV2 = (): Promise<NativeH3LocalIdentityV2> => Promise.reject(new ComputeError('H3_V2_OWNER_CONFIG_REQUIRED', 409))
  return { loadAndSelfTest, nativeAuthorBinding, nativeAuthorBindingV2, status: (): H3VideoReadiness => ({ ...status }) }
}

/** Register the same verified native adapter for direct local execution and node dispatch.
 * @param adapter - Fixed provider adapter already verified against the real owner trial.
 * @returns Video executor using the same controlled adapter and bounded local output checks.
 */
export function h3ComputeExecutor(adapter: ArtifactOrderAdapter): ComputeExecutor {
  return { capabilityId: ComputeCapabilityId('video.render'), version: '1.0.0',
    intentPhrases: ['H3 视频', '五秒视频', 'H3 video'],
    async execute(task, context) {
      const fields = row(task.parameters)
      const { prompt, ...params } = fields
      if (typeof prompt !== 'string') fail('H3_PUBLIC_INPUT_INVALID')
      const request = prepareH3OrderInput(prompt, params)
      const output = await adapter.run({ ...request, workspacePath: context.workspacePath, signal: context.signal })
      const bytes = await regular(output.path, LIMIT)
      return { outputs: [{ name: 'result.mp4', path: output.path, bytes: bytes.length, sha256: hash(bytes) }] }
    },
  }
}
