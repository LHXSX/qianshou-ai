/** Public task-type catalog. A listing is neither a quote nor evidence of an online executor. */
import { CatalogFailure } from './registry.ts'
import type { MarketCapability } from './types.ts'

const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const PRICE = /^(?:0|[1-9]\d{0,5})\.\d{2}$/u
const MAX_BYTES = 512 * 1024

function invalid(): never { throw new CatalogFailure('market-capabilities-invalid') }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function string(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value)) invalid()
  return value
}
function name(value: unknown): string {
  const result = string(value, 100)
  if (!NAME.test(result)) invalid()
  return result
}
function names(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) invalid()
  return value.map(name)
}
function displayName(value: unknown): string {
  // Older catalogs used the execution description as the title. Keep that
  // display-only defect from rejecting unrelated, correctly bound contracts.
  const label = string(value, MAX_BYTES).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
  if (!label) invalid()
  const characters = [...label]
  return characters.length > 120 ? `${characters.slice(0, 119).join('')}…` : label
}
function publisher(value: unknown): 'official' | 'user' {
  if (value !== 'official' && value !== 'user') invalid()
  return value
}
function product(value: unknown): MarketCapability['products'][number] {
  const item = row(value)
  if (typeof item.product_id !== 'string' || !ID.test(item.product_id)
    || typeof item.publication_id !== 'string' || !ID.test(item.publication_id)
    || typeof item.owner_id !== 'number' || !Number.isSafeInteger(item.owner_id) || item.owner_id < 1
    || typeof item.available_to_purchase !== 'boolean') invalid()
  const price = string(item.sale_price_yuan, 32)
  if (!PRICE.test(price)) invalid()
  return { productId: item.product_id, publicationId: item.publication_id,
    ownerId: item.owner_id, version: string(item.version, 40), salePriceYuan: price,
    availableToPurchase: item.available_to_purchase }
}
function capability(value: unknown): MarketCapability {
  const item = row(value)
  const accepted = names(item.accepted_input_kinds, 8)
  if (accepted.length < 1) invalid()
  const defaultKind = name(item.default_input_kind)
  if (!accepted.includes(defaultKind)) invalid()
  if (!Array.isArray(item.publisher_kinds) || item.publisher_kinds.length < 1
    || item.publisher_kinds.length > 2 || !Array.isArray(item.products)
    || item.products.length > 100 || item.requires_quote !== true
    || (item.execution_quote_path !== '/api/v8/developer/tasks/estimate'
      && !(item.availability !== 'contract_ready' && item.execution_quote_path === null))
    || item.currency !== 'CNY'
    || (item.execution_mode !== 'device' && item.execution_mode !== 'cloud')
    || (item.availability !== 'contract_ready' && item.availability !== 'published_no_dispatch_contract'
      && item.availability !== 'paused' && item.availability !== 'unavailable')
    || item.callable !== (item.availability === 'contract_ready')) invalid()
  const kinds = item.publisher_kinds.map(publisher)
  const primary = publisher(item.publisher_kind)
  if (!kinds.includes(primary)) invalid()
  return { taskType: name(item.task_type), capabilityId: name(item.capability_id),
    name: displayName(item.name), description: string(item.description, 1000, true),
    category: string(item.category, 40), categoryLabelZh: string(item.category_label_zh, 40),
    acceptedInputKinds: accepted, defaultInputKind: defaultKind,
    requiredParams: names(item.required_params, 64), outputKind: name(item.output_kind),
    contractVersion: name(item.contract_version), publisherKind: primary,
    publisherKinds: kinds, executionMode: item.execution_mode,
    availability: item.availability,
    ...(typeof item.form_ready === 'boolean' ? { formReady: item.form_ready } : {}),
    requiresQuote: true,
    executionQuotePath: item.execution_quote_path, currency: 'CNY',
    products: item.products.map(product) }
}

/** Reads metadata only. The user must still request an exact quote and approve dispatch. */
export async function listMarketCapabilities(input: {
  origin: string
  fetch?: typeof fetch
}): Promise<{ capabilities: MarketCapability[] }> {
  let origin: URL
  try { origin = new URL(input.origin) } catch { throw new CatalogFailure('market-capabilities-unavailable') }
  const local = origin.hostname === '127.0.0.1' || origin.hostname === '[::1]'
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) {
    throw new CatalogFailure('market-capabilities-unavailable')
  }
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(new URL('/api/v8/order-adapter-products/capabilities', origin), {
      method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
    })
  } catch { throw new CatalogFailure('market-capabilities-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Body may already be closed. */ }
    throw new CatalogFailure('market-capabilities-unavailable')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new CatalogFailure('market-capabilities-unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BYTES) throw new CatalogFailure('market-capabilities-unavailable')
      chunks.push(next.value)
    }
  } finally { try { await reader.cancel() } catch { /* Already closed. */ }; reader.releaseLock() }
  let payload: unknown
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { invalid() }
  const body = row(payload)
  if (!Array.isArray(body.items) || body.items.length > 500 || body.total !== body.items.length) invalid()
  const capabilities = body.items.map(capability)
  if (new Set(capabilities.map(item => item.taskType)).size !== capabilities.length) invalid()
  return { capabilities }
}
