/** Optional H3 image capability reference fixture.
 *
 * This package is not part of the Qianshou product capability set. It exists
 * only to test that a node-owned capability can expose a signed declaration,
 * prompt shaping and a native-runner seam. It never downloads weights or calls
 * a hosted H3 API. Production nodes may advertise any capability they own;
 * the dispatch center must match only those node advertisements.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ComputeCapabilityId, ComputeError, type ComputeExecutionContext, type ComputeExecutionResult, type ComputeExecutor, type ComputeTaskEnvelope, type ComputePluginContract, type ComputeCapabilityPluginManifest, type ComputePluginPermission } from '@deepseek-ai/dsh-compute-core'

export const H3_IMAGE_CAPABILITY_ID = ComputeCapabilityId('image.generate')
export const H3_IMAGE_VERSION = '1.0.0'
export const H3_IMAGE_REQUIRED_PERMISSIONS: readonly ComputePluginPermission[] = Object.freeze(['model.local', 'workspace.write', 'gpu'])

export interface H3ImageParameters {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  seed?: number
}

export interface H3ImageRenderRequest {
  prompt: string
  negativePrompt?: string
  width: number
  height: number
  steps: number
  seed?: number
  outputPath: string
}

export interface H3ImageRenderOutput { path: string; name?: string; metadata?: Readonly<Record<string, string>> }
export interface H3ImageExecutorOptions {
  grantedPermissions: readonly ComputePluginPermission[]
  render: (request: H3ImageRenderRequest, context: ComputeExecutionContext) => Promise<H3ImageRenderOutput>
}

export const H3_IMAGE_CONTRACT: ComputePluginContract = Object.freeze({
  contractVersion: 1, runtime: 'node', entryId: 'image.generate',
  tools: Object.freeze([{ id: 'image.generate', description: 'Render one local image with H3', inputSchemaRef: 'qianshou.schema.image.generate.input.v1', outputSchemaRef: 'qianshou.schema.image.generate.output.v1' }]),
  dependencies: Object.freeze([{ id: 'h3-runtime', version: '^1.0.0', optional: true }]),
  assets: Object.freeze([]),
  budget: Object.freeze({ maxBundleBytes: 262144, maxDependencies: 4, maxAssets: 8, maxTools: 2 }),
})

/** Declaration shown to the market and heartbeat capability advertisement. */
export const H3_IMAGE_MANIFEST: ComputeCapabilityPluginManifest = Object.freeze({
  manifestVersion: 1, pluginId: 'qianshou.h3-image', version: H3_IMAGE_VERSION,
  displayName: 'H3 Local Image', hostRange: '*', pluginDigest: '0'.repeat(64),
  capabilities: Object.freeze([{ id: H3_IMAGE_CAPABILITY_ID, version: H3_IMAGE_VERSION, inputKinds: Object.freeze(['prompt']), outputKinds: Object.freeze(['image']), permissions: H3_IMAGE_REQUIRED_PERMISSIONS, dataScope: 'task-inputs' as const }]),
  contract: H3_IMAGE_CONTRACT,
})

/** Keep system context separate: callers may add policy text, but task text is bounded. */
export function buildH3Prompt(parameters: H3ImageParameters): string {
  const parsed = parseParameters(parameters)
  return ['Generate one image.', `Prompt: ${parsed.prompt}`, ...(parsed.negativePrompt ? [`Negative prompt: ${parsed.negativePrompt}`] : [])].join('\n')
}

/** Build a registry contribution around an injected local H3 implementation. */
export function createH3ImageExecutor(options: H3ImageExecutorOptions): ComputeExecutor {
  const permissions = new Set(options.grantedPermissions)
  for (const required of H3_IMAGE_REQUIRED_PERMISSIONS) if (!permissions.has(required)) throw new ComputeError('COMPUTE_PLUGIN_PERMISSION_DENIED', 403)
  if (typeof options.render !== 'function') throw new ComputeError('COMPUTE_EXECUTOR_INVALID')
  return {
    capabilityId: H3_IMAGE_CAPABILITY_ID,
    version: H3_IMAGE_VERSION,
    async execute(task: ComputeTaskEnvelope, context: ComputeExecutionContext): Promise<ComputeExecutionResult> {
      if ((context as { interactionPolicy?: unknown }).interactionPolicy !== 'autonomous') throw new ComputeError('COMPUTE_HUMAN_INTERACTION_FORBIDDEN', 409)
      context.signal.throwIfAborted()
      const parameters = parseParameters(task.parameters)
      await context.reportProgress(0.05, 'prepare')
      // Resolve through the canonical workspace root so a symlinked temp
      // directory cannot make an in-workspace output look like a traversal.
      const workspaceRoot = await realpath(context.workspacePath)
      const outputPath = resolve(workspaceRoot, 'outputs/image.png')
      await mkdir(dirname(outputPath), { recursive: true })
      const rendered = await options.render({ ...parameters, prompt: buildH3Prompt(parameters), outputPath }, context)
      context.signal.throwIfAborted()
      const verified = await hashOutput(context.workspacePath, rendered.path, rendered.name ?? 'image', context.signal)
      await context.reportProgress(1, 'complete')
      return { outputs: [verified], ...(rendered.metadata ? { metadata: rendered.metadata } : {}) }
    },
  }
}

function parseParameters(
  value: unknown,
): Required<Pick<H3ImageParameters, 'prompt' | 'width' | 'height' | 'steps'>> & Pick<H3ImageParameters, 'negativePrompt' | 'seed'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_INPUT_INVALID', 422)
  const item = value as Record<string, unknown>
  if (typeof item.prompt !== 'string' || item.prompt.trim().length < 1 || item.prompt.length > 4000 || /[\u0000-\u001f\u007f]/u.test(item.prompt)) {
    throw new ComputeError('COMPUTE_INPUT_INVALID', 422)
  }
  const optionalText = item.negativePrompt
  if (optionalText !== undefined && (typeof optionalText !== 'string' || optionalText.length > 2000 || /[\u0000-\u001f\u007f]/u.test(optionalText))) {
    throw new ComputeError('COMPUTE_INPUT_INVALID', 422)
  }
  const width = boundedInt(item.width ?? 1024, 64, 4096)
  const height = boundedInt(item.height ?? 1024, 64, 4096)
  const steps = boundedInt(item.steps ?? 30, 1, 100)
  const seed = item.seed === undefined ? undefined : boundedInt(item.seed, 0, 2147483647)
  return {
    prompt: item.prompt.trim(), ...(optionalText === undefined ? {} : { negativePrompt: optionalText }), width, height, steps,
    ...(seed === undefined ? {} : { seed }),
  }
}
function boundedInt(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ComputeError('COMPUTE_INPUT_INVALID', 422)
  return value
}

async function hashOutput(rootPath: string, requestedPath: string, name: string, signal: AbortSignal) {
  const root = await realpath(rootPath)
  const requested = resolve(requestedPath)
  assertContained(root, requested)
  const path = await realpath(requested)
  assertContained(root, path)
  if ((await lstat(requested)).isSymbolicLink()) throw new ComputeError('COMPUTE_OUTPUT_PATH_INVALID', 422)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)) throw new ComputeError('COMPUTE_OUTPUT_FILE_INVALID', 422)
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let bytes = 0
    while (true) {
      signal.throwIfAborted()
      const read = await file.read(buffer, 0, buffer.length, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    return { name, path, bytes, sha256: hash.digest('hex') }
  } finally { await file.close() }
}
function assertContained(root: string, path: string): void {
  const local = relative(root, path)
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) throw new ComputeError('COMPUTE_OUTPUT_PATH_INVALID', 422)
}
