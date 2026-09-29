/** Account-bound Shanghai submission. Only control metadata crosses this transport. */
import { CatalogFailure } from './registry.ts'
import type { OrderPublicationLifecycle, OrderPublicationLifecycleReceipt, ManageOrderSkillPublicationRequest } from './types.ts'
import type { NativeH3TaskDefinition } from './native-h3-order-source.ts'
import type { GenericTaskDefinition } from './generic-order-source.ts'
import type { ComfyVideoTaskDefinition } from './comfy-video-order-source.ts'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MAX_RESPONSE_BYTES = 32 * 1024
const PRICE = /^(?:0|[1-9]\d{0,5})\.\d{2}$/u

export interface OrderPublicationPayload {
  task_type: string
  capability_id: string
  input_kinds: ['inline'] | ['multi_file']
  output_kind: 'artifact_ref' | 'inline_json'
  contract_version: 'v1' | 'v2'
  artifact_digest: string
  package_digest: string
  version: string
  name: string
  category: string
  description: string
  configuration: string
  task_definition?: GenericTaskDefinition | NativeH3TaskDefinition | ComfyVideoTaskDefinition
  currency: 'CNY'
  price_yuan?: string
  sale_price_yuan?: string
}

export interface PlatformPublicationCommerce {
  readonly salePriceYuan?: string | null
  readonly marketProductId?: string | null
  readonly marketProductStatus?: 'review' | 'published' | 'rejected' | 'suspended' | null
}

function commerce(row: Record<string, unknown>): PlatformPublicationCommerce {
  const sale = row.sale_price_yuan, id = row.market_product_id, status = row.market_product_status
  if ((sale !== undefined && sale !== null && (typeof sale !== 'string' || !PRICE.test(sale) || Number(sale) > 100000))
    || (id !== undefined && id !== null && (typeof id !== 'string' || !ID.test(id)))
    || (status !== undefined && status !== null && !['review', 'published', 'rejected', 'suspended'].includes(String(status)))
    || (typeof status === 'string' && typeof id !== 'string')) throw new CatalogFailure('order-platform-unavailable')
  return { ...(sale === undefined ? {} : { salePriceYuan: sale }),
    ...(id === undefined ? {} : { marketProductId: id }),
    ...(status === undefined ? {} : { marketProductStatus: status as Exclude<PlatformPublicationCommerce['marketProductStatus'], undefined> }) }
}

export interface PlatformOrderPublicationReceipt extends PlatformPublicationCommerce {
  readonly id: string
  readonly ownerId: number
  readonly status: 'review' | 'approved'
  readonly artifactDigest: string
  readonly priceYuan: string
  readonly reviewReasons: readonly string[]
}

export interface PlatformOrderPricePreview {
  readonly priceYuan: string
  readonly settingsVersion: number
  readonly taskDefinitionSha256: string
}

/** A nonbinding CNY preview; submission must still check the current platform tariff. */
export async function previewPlatformOrderPublicationPrice(input: {
  readonly origin: string
  readonly token: string
  readonly taskType: string
  readonly taskDefinition: GenericTaskDefinition | NativeH3TaskDefinition | ComfyVideoTaskDefinition
  readonly taskDefinitionSha256: string
  readonly fetch?: typeof fetch
}): Promise<PlatformOrderPricePreview> {
  const origin = safeOrigin(input.origin)
  if (!input.token || /[\r\n]/u.test(input.token) || !DIGEST.test(input.taskDefinitionSha256)
    || input.taskDefinition.taskType !== input.taskType) throw new CatalogFailure('order-platform-contract')
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(new URL('/api/v8/task-adapter-publications/price-preview', origin), {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'content-type': 'application/json',
        authorization: `Bearer ${input.token}` },
      body: JSON.stringify({ task_type: input.taskType, task_definition: input.taskDefinition }),
    })
  } catch { throw new CatalogFailure('order-platform-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Ignore remote response text. */ }
    if (response.status === 400) throw new CatalogFailure('order-platform-contract')
    if (response.status === 404) throw new CatalogFailure('order-platform-route-unavailable')
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    throw new CatalogFailure('order-platform-unavailable')
  }
  const data = await boundedJson(response)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new CatalogFailure('order-platform-unavailable')
  }
  const row = data as Record<string, unknown>
  if (row.pricing_mode !== 'platform' || row.currency !== 'CNY'
    || typeof row.price_yuan !== 'string' || !PRICE.test(row.price_yuan)
    || typeof row.settings_version !== 'number' || !Number.isSafeInteger(row.settings_version)
    || row.settings_version < 1 || row.task_definition_sha256 !== input.taskDefinitionSha256
    || row.input_contract !== input.taskDefinition.inputContract
    || row.result_strategy !== input.taskDefinition.resultStrategy
    || row.output_kind !== input.taskDefinition.outputKind) {
    throw new CatalogFailure('order-platform-unavailable')
  }
  return { priceYuan: row.price_yuan, settingsVersion: row.settings_version,
    taskDefinitionSha256: row.task_definition_sha256 }
}

function safeOrigin(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new CatalogFailure('order-platform-unavailable') }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new CatalogFailure('order-platform-unavailable')
  }
  return url
}

async function boundedJson(response: Response, limit = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (response.body === null) throw new CatalogFailure('order-platform-unavailable')
  const reader = response.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new CatalogFailure('order-platform-unavailable')
      chunks.push(next.value)
    }
  } finally {
    try { await reader.cancel() } catch { /* Stream can already be closed. */ }
    reader.releaseLock()
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new CatalogFailure('order-platform-unavailable') }
}

export interface PlatformOwnedOrderPublication extends PlatformPublicationCommerce {
  readonly name?: string
  readonly lifecycle?: OrderPublicationLifecycle
  readonly id: string
  readonly ownerId: number
  readonly taskType: string
  readonly artifactDigest: string
  readonly packageDigest: string
  readonly priceYuan?: string
  readonly status: 'review' | 'approved' | 'rejected'
  readonly reviewReasons: readonly string[]
  readonly evidenceStatus?: Readonly<Record<string, 'missing' | 'valid' | 'invalid'>>
  readonly packageUploadStatus: 'missing' | 'prepared' | 'confirmed'
  readonly authorManifestStatus: 'missing' | 'recorded'
  readonly reviewSampleStatus?: 'blocked' | 'pending' | 'running' | 'verified' | 'evidence_deposited' | 'independent_sample_required'
  readonly mediaEvidenceStatus?: 'missing' | 'valid' | 'invalid'
}

/** Account-scoped author history. No local cache can manufacture an approval. */
export async function listPlatformOrderPublications(input: {
  readonly origin: string
  readonly token: string
  readonly fetch?: typeof fetch
  readonly includeArchived?: boolean
}): Promise<readonly PlatformOwnedOrderPublication[]> {
  const origin = safeOrigin(input.origin)
  if (!input.token || /[\r\n]/u.test(input.token)) throw new CatalogFailure('order-platform-unavailable')
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(new URL(`/api/v8/task-adapter-publications/mine${input.includeArchived ? '?include_archived=true' : ''}`, origin), {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', authorization: `Bearer ${input.token}` },
    })
  } catch { throw new CatalogFailure('order-platform-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Ignore remote response text. */ }
    if (response.status === 404) throw new CatalogFailure('order-platform-route-unavailable')
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    throw new CatalogFailure('order-platform-unavailable')
  }
  const data = await boundedJson(response, 512 * 1024)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new CatalogFailure('order-platform-unavailable')
  }
  const items = (data as Record<string, unknown>).items
  if (!Array.isArray(items) || items.length > 100) throw new CatalogFailure('order-platform-unavailable')
  const result: PlatformOwnedOrderPublication[] = []
  let ownerId: number | null = null
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CatalogFailure('order-platform-unavailable')
    }
    const row = item as Record<string, unknown>
    if ((row.name !== undefined && (typeof row.name !== 'string' || row.name.length < 1 || row.name.length > 100))
      || typeof row.id !== 'string' || !ID.test(row.id)
      || typeof row.owner_id !== 'number' || !Number.isSafeInteger(row.owner_id) || row.owner_id < 1
      || typeof row.task_type !== 'string' || row.task_type.length > 100
      || typeof row.artifact_digest !== 'string' || !DIGEST.test(row.artifact_digest)
      || typeof row.package_digest !== 'string' || !DIGEST.test(row.package_digest)
      || (row.price_yuan !== undefined && (typeof row.price_yuan !== 'string'
        || !PRICE.test(row.price_yuan)))
      || !['review', 'approved', 'rejected'].includes(String(row.status))
      || !Array.isArray(row.review_reasons) || row.review_reasons.length > 32
      || (row.package_upload_status !== undefined
        && !['missing', 'prepared', 'confirmed'].includes(String(row.package_upload_status)))
      || (row.author_manifest_status !== undefined
        && !['missing', 'recorded'].includes(String(row.author_manifest_status)))
      || (row.review_sample_status !== undefined
        && !['blocked', 'pending', 'running', 'verified', 'evidence_deposited',
          'independent_sample_required'].includes(String(row.review_sample_status)))
      || (row.media_evidence_status !== undefined
        && !['missing', 'valid', 'invalid'].includes(String(row.media_evidence_status)))
      || !row.review_reasons.every(reason => typeof reason === 'string' && reason.length <= 1000)
      || (row.evidence_status !== undefined && (row.evidence_status === null
        || typeof row.evidence_status !== 'object' || Array.isArray(row.evidence_status)
        || Object.entries(row.evidence_status).length > 5
        || Object.entries(row.evidence_status).some(([kind, status]) =>
          !['package', 'sample', 'media', 'pricing', 'review'].includes(kind)
          || typeof status !== 'string' || !['missing', 'valid', 'invalid'].includes(status))))
      || ownerId !== null && ownerId !== row.owner_id) {
      throw new CatalogFailure('order-platform-unavailable')
    }
    ownerId = row.owner_id
    result.push({ id: row.id, ownerId: row.owner_id, taskType: row.task_type,
      ...(row.name === undefined ? {} : { name: row.name }),
      ...(row.lifecycle === undefined ? {} : { lifecycle: parsePublicationLifecycle(row.lifecycle) }),
      ...commerce(row),
      artifactDigest: row.artifact_digest, packageDigest: row.package_digest,
      ...(row.price_yuan === undefined ? {} : { priceYuan: row.price_yuan }),
      status: row.status as PlatformOwnedOrderPublication['status'],
      reviewReasons: row.review_reasons,
      ...(row.evidence_status === undefined ? {} : {
        evidenceStatus: row.evidence_status as NonNullable<PlatformOwnedOrderPublication['evidenceStatus']> }),
      packageUploadStatus: (row.package_upload_status ?? 'missing') as PlatformOwnedOrderPublication['packageUploadStatus'],
      authorManifestStatus: (row.author_manifest_status ?? 'missing') as PlatformOwnedOrderPublication['authorManifestStatus'],
      ...(row.review_sample_status === undefined ? {} : {
        reviewSampleStatus: row.review_sample_status as NonNullable<PlatformOwnedOrderPublication['reviewSampleStatus']> }),
      ...(row.media_evidence_status === undefined ? {} : {
        mediaEvidenceStatus: row.media_evidence_status as NonNullable<PlatformOwnedOrderPublication['mediaEvidenceStatus']> }) })
  }
  return result
}

/** Submit idempotent exact-digest metadata and require a confirmed platform id. */
export async function submitPlatformOrderPublication(input: {
  readonly origin: string
  readonly token: string
  readonly payload: OrderPublicationPayload
  readonly fetch?: typeof fetch
}): Promise<PlatformOrderPublicationReceipt> {
  const origin = safeOrigin(input.origin)
  if (!input.token || /[\r\n]/u.test(input.token) || !DIGEST.test(input.payload.artifact_digest)
    || !DIGEST.test(input.payload.package_digest)
    || (input.payload.sale_price_yuan !== undefined && (!PRICE.test(input.payload.sale_price_yuan)
      || Number(input.payload.sale_price_yuan) > 100000))) throw new CatalogFailure('order-platform-unavailable')
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(new URL('/api/v8/task-adapter-publications', origin), {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'content-type': 'application/json',
        authorization: `Bearer ${input.token}` },
      body: JSON.stringify(input.payload),
    })
  } catch { throw new CatalogFailure('order-platform-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Ignore remote response text. */ }
    if (response.status === 400) throw new CatalogFailure('order-platform-contract')
    if (response.status === 404) throw new CatalogFailure('order-platform-route-unavailable')
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    if (response.status === 409) throw new CatalogFailure('order-publication-conflict')
    throw new CatalogFailure('order-platform-unavailable')
  }
  const data = await boundedJson(response)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new CatalogFailure('order-platform-unavailable')
  const row = data as Record<string, unknown>
  if (typeof row.id !== 'string' || !ID.test(row.id) || typeof row.owner_id !== 'number'
    || !Number.isSafeInteger(row.owner_id) || row.owner_id < 1
    || (row.status !== 'review' && row.status !== 'approved')
    || row.task_type !== input.payload.task_type || row.artifact_digest !== input.payload.artifact_digest
    || row.package_digest !== input.payload.package_digest || row.currency !== 'CNY'
    || typeof row.price_yuan !== 'string' || !PRICE.test(row.price_yuan)
    || (input.payload.price_yuan !== undefined
      && row.price_yuan !== Number(input.payload.price_yuan).toFixed(2))
    || (input.payload.sale_price_yuan !== undefined && row.sale_price_yuan !== input.payload.sale_price_yuan)
    || !Array.isArray(row.review_reasons) || !row.review_reasons.every(reason => typeof reason === 'string')) {
    throw new CatalogFailure('order-platform-unavailable')
  }
  return { id: row.id, ownerId: row.owner_id, status: row.status,
    ...commerce(row),
    artifactDigest: row.artifact_digest, priceYuan: row.price_yuan,
    reviewReasons: row.review_reasons }
}

/** Reject malformed or unknown server permissions instead of inferring them locally. */
export function parsePublicationLifecycle(value: unknown): OrderPublicationLifecycle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CatalogFailure('order-platform-unavailable')
  const row = value as Record<string, unknown>
  const actions = row.allowed_actions, reasons = row.blocking_reasons
  if ((typeof row.state !== 'string' || !['active', 'withdrawn', 'delisted'].includes(row.state)) || typeof row.archived !== 'boolean'
    || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0
    || !Array.isArray(actions) || actions.length > 4 || new Set(actions).size !== actions.length
    || actions.some(action => typeof action !== 'string' || !['withdraw', 'delist', 'archive', 'restore'].includes(action))
    || !Array.isArray(reasons) || reasons.length > 2 || new Set(reasons).size !== reasons.length
    || reasons.some(reason => typeof reason !== 'string' || !['active-orders', 'pending-install'].includes(reason))) {
    throw new CatalogFailure('order-platform-unavailable')
  }
  return { state: row.state as OrderPublicationLifecycle['state'], archived: row.archived,
    revision: row.revision, allowedActions: actions as OrderPublicationLifecycle['allowedActions'],
    blockingReasons: reasons as OrderPublicationLifecycle['blockingReasons'] }
}

/** An exact authenticated record and captured revision are the only mutation inputs. */
export async function managePlatformOrderPublication(input: ManageOrderSkillPublicationRequest & {
  readonly origin: string
  readonly token: string
  readonly ownerId: number
  readonly fetch?: typeof fetch
}): Promise<OrderPublicationLifecycleReceipt> {
  const origin = safeOrigin(input.origin)
  if (!input.token || /[\r\n]/u.test(input.token) || !ID.test(input.publicationId)
    || !['withdraw', 'delist', 'archive', 'restore'].includes(input.action)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || typeof input.note !== 'string' || input.note.trim().length < 1 || input.note.length > 500) {
    throw new CatalogFailure('order-platform-contract')
  }
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(new URL(`/api/v8/task-adapter-publications/${input.publicationId}/lifecycle`, origin), {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.token}` },
      body: JSON.stringify({ action: input.action, expected_revision: input.expectedRevision, note: input.note.trim() }),
    })
  } catch { throw new CatalogFailure('order-platform-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* No untrusted remote text reaches the UI. */ }
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    if (response.status === 409) throw new CatalogFailure('order-publication-conflict')
    if (response.status === 404) throw new CatalogFailure('order-platform-route-unavailable')
    throw new CatalogFailure('order-platform-unavailable')
  }
  const value = await boundedJson(response)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CatalogFailure('order-platform-unavailable')
  const row = value as Record<string, unknown>
  const lifecycle = parsePublicationLifecycle(row.lifecycle)
  if (row.publication_id !== input.publicationId || row.owner_id !== input.ownerId
    || typeof row.name !== 'string' || row.name.length < 1 || row.name.length > 100
    || typeof row.status !== 'string' || !['review', 'approved', 'rejected'].includes(row.status)
    || lifecycle.revision !== input.expectedRevision + 1
    || (input.action === 'archive' && !lifecycle.archived)
    || (input.action === 'restore' && lifecycle.archived)
    || (input.action === 'withdraw' && lifecycle.state !== 'withdrawn')
    || (input.action === 'delist' && lifecycle.state !== 'delisted')) throw new CatalogFailure('order-platform-unavailable')
  return { publicationId: input.publicationId, ownerId: input.ownerId, name: row.name,
    status: row.status as OrderPublicationLifecycleReceipt['status'], lifecycle }
}
