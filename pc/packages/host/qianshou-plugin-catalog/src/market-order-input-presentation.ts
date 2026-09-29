/** Read-only controls derived from exact signed examples, independent of execution permission. */
import { readVerifiedOrderAdapterSource, type VerifiedOrderAdapterSource } from './order-products-http.ts'
import { downloadArchive } from './order-product-source-stage.ts'
import { inspectOrderProductSourceArchive } from './order-product-source-archive.ts'
import { CatalogFailure } from './registry.ts'
import type { MarketOrderInputPresentation, MarketOrderInputPresentationRequest } from './types.ts'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function json(bytes: Buffer | undefined): Record<string, unknown> | null {
  if (bytes === undefined || bytes.length > 16384) return null
  try { return record(JSON.parse(bytes.toString('utf8')) as unknown) } catch { return null }
}

function unavailable(request: MarketOrderInputPresentationRequest, reason: string): MarketOrderInputPresentation {
  return { ...request, status: 'unavailable', contentSchemaJson: null, fixedInputJson: null, reason }
}

/**
 * Project one varying string and fixed primitive values from validated immutable sample bytes.
 * @param request - Exact product, task, product version and artifact selected by the owner.
 * @param source - Owner-accessible signed inventory, verified before inspecting its archive.
 * @param files - Exact files returned by the archive digest and inventory verifier.
 * @returns Display-only controls, or an explicit inability to infer controls; no new task schema.
 */
export function projectMarketOrderInputPresentation(request: MarketOrderInputPresentationRequest,
  source: VerifiedOrderAdapterSource, files: ReadonlyMap<string, Buffer>): MarketOrderInputPresentation {
  if (source.check.productId !== request.productId || source.taskType !== request.taskType
    || source.productVersion !== request.version || source.artifactDigest !== request.artifactDigest) {
    return unavailable(request, 'source-changed')
  }
  const task = json(files.get('task-definition.json'))
  const input = record(task?.inputSchema)
  if (task?.taskType !== request.taskType || task.inputContract !== 'inline-json-bounded.v1'
    || input?.type !== 'string' || input.contentMediaType !== 'application/json'
    || !Number.isSafeInteger(input.maxLength) || Number(input.maxLength) < 1 || Number(input.maxLength) > 16384
    || input.contentSchema !== undefined) return unavailable(request, 'input-definition-not-legacy')
  const adapter = json(files.get('local-adapter.json'))
  if (adapter?.taskType !== request.taskType || !Array.isArray(adapter.selfTests)
    || adapter.selfTests.length < 2 || adapter.selfTests.length > 8) return unavailable(request, 'samples-unavailable')
  const samples: Record<string, unknown>[] = []
  for (const item of adapter.selfTests) {
    const entry = record(item)
    const path = entry?.input
    if (typeof path !== 'string' || !path.startsWith('samples/')
      || !source.files.some(file => file.path === path)) return unavailable(request, 'samples-unavailable')
    const sample = json(files.get(path))
    if (sample === null || Object.keys(sample).length < 1 || Object.keys(sample).length > 32
      || Object.entries(sample).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)
        || ['__proto__', 'constructor', 'prototype'].includes(key)
        || typeof value !== 'string' && typeof value !== 'boolean'
          && !(typeof value === 'number' && Number.isFinite(value))
        || typeof value === 'string' && (!value.isWellFormed() || value.length > 16384))) {
      return unavailable(request, 'samples-not-flat')
    }
    samples.push(sample)
  }
  const first = samples[0]
  if (first === undefined) return unavailable(request, 'samples-unavailable')
  const keys = Object.keys(first).sort()
  if (samples.some(sample => Object.keys(sample).sort().join('\0') !== keys.join('\0')
    || keys.some(key => typeof sample[key] !== typeof first[key]))) return unavailable(request, 'samples-inconsistent')
  const varying = keys.filter(key => samples.some(sample => sample[key] !== first[key]))
  const key = varying[0]
  if (varying.length !== 1 || key === undefined || typeof first[key] !== 'string') {
    return unavailable(request, 'samples-ambiguous')
  }
  const fixed = Object.fromEntries(keys.filter(name => name !== key).map(name => [name, first[name]]))
  const contentSchema = { type: 'object', additionalProperties: false, required: [key],
    properties: { [key]: { type: 'string', title: '输入内容', minLength: 0, maxLength: Number(input.maxLength) } } }
  return { ...request, status: 'available', contentSchemaJson: JSON.stringify(contentSchema),
    fixedInputJson: JSON.stringify(fixed), reason: null }
}

/**
 * Read authorized signed source bytes solely to prepare legacy market controls.
 * @param input - Exact selection, current access token, pinned issuer keys and COS host.
 * @returns Bounded presentation metadata without URLs, installation, execution or filesystem writes.
 */
export async function readMarketOrderInputPresentation(input: {
  request: MarketOrderInputPresentationRequest
  origin: string
  token: string
  trustedPackageIssuerKeys: Record<string, string>
  trustedArchiveHostname: string
  fetch?: typeof fetch
}): Promise<MarketOrderInputPresentation> {
  const request = input.request
  if (Object.keys(request).sort().join(',') !== 'artifactDigest,productId,taskType,version'
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(request.productId) || !/^[a-z][a-z0-9_.-]{0,127}$/u.test(request.taskType)
    || typeof request.version !== 'string' || request.version.length < 1 || request.version.length > 64
    || !/^sha256:[a-f0-9]{64}$/u.test(request.artifactDigest)) throw new CatalogFailure('order-draft-invalid')
  if (!input.token) return unavailable(request, 'source-access-required')
  try {
    const source = await readVerifiedOrderAdapterSource({ origin: input.origin, token: input.token,
      productId: request.productId, trustedPackageIssuerKeys: input.trustedPackageIssuerKeys,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }) })
    if (source.check.productId !== request.productId || source.taskType !== request.taskType
      || source.productVersion !== request.version || source.artifactDigest !== request.artifactDigest) {
      return unavailable(request, 'source-changed')
    }
    const bytes = await downloadArchive(source, input.trustedArchiveHostname, input.fetch ?? fetch)
    return projectMarketOrderInputPresentation(request, source, inspectOrderProductSourceArchive(bytes, source).files)
  } catch { return unavailable(request, 'source-unavailable') }
}
