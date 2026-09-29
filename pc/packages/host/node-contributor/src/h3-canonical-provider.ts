/** Explicit canonical software preparation; a local trial never grants platform approval or supply. */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL, nativeH3PublicBindingDigest,
  parseNativeH3CanonicalExecutionBinding, type NativeH3CanonicalExecutionBinding } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { canonicalH3Endpoint, type H3CanonicalIdentity } from './h3-canonical-protocol.ts'
import { readH3CanonicalIdentity, readH3OwnerRuntimeIdentity, readH3WitnessedJob,
  readH3WitnessedMedia } from './h3-canonical-transport.ts'
import type { H3OwnerRuntimeIdentity, H3WitnessedJobExpectation } from './h3-owner-witness.ts'
import { readH3BoundedFile, type H3VideoReadiness } from './h3-video.ts'
import { runH3CanonicalExecution } from './h3-canonical-runner.ts'
import type { ArtifactOrderAdapter } from './artifact-order.ts'

/** Audited software inventory, separate from any author's configuration or platform approval. */
export const H3_CANONICAL_SOURCE_MANIFEST_SHA256 = 'd7021aec99b482eeb7c735bd3945f6d2fdb65f7efa2316d453c91ef3a63b8457'

/** Private canonical location and fixed first frame; no program, engine or source approval is caller-selected. */
export interface H3CanonicalOwnerConfig {
  readonly schema: 'qianshou.h3-owner.canonical.v1'
  readonly adapterBase: string
  readonly firstFramePath: string
  readonly negative: string
  readonly selfTestPath: string
}

/** Actual local preparation; only the six public fields can enter a publication. */
export interface NativeH3LocalIdentityCanonical {
  readonly binding: NativeH3CanonicalExecutionBinding
  readonly localOwnerConfigDigest: string
}

interface H3CanonicalProvider {
  nativeAuthorBindingCanonical(): Promise<NativeH3LocalIdentityCanonical>
  loadAndSelfTestCanonical(): Promise<ArtifactOrderAdapter | null>
  status(): H3VideoReadiness
}

interface Measured extends NativeH3LocalIdentityCanonical {
  readonly config: H3CanonicalOwnerConfig
  readonly configSha256: string
  readonly frame: Buffer
  readonly identity: H3CanonicalIdentity
  readonly owner: H3OwnerRuntimeIdentity
}
const HASH = /^[a-f0-9]{64}$/u
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
function fail(code: string): never { throw new ComputeError(code, 409) }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('H3_CANONICAL_OWNER_CONFIG_INVALID')
  return value as Record<string, unknown>
}

/** Read only the explicit canonical configuration variant, without network or execution.
 * @param path - Absolute private configuration path selected by the owning Host.
 * @returns Exact canonical fields; V1/V2 configurations and arbitrary executable paths are refused.
 */
export async function readH3CanonicalOwnerConfig(path: string): Promise<H3CanonicalOwnerConfig> {
  const value = row(JSON.parse((await readH3BoundedFile(path, 16 * 1024)).toString('utf8')))
  if (Object.keys(value).sort().join(',') !== 'adapterBase,firstFramePath,negative,schema,selfTestPath'
    || value.schema !== 'qianshou.h3-owner.canonical.v1' || typeof value.adapterBase !== 'string'
    || typeof value.negative !== 'string' || !value.negative.isWellFormed() || Array.from(value.negative).length > 3000
    || typeof value.firstFramePath !== 'string' || !isAbsolute(value.firstFramePath)
    || typeof value.selfTestPath !== 'string' || !isAbsolute(value.selfTestPath)) fail('H3_CANONICAL_OWNER_CONFIG_INVALID')
  canonicalH3Endpoint(value.adapterBase, { kind: 'identity' })
  return Object.freeze({ schema: 'qianshou.h3-owner.canonical.v1', adapterBase: value.adapterBase,
    firstFramePath: value.firstFramePath, negative: value.negative, selfTestPath: value.selfTestPath })
}

/** Prepare only the fixed canonical software and an existing same-witness real local job receipt.
 * @param configPath - Host-selected canonical private configuration, independent of managed V2 pointers.
 * @returns Explicit canonical identity/preparation ports and a finite local readiness observation.
 */
export function createH3CanonicalProvider(configPath: string): H3CanonicalProvider {
  let observation: H3VideoReadiness = { configured: configPath !== '', ready: false, code: 'H3_NOT_CHECKED' }
  const measure = async (signal: AbortSignal): Promise<Measured> => {
    const configBytes = await readH3BoundedFile(configPath, 16 * 1024)
    const config = await readH3CanonicalOwnerConfig(configPath)
    const frame = await readH3BoundedFile(config.firstFramePath, 16 * 1024 * 1024)
    if (frame.length <= 8 || !frame.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      fail('H3_CANONICAL_FIRST_FRAME_INVALID')
    }
    const options = { timeoutMs: 15_000, signal }
    const identity = await readH3CanonicalIdentity(config.adapterBase, options)
    // The recipe parser's self-consistency is not a software allowlist.
    if (identity.sourceManifestSha256 !== H3_CANONICAL_SOURCE_MANIFEST_SHA256) fail('H3_CANONICAL_SOFTWARE_UNSUPPORTED')
    const owner = await readH3OwnerRuntimeIdentity(config.adapterBase, identity, options)
    const binding = parseNativeH3CanonicalExecutionBinding({ schema: 'qianshou.native-h3-execution-binding.v2',
      runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL,
      executionRecipeSha256: identity.executionRecipeSha256, modelSha256: identity.modelSha256, firstFrameSha256: sha(frame) })
    const configSha256 = sha(configBytes)
    const localOwnerConfigDigest = 'sha256:' + sha(canonicalNativeH3ReviewJson({ configSha256,
      ownerConfigDigest: owner.ownerConfigDigest, firstFrameSha256: binding.firstFrameSha256,
      executionRecipeSha256: binding.executionRecipeSha256, modelSha256: binding.modelSha256 }))
    if (!(await readH3BoundedFile(configPath, 16 * 1024)).equals(configBytes)
      || !(await readH3BoundedFile(config.firstFramePath, 16 * 1024 * 1024)).equals(frame)) {
      fail('H3_OWNER_CONFIGURATION_CHANGED')
    }
    return { config, configSha256, frame, identity, owner, binding, localOwnerConfigDigest }
  }
  const assertSame = async (initial: Measured, signal: AbortSignal): Promise<void> => {
    const after = await measure(signal)
    if (after.localOwnerConfigDigest !== initial.localOwnerConfigDigest
      || canonicalNativeH3ReviewJson(after.binding) !== canonicalNativeH3ReviewJson(initial.binding)
      || after.owner.ownerRuntimeWitnessSha256 !== initial.owner.ownerRuntimeWitnessSha256) {
      fail('H3_EXECUTION_IDENTITY_CHANGED')
    }
  }
  const prepare = async (signal: AbortSignal): Promise<Measured> => {
    const initial = await measure(signal)
    const receipt = row(JSON.parse((await readH3BoundedFile(initial.config.selfTestPath, 16 * 1024)).toString('utf8')))
    if (Object.keys(receipt).sort().join(',') !== 'configSha256,jobId,ownerRuntimeWitnessSha256,schema'
      || receipt.schema !== 'qianshou.h3-self-test.canonical.v1' || receipt.configSha256 !== initial.configSha256
      || receipt.ownerRuntimeWitnessSha256 !== initial.owner.ownerRuntimeWitnessSha256
      || typeof receipt.jobId !== 'string' || !HASH.test(receipt.configSha256)) {
      fail('H3_CANONICAL_REAL_SELF_TEST_REQUIRED')
    }
    const expected: H3WitnessedJobExpectation = { adapterBase: initial.config.adapterBase, jobId: receipt.jobId,
      identity: initial.identity, owner: initial.owner, comfyFfmpegSha256: initial.owner.comfyFfmpegSha256,
      deliveryFfmpegSha256: initial.owner.deliveryFfmpegSha256 }
    const completed = await readH3WitnessedJob(expected, { timeoutMs: 15_000, signal })
    await readH3WitnessedMedia(expected, completed, { timeoutMs: 15_000, signal })
    await assertSame(initial, signal)
    return initial
  }
  const nativeAuthorBindingCanonical = async (): Promise<NativeH3LocalIdentityCanonical> => {
    try {
      const value = await prepare(new AbortController().signal)
      observation = { configured: true, ready: true, code: 'H3_CANONICAL_REAL_SELF_TEST_VERIFIED' }
      return Object.freeze({ binding: value.binding, localOwnerConfigDigest: value.localOwnerConfigDigest })
    } catch (error) {
      observation = { configured: configPath !== '', ready: false,
        code: error instanceof ComputeError ? error.code : 'H3_CANONICAL_PREPARATION_FAILED' }
      throw error
    }
  }
  const loadAndSelfTestCanonical = async (): Promise<ArtifactOrderAdapter | null> => {
    try {
      const initial = await prepare(new AbortController().signal)
      observation = { configured: true, ready: true, code: 'H3_CANONICAL_REAL_SELF_TEST_VERIFIED' }
      const adapter: ArtifactOrderAdapter = { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref', contractVersion: 'v1',
        artifactDigest: 'sha256:' + H3_CANONICAL_SOURCE_MANIFEST_SHA256,
        packageDigest: nativeH3PublicBindingDigest(initial.binding), outputFormats: Object.freeze(['mp4'] as const),
        maxInputBytes: 32 * 1024,
        prepareRequest(inline, parameters) {
          if (Object.keys(parameters).some(key => !['seed', 'seconds'].includes(key))
            || parameters.seconds !== undefined && parameters.seconds !== 5
            || parameters.seed !== undefined && (!Number.isSafeInteger(parameters.seed) || Number(parameters.seed) < 0
              || Number(parameters.seed) > 2147483647) || !inline.isWellFormed()
            || Array.from(inline.trim()).length < 1 || Array.from(inline.trim()).length > 7000) fail('H3_CANONICAL_INPUT_INVALID')
          return { recipeJson: JSON.stringify({ prompt: inline.trim(), seed: parameters.seed ?? 1, seconds: 5 }), outputFormat: 'mp4' }
        },
        async run(input) {
          if (input.outputFormat !== 'mp4') fail('H3_CANONICAL_INPUT_INVALID')
          const recipe = row(JSON.parse(input.recipeJson))
          if (Object.keys(recipe).sort().join(',') !== 'prompt,seconds,seed' || recipe.seconds !== 5
            || typeof recipe.prompt !== 'string' || typeof recipe.seed !== 'number') fail('H3_CANONICAL_INPUT_INVALID')
          return runH3CanonicalExecution({ adapterBase: initial.config.adapterBase, identity: initial.identity,
            owner: initial.owner, firstFrame: initial.frame, negative: initial.config.negative,
            assertCurrent: signal => assertSame(initial, signal) }, {
            prompt: recipe.prompt, seed: recipe.seed, workspacePath: input.workspacePath, signal: input.signal })
        } }
      return Object.freeze(adapter)
    } catch (error) {
      observation = { configured: configPath !== '', ready: false,
        code: error instanceof ComputeError ? error.code : 'H3_CANONICAL_PREPARATION_FAILED' }
      return null
    }
  }
  return { nativeAuthorBindingCanonical, loadAndSelfTestCanonical, status: (): H3VideoReadiness => ({ ...observation }) }
}
