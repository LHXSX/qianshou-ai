/** Independent V2 local preparation. No V1 receipt or platform evidence is promoted. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, parseNativeH3ExecutionBindingV2,
  nativeH3PublicBindingDigest } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import type { ArtifactOrderAdapter } from './artifact-order.ts'
import { createCommandArtifactAdapter, executeNativeProgram, type NativeProgramRunner } from './command-artifact.ts'
import { H3_FIXED_NEGATIVE, prepareH3OrderInput, readH3BoundedFile, verifyH3Video,
  type H3OwnerConfig, type H3VideoReadiness, type NativeH3LocalIdentityV2 } from './h3-video.ts'

/** Explicit private V2 configuration, with the same thirteen owner-only local fields. */
export interface H3OwnerConfigV2 extends Omit<H3OwnerConfig, 'schema'> { readonly schema: 'qianshou.h3-owner.v2' }
/** Actual fixed adapter identities; routing configuration is private and separately measured. */
export interface H3ExecutionIdentityV2 {
  readonly executionRecipeSha256: string
  readonly modelSha256: string
  readonly firstFrameSha256: string
  readonly localConfigSha256: string
}
/** Bounded loopback identity reader; injectable only by the owning Host composition. */
export type H3ExecutionIdentityReaderV2 = (config: H3OwnerConfigV2, signal: AbortSignal) => Promise<H3ExecutionIdentityV2>
const LIMIT = 16 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/u
const CONFIG_KEYS = ['adapterBase', 'outputRoot', 'entryPath', 'ffmpegPath', 'ffprobePath', 'firstFramePath',
  'modelPath', 'pythonPath', 'runtimePath', 'schema', 'selfTestReceiptPath', 'workflow', 'workflowPath']
function fail(code: string): never { throw new ComputeError(code, 409) }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('H3_OWNER_CONFIG_INVALID')
  return value as Record<string, unknown>
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function origin(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('H3_NODE_ADAPTER_MUST_BE_LOOPBACK')
  return url
}
async function json(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) fail('H3_EXECUTION_IDENTITY_UNAVAILABLE')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const value = await reader.read()
      if (value.done) break
      total += value.value.byteLength
      if (total > 64 * 1024) fail('H3_ADAPTER_RESPONSE_TOO_LARGE')
      chunks.push(value.value)
    }
    return row(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))))
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

/** Read only an explicit V2 owner configuration; neither V1 nor unknown fields are accepted.
 * @param path - Absolute owner-only configuration file.
 * @returns Exact local configuration, without starting any job.
 */
export async function readH3OwnerConfigV2(path: string): Promise<H3OwnerConfigV2> {
  const value = row(JSON.parse((await readH3BoundedFile(path, 16 * 1024)).toString('utf8')))
  if (Object.keys(value).sort().join(',') !== CONFIG_KEYS.slice().sort().join(',')
    || value.schema !== 'qianshou.h3-owner.v2') fail('H3_V2_OWNER_CONFIG_REQUIRED')
  for (const key of CONFIG_KEYS.filter(key => key.endsWith('Path') || key === 'outputRoot')) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || value[key].includes('\0')) fail('H3_OWNER_CONFIG_INVALID')
  }
  if (value.workflow !== 'qs_new4' || typeof value.adapterBase !== 'string') fail('H3_ATTESTED_WORKFLOW_UNSUPPORTED')
  origin(value.adapterBase)
  return value as unknown as H3OwnerConfigV2
}

/** Preserve the private path/file identity algorithm, using the independent pinned V2 source.
 * @param config - Validated V2 owner-only configuration.
 * @returns Raw SHA256 of private paths, stable first frame/workflow bytes and model file facts.
 */
export async function h3OwnerIdentityV2(config: H3OwnerConfigV2): Promise<string> {
  const first = await readH3BoundedFile(config.firstFramePath, LIMIT)
  if (!first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('H3_OWNER_FIRST_FRAME_INVALID')
  if (hash(await readH3BoundedFile(config.entryPath, 256 * 1024)) !== NATIVE_H3_RUNTIME_V2.entrySha256
    || hash(await readH3BoundedFile(config.runtimePath, 256 * 1024)) !== NATIVE_H3_RUNTIME_V2.runtimeSha256) {
    fail('H3_RUNTIME_SOURCE_CHANGED')
  }
  const workflow = await readH3BoundedFile(config.workflowPath, 2 * 1024 * 1024)
  row(JSON.parse(workflow.toString('utf8')))
  const model = await lstat(config.modelPath)
  if (!model.isFile() || model.isSymbolicLink() || model.size < 1) fail('H3_OWNER_MODEL_NOT_INSTALLED')
  const output = await lstat(config.outputRoot)
  const normalized = (path: string) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
  if (!output.isDirectory() || output.isSymbolicLink()
    || normalized(await realpath(config.outputRoot)) !== normalized(config.outputRoot)) fail('H3_OWNER_OUTPUT_ROOT_INVALID')
  for (const path of [config.pythonPath, config.ffmpegPath, config.ffprobePath]) {
    if (!(await lstat(path)).isFile()) fail('H3_LOCAL_EXECUTABLE_UNAVAILABLE')
    await access(path, constants.X_OK)
  }
  return hash(Buffer.from(canonicalNativeH3ReviewJson({ ...config, firstSha256: hash(first),
    workflowSha256: hash(workflow), modelSize: model.size, modelMtimeMs: Math.floor(model.mtimeMs) })))
}

/** Read actual V2 recipe/model/first-frame/private-routing measurements from the fixed loopback adapter.
 * @param config - Explicit private V2 paths and loopback origin.
 * @param signal - Caller cancellation.
 * @param fetchImpl - Host-owned HTTP transport; redirects and cookies are refused.
 * @returns Four exact measured identities, without any remote path or model bytes.
 */
export async function readH3ExecutionIdentityV2(config: H3OwnerConfigV2, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<H3ExecutionIdentityV2> {
  const first = await readH3BoundedFile(config.firstFramePath, LIMIT)
  if (!first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('H3_OWNER_FIRST_FRAME_INVALID')
  const firstFrameSha256 = hash(first)
  const negativeSha256 = hash(Buffer.from(H3_FIXED_NEGATIVE))
  const url = new URL('/v2/recipes/qs_new4/identity', origin(config.adapterBase))
  url.searchParams.set('firstFrameSha256', firstFrameSha256)
  url.searchParams.set('negativeSha256', negativeSha256)
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  const value = await json(await fetchImpl(url, { signal: bounded, redirect: 'error', credentials: 'omit',
    cache: 'no-store', headers: { Accept: 'application/json' } }), bounded)
  const keys = ['schemaVersion', 'workflow', 'recipeVersion', 'graphTemplateSha256', 'builderSourceSha256',
    'firstFrameSha256', 'negativeSha256', 'executionRecipeSha256', 'modelSha256', 'modelSetSha256',
    'weightSha256ByRole', 'localConfigSha256']
  const hashes = keys.filter(key => key.endsWith('Sha256'))
  const weights = value.weightSha256ByRole
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schemaVersion !== 'qs.h3.recipe-identity.v2' || value.workflow !== 'qs_new4'
    || typeof value.recipeVersion !== 'string' || !value.recipeVersion.isWellFormed()
    || value.recipeVersion.length < 1 || value.recipeVersion.length > 128
    || hashes.some(key => typeof value[key] !== 'string' || !HASH.test(value[key]))
    || value.firstFrameSha256 !== firstFrameSha256 || value.negativeSha256 !== negativeSha256
    || value.modelSetSha256 !== value.modelSha256 || weights === null || typeof weights !== 'object' || Array.isArray(weights)
    || Object.keys(weights).sort().join(',') !== 'audioVae,clip,lora,unet,videoVae'
    || Object.values(weights).some(value => typeof value !== 'string' || !HASH.test(value))) fail('H3_RECIPE_IDENTITY_INVALID')
  if (!first.equals(await readH3BoundedFile(config.firstFramePath, LIMIT))) fail('H3_LOCAL_FILE_CHANGED')
  return { executionRecipeSha256: String(value.executionRecipeSha256), modelSha256: String(value.modelSha256),
    firstFrameSha256, localConfigSha256: String(value.localConfigSha256) }
}

/** Prepare only an already executed V2 local trial; metadata reads never start the GPU.
 * @param configPath - Explicit private V2 owner configuration, or empty when unavailable.
 * @param fetchImpl - Bounded loopback HTTP transport.
 * @param program - Trusted subprocess runner for probes and explicitly dispatched jobs.
 * @param readIdentity - Actual V2 recipe identity reader.
 * @returns Separate V2 provider with strict V2 self-test, measured private identity and fixed runtime.
 */
export function createH3VideoProviderV2(configPath: string, fetchImpl: typeof fetch = fetch,
  program: NativeProgramRunner = executeNativeProgram,
  readIdentity: H3ExecutionIdentityReaderV2 = (config, signal) => readH3ExecutionIdentityV2(config, signal, fetchImpl)) {
  let status: H3VideoReadiness = { configured: configPath !== '', ready: false,
    code: configPath ? 'H3_NOT_CHECKED' : 'H3_OWNER_CONFIG_NOT_CONFIGURED' }
  const prepare = async (signal: AbortSignal) => {
    const config = await readH3OwnerConfigV2(configPath)
    const ownerIdentity = await h3OwnerIdentityV2(config)
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const health = await json(await fetchImpl(new URL('/health', origin(config.adapterBase)),
      { signal: bounded, redirect: 'error', credentials: 'omit', cache: 'no-store' }), bounded)
    if (health.ok !== true || !Array.isArray(health.workflows) || !health.workflows.some(value => value === config.workflow)) {
      fail('H3_OWNER_WORKFLOW_UNAVAILABLE')
    }
    const actual = await readIdentity(config, signal)
    if (Object.keys(actual).sort().join(',') !== 'executionRecipeSha256,firstFrameSha256,localConfigSha256,modelSha256'
      || Object.values(actual).some((value: unknown) => typeof value !== 'string' || !HASH.test(value))) fail('H3_RECIPE_IDENTITY_INVALID')
    const binding = parseNativeH3ExecutionBindingV2({ schema: 'qianshou.native-h3-execution-binding.v2',
      runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
      executionRecipeSha256: actual.executionRecipeSha256, modelSha256: actual.modelSha256,
      firstFrameSha256: actual.firstFrameSha256 })
    const localOwnerConfigDigest = `sha256:${hash(Buffer.from(canonicalNativeH3ReviewJson({ ownerIdentity, ...actual })))}`
    const receipt = row(JSON.parse((await readH3BoundedFile(config.selfTestReceiptPath, 16 * 1024)).toString('utf8')))
    if (Object.keys(receipt).sort().join(',') !== 'bytes,generationExecuted,localOwnerConfigDigest,nativeBinding,ownerIdentity,schema,sha256,videoPath'
      || receipt.schema !== 'qianshou.h3-self-test.v2' || receipt.generationExecuted !== true
      || receipt.ownerIdentity !== ownerIdentity || receipt.localOwnerConfigDigest !== localOwnerConfigDigest
      || typeof receipt.videoPath !== 'string' || !isAbsolute(receipt.videoPath)
      || canonicalNativeH3ReviewJson(parseNativeH3ExecutionBindingV2(receipt.nativeBinding)) !== canonicalNativeH3ReviewJson(binding)) {
      fail('H3_V2_REAL_SELF_TEST_REQUIRED')
    }
    const video = await verifyH3Video(receipt.videoPath, config.ffprobePath, signal, program)
    if (receipt.sha256 !== video.sha256 || receipt.bytes !== video.bytes) fail('H3_SELF_TEST_OUTPUT_CHANGED')
    if (await h3OwnerIdentityV2(config) !== ownerIdentity) fail('H3_OWNER_CONFIGURATION_CHANGED')
    const after = await readIdentity(config, signal)
    if (canonicalNativeH3ReviewJson(after) !== canonicalNativeH3ReviewJson(actual)) fail('H3_EXECUTION_IDENTITY_CHANGED')
    return { config, actual, binding, localOwnerConfigDigest }
  }
  const nativeAuthorBindingV2 = async (): Promise<NativeH3LocalIdentityV2> => {
    try {
      const prepared = await prepare(new AbortController().signal)
      status = { configured: true, ready: true, code: 'H3_V2_REAL_SELF_TEST_VERIFIED' }
      return Object.freeze({ binding: prepared.binding, localOwnerConfigDigest: prepared.localOwnerConfigDigest })
    } catch (error) {
      status = { configured: configPath !== '', ready: false,
        code: error instanceof ComputeError ? error.code : 'H3_PREPARATION_FAILED' }
      throw error
    }
  }
  const loadAndSelfTestV2 = async (): Promise<ArtifactOrderAdapter | null> => {
    if (!configPath) return null
    try {
      const initial = await prepare(new AbortController().signal)
      // This internal runner has no independently publishable V2 credential; only the native factory may mint a V2 alias.
      const adapter = createCommandArtifactAdapter({ taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
        contractVersion: 'v1', artifactDigest: `sha256:${hash(Buffer.from(NATIVE_H3_RUNTIME_V2.entrySha256 + '\0' + NATIVE_H3_RUNTIME_V2.runtimeSha256))}`,
        packageDigest: nativeH3PublicBindingDigest(initial.binding), outputFormats: ['mp4'], maxInputBytes: 32 * 1024,
        prepareRequest: prepareH3OrderInput,
        async command({ recipeJson, workspacePath, signal }) {
          const current = await prepare(signal)
          if (current.localOwnerConfigDigest !== initial.localOwnerConfigDigest) fail('H3_OWNER_CONFIGURATION_CHANGED')
          const { config, actual } = current
          return { program: config.pythonPath, args: [config.entryPath], timeoutMs: 1_500_000,
            env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
              EC_PARAMS: recipeJson, EC_OUTPUT_DIR: await realpath(workspacePath), H3_RUNTIME_SCRIPT: config.runtimePath,
              H3_ADAPTER_BASE: config.adapterBase.replace(/\/$/u, ''), H3_ADAPTER_OUTPUT_ROOT: config.outputRoot,
              H3_EXPECTED_EXECUTION_RECIPE_SHA256: actual.executionRecipeSha256, H3_EXPECTED_MODEL_SHA256: actual.modelSha256,
              H3_EXPECTED_FIRST_FRAME_SHA256: actual.firstFrameSha256, H3_EXPECTED_LOCAL_CONFIG_SHA256: actual.localConfigSha256,
              H3_FIRST_FRAME_PATH: config.firstFramePath, H3_WORKFLOW: config.workflow, H3_FFMPEG: config.ffmpegPath },
            normalizeResult(value: unknown) {
              const result = row(value)
              if (result.schema_version !== 'v2' || result.status !== 'ok' || result.delivery_state !== 'pending_node_upload'
                || typeof result.video_path !== 'string'
                || canonicalNativeH3ReviewJson(row(result.execution_identity)) !== canonicalNativeH3ReviewJson(actual)) {
                fail('H3_EXECUTION_IDENTITY_CHANGED')
              }
              const local = row(result.local_output)
              if (typeof local.sha256 !== 'string' || !HASH.test(local.sha256) || !Number.isSafeInteger(local.size_bytes)) {
                fail('H3_LOCAL_OUTPUT_INVALID')
              }
              return { path: result.video_path, filename: 'result.mp4', contentType: 'video/mp4' as const,
                bytes: Number(local.size_bytes), sha256: local.sha256 }
            },
            async verifyOutput(output, outputSignal) {
              const verified = await verifyH3Video(output.path, config.ffprobePath, outputSignal, program)
              if (verified.sha256 !== output.sha256 || verified.bytes !== output.bytes) fail('H3_LOCAL_OUTPUT_CHANGED')
              if ((await prepare(outputSignal)).localOwnerConfigDigest !== initial.localOwnerConfigDigest) fail('H3_OWNER_CONFIGURATION_CHANGED')
            } }
        } }, program)
      status = { configured: true, ready: true, code: 'H3_V2_REAL_SELF_TEST_VERIFIED' }
      return adapter
    } catch (error) {
      status = { configured: true, ready: false, code: error instanceof ComputeError ? error.code : 'H3_PREPARATION_FAILED' }
      return null
    }
  }
  return { nativeAuthorBindingV2, loadAndSelfTestV2, status: (): H3VideoReadiness => ({ ...status }) }
}
