/** Dedicated Shanghai order-adapter goods. Entitlement is never an installation receipt. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { CatalogFailure } from './registry.ts'
import { LEGACY_INVENTORY_ALGORITHM, SOURCE_INVENTORY_ALGORITHM,
  COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM,
  validateOrderSourceInventory, type OrderSourceFile } from './order-source-inventory.ts'
import type { OrderAdapterProduct, OrderAdapterEntitlement, OrderAdapterInstallCheck,
  OrderAdapterBuyerEntitlement, SellerOrderProduct } from './types.ts'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const TASK_TYPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const PRICE = /^(?:0|[1-9]\d{0,5})\.\d{2}$/u
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/u
const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/u
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,255}$/u
const MAX_JSON_BYTES = 256 * 1024
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function fail(code: 'order-product-invalid' | 'order-install-manifest-invalid'): never {
  throw new CatalogFailure(code)
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function originUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new CatalogFailure('order-product-unavailable') }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new CatalogFailure('order-product-unavailable')
  }
  return url
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new CatalogFailure('order-product-unavailable')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_JSON_BYTES) throw new CatalogFailure('order-product-unavailable')
      chunks.push(part.value)
    }
  } finally {
    try { await reader.cancel() } catch { /* Already closed. */ }
    reader.releaseLock()
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new CatalogFailure('order-product-unavailable') }
}

async function request(input: { origin: string; path: string; token?: string; method?: 'GET' | 'POST';
  idempotencyKey?: string; body?: Record<string, unknown>; sellerSubmission?: boolean;
  fetch?: typeof fetch }): Promise<unknown> {
  const origin = originUrl(input.origin)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (input.token !== undefined) {
    if (!input.token || /[\r\n]/u.test(input.token)) throw new CatalogFailure('order-auth-required')
    headers.authorization = `Bearer ${input.token}`
  }
  if (input.idempotencyKey !== undefined) {
    if (!KEY.test(input.idempotencyKey)) throw new CatalogFailure('order-product-invalid')
    headers['Idempotency-Key'] = input.idempotencyKey
  }
  if (input.body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(new URL(input.path, origin), {
      method: input.method ?? 'GET', headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
    })
  } catch { throw new CatalogFailure('order-product-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Untrusted error bodies are never surfaced. */ }
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    if (response.status === 404) throw new CatalogFailure('order-product-not-found')
    if (response.status === 400 || response.status === 409) throw new CatalogFailure(input.sellerSubmission
      ? 'order-product-submission-rejected' : 'order-purchase-rejected')
    throw new CatalogFailure('order-product-unavailable')
  }
  return boundedJson(response)
}

function sellerProduct(value: unknown): SellerOrderProduct {
  const row = record(value)
  if (row === null || typeof row.id !== 'string' || !ID.test(row.id)
    || typeof row.publication_id !== 'string' || !ID.test(row.publication_id)
    || !['review', 'published', 'rejected'].includes(String(row.status))
    || typeof row.sale_price_yuan !== 'string' || !PRICE.test(row.sale_price_yuan)
    || row.currency !== 'CNY' || typeof row.can_approve !== 'boolean'
    || !Array.isArray(row.review_reasons) || row.review_reasons.length > 30
    || row.review_reasons.some(reason => typeof reason !== 'string' || reason.length > 300)) {
    fail('order-product-invalid')
  }
  return { id: row.id, publicationId: row.publication_id,
    status: row.status as SellerOrderProduct['status'], salePriceYuan: row.sale_price_yuan,
    canApprove: row.can_approve, reviewReasons: row.review_reasons as string[] }
}

/** Restore author-owned product applications from the Shanghai account ledger. */
export async function listSellerOrderProducts(input: { origin: string; token: string;
  fetch?: typeof fetch }): Promise<{ items: SellerOrderProduct[] }> {
  const row = record(await request({ ...input, path: '/api/v8/order-adapter-products/mine' }))
  if (!Array.isArray(row?.items) || row.items.length > 100) fail('order-product-invalid')
  return { items: row.items.map(sellerProduct) }
}

/** One explicit author action; a review receipt is not an approved or purchasable product. */
export async function submitSellerOrderProduct(input: { origin: string; token: string;
  publicationId: string; salePriceYuan: string; fetch?: typeof fetch }): Promise<SellerOrderProduct> {
  if (!ID.test(input.publicationId) || !PRICE.test(input.salePriceYuan)
    || Number(input.salePriceYuan) < 0 || Number(input.salePriceYuan) > 100000) {
    fail('order-product-invalid')
  }
  const row = sellerProduct(await request({ ...input,
    path: '/api/v8/order-adapter-products', method: 'POST', sellerSubmission: true,
    body: { publication_id: input.publicationId,
      sale_price_yuan: input.salePriceYuan, currency: 'CNY' } }))
  if (row.publicationId !== input.publicationId || row.salePriceYuan !== input.salePriceYuan) {
    fail('order-product-invalid')
  }
  return row
}

function product(value: unknown): OrderAdapterProduct {
  const row = record(value)
  if (row === null || typeof row.id !== 'string' || !ID.test(row.id)
    || typeof row.publication_id !== 'string' || !ID.test(row.publication_id)
    || typeof row.owner_id !== 'number' || !Number.isSafeInteger(row.owner_id) || row.owner_id < 1
    || typeof row.task_type !== 'string' || !TASK_TYPE.test(row.task_type)
    || (row.capability_id !== undefined && (typeof row.capability_id !== 'string'
      || !TASK_TYPE.test(row.capability_id)))
    || (row.accepted_input_kinds !== undefined && (!Array.isArray(row.accepted_input_kinds)
      || row.accepted_input_kinds.length < 1 || row.accepted_input_kinds.length > 8
      || row.accepted_input_kinds.some(kind => typeof kind !== 'string' || !TASK_TYPE.test(kind))))
    || (row.output_kind !== undefined && (typeof row.output_kind !== 'string'
      || !TASK_TYPE.test(row.output_kind)))
    || (row.contract_version !== undefined && (typeof row.contract_version !== 'string'
      || !TASK_TYPE.test(row.contract_version)))
    || (row.runtime_abi !== undefined && row.runtime_abi !== 'node-sandbox.v2'
      && row.runtime_abi !== 'quickjs-wasm.v3')
    || row.status !== 'published'
    || typeof row.name !== 'string' || !row.name || row.name.length > 80
    || typeof row.description !== 'string' || row.description.length > 1000
    || typeof row.category !== 'string' || row.category.length > 40
    || typeof row.version !== 'string' || row.version.length > 40
    || typeof row.artifact_digest !== 'string' || !DIGEST.test(row.artifact_digest)
    || typeof row.reviewed_seller_runtime_digest !== 'string' || !DIGEST.test(row.reviewed_seller_runtime_digest)
    || typeof row.sale_price_yuan !== 'string' || !PRICE.test(row.sale_price_yuan)
    || row.currency !== 'CNY' || typeof row.available_to_purchase !== 'boolean'
    || (row.purchase_block_reason !== undefined && row.purchase_block_reason !== null
      && (typeof row.purchase_block_reason !== 'string' || row.purchase_block_reason.length > 300))
    || (row.archive_digest !== null && (typeof row.archive_digest !== 'string' || !DIGEST.test(row.archive_digest)))
    || (row.archive_size_bytes !== null && (typeof row.archive_size_bytes !== 'number'
      || !Number.isSafeInteger(row.archive_size_bytes) || row.archive_size_bytes < 1
      || row.archive_size_bytes > 16 * 1024 * 1024))) fail('order-product-invalid')
  return { id: row.id, publicationId: row.publication_id, ownerId: row.owner_id,
    taskType: row.task_type, name: row.name, description: row.description,
    ...(typeof row.capability_id === 'string' ? { capabilityId: row.capability_id } : {}),
    ...(Array.isArray(row.accepted_input_kinds)
      ? { acceptedInputKinds: row.accepted_input_kinds as string[] } : {}),
    ...(typeof row.output_kind === 'string' ? { outputKind: row.output_kind } : {}),
    ...(typeof row.contract_version === 'string' ? { contractVersion: row.contract_version } : {}),
    ...(typeof row.runtime_abi === 'string'
      ? { runtimeAbi: row.runtime_abi as 'node-sandbox.v2' | 'quickjs-wasm.v3' } : {}),
    category: row.category, version: row.version, artifactDigest: row.artifact_digest,
    reviewedSellerRuntimeDigest: row.reviewed_seller_runtime_digest,
    salePriceYuan: row.sale_price_yuan, currency: 'CNY', availableToPurchase: row.available_to_purchase,
    ...(row.purchase_block_reason === undefined ? {} : {
      purchaseBlockReason: row.purchase_block_reason as string | null }),
    archiveDigest: row.archive_digest, archiveSizeBytes: row.archive_size_bytes }
}

export async function listOrderAdapterProducts(input: { origin: string; fetch?: typeof fetch }): Promise<{ products: OrderAdapterProduct[] }> {
  const data = record(await request({ ...input, path: '/api/v8/order-adapter-products' }))
  if (!Array.isArray(data?.items) || data.items.length > 100) fail('order-product-invalid')
  return { products: data.items.map(product) }
}

/** Buyer-owned rows come from Shanghai, never a renderer cache or a local install marker. */
export async function listBuyerOrderAdapterEntitlements(input: { origin: string; token: string;
  workerId?: string | null; fetch?: typeof fetch }): Promise<{ items: OrderAdapterBuyerEntitlement[] }> {
  if (input.workerId != null && !ID.test(input.workerId)) fail('order-product-invalid')
  const path = '/api/v8/order-adapter-products/my-entitlements'
    + (input.workerId ? `?worker_id=${encodeURIComponent(input.workerId)}` : '')
  const row = record(await request({ ...input, path }))
  if (!Array.isArray(row?.items) || row.items.length > 100) fail('order-product-invalid')
  const items = row.items.map(value => {
    const entry = record(value)
    if (entry === null || typeof entry.product_id !== 'string' || !ID.test(entry.product_id)
      || typeof entry.entitlement_id !== 'string' || !ID.test(entry.entitlement_id)
      || typeof entry.product_name !== 'string' || entry.product_name.length > 80
      || !['pending_install', 'installed', 'refunded', 'unknown'].includes(String(entry.status))
      || typeof entry.device_installed !== 'boolean'
      || (entry.runtime_digest !== null && (typeof entry.runtime_digest !== 'string'
        || !/^sha256:[0-9a-f]{64}$/u.test(entry.runtime_digest)))
      || (entry.device_installed === true && entry.runtime_digest === null)
      || (entry.install_expires_at !== null && (typeof entry.install_expires_at !== 'string'
        || !Number.isFinite(Date.parse(entry.install_expires_at))))) fail('order-product-invalid')
    return { productId: entry.product_id as string, entitlementId: entry.entitlement_id as string,
      productName: entry.product_name as string,
      status: entry.status as OrderAdapterBuyerEntitlement['status'],
      deviceInstalled: entry.device_installed as boolean,
      runtimeDigest: entry.runtime_digest as string | null,
      installExpiresAt: entry.install_expires_at as string | null }
  })
  return { items }
}

async function getProduct(input: { origin: string; productId: string; fetch?: typeof fetch }): Promise<OrderAdapterProduct> {
  if (!ID.test(input.productId)) fail('order-product-invalid')
  const row = product(await request({ ...input, path: `/api/v8/order-adapter-products/${input.productId}` }))
  if (row.id !== input.productId) fail('order-product-invalid')
  return row
}

export async function purchaseOrderAdapterProduct(input: { origin: string; productId: string;
  token: string; idempotencyKey: string; requiredRuntimeAbi?: 'quickjs-wasm.v3';
  fetch?: typeof fetch }): Promise<OrderAdapterEntitlement> {
  if (!ID.test(input.productId) || !KEY.test(input.idempotencyKey)) fail('order-product-invalid')
  const current = await getProduct(input)
  if (input.requiredRuntimeAbi !== undefined && current.runtimeAbi !== input.requiredRuntimeAbi) {
    throw new CatalogFailure('order-purchase-rejected')
  }
  if (!current.availableToPurchase) throw new CatalogFailure('order-purchase-rejected')
  const row = record(await request({ ...input,
    path: `/api/v8/order-adapter-products/${input.productId}/purchase`, method: 'POST' }))
  if (row === null || typeof row.entitlement_id !== 'string' || !ID.test(row.entitlement_id)
    || row.product_id !== input.productId
    || !['pending_install', 'installed', 'refunded'].includes(String(row.status))
    || row.price_yuan !== current.salePriceYuan || row.currency !== 'CNY'
    || typeof row.already_owned !== 'boolean'
    || (row.install_expires_at !== null && (typeof row.install_expires_at !== 'string'
      || !Number.isFinite(Date.parse(row.install_expires_at))))) fail('order-product-invalid')
  return { entitlementId: row.entitlement_id, productId: input.productId,
    status: row.status as OrderAdapterEntitlement['status'],
    priceYuan: row.price_yuan as string, currency: 'CNY', alreadyOwned: row.already_owned,
    deviceInstalled: false, installExpiresAt: row.install_expires_at as string | null }
}

/**
 * Claim an author's own exact published source without a purchase or monetary hold.
 * @param input - Account token and the immutable publication matched to its current local source.
 * @returns Existing ownership as-is, or a new zero-price entitlement; no device proof is implied.
 */
export async function claimAuthorOrderAdapterEntitlement(input: {
  origin: string; productId: string; token: string; publicationId: string;
  taskType: string; artifactDigest: string; fetch?: typeof fetch;
}): Promise<Omit<OrderAdapterEntitlement, 'status'> & { status: OrderAdapterEntitlement['status'] | 'unknown' }> {
  const current = await getProduct(input)
  if (current.publicationId !== input.publicationId || current.taskType !== input.taskType
    || current.artifactDigest !== input.artifactDigest) throw new CatalogFailure('order-author-source-changed')
  const row = record(await request({ ...input,
    path: `/api/v8/order-adapter-products/${input.productId}/author-entitlement`, method: 'POST' }))
  if (row === null || typeof row.entitlement_id !== 'string' || !ID.test(row.entitlement_id)
    || row.product_id !== input.productId
    || !['pending_install', 'installed', 'refunded', 'unknown'].includes(String(row.status))
    || typeof row.price_yuan !== 'string' || !PRICE.test(row.price_yuan)
    || row.currency !== 'CNY' || typeof row.already_owned !== 'boolean'
    || (!row.already_owned && (Number(row.price_yuan) !== 0 || row.status !== 'pending_install'))
    || (row.install_expires_at !== null && (typeof row.install_expires_at !== 'string'
      || !Number.isFinite(Date.parse(row.install_expires_at))))) throw new CatalogFailure('order-author-entitlement-invalid')
  return { entitlementId: row.entitlement_id, productId: input.productId,
    status: row.status as OrderAdapterEntitlement['status'] | 'unknown', priceYuan: row.price_yuan,
    currency: 'CNY', alreadyOwned: row.already_owned, deviceInstalled: false,
    installExpiresAt: row.install_expires_at as string | null }
}

/** Explicitly release a pending CNY hold; the server rejects already-settled installations. */
export async function cancelPendingOrderAdapterPurchase(input: { origin: string; productId: string;
  token: string; fetch?: typeof fetch }): Promise<OrderAdapterEntitlement> {
  if (!ID.test(input.productId)) fail('order-product-invalid')
  const row = record(await request({ ...input,
    path: `/api/v8/order-adapter-products/${input.productId}/cancel-purchase`, method: 'POST' }))
  if (row === null || typeof row.entitlement_id !== 'string' || !ID.test(row.entitlement_id)
    || row.product_id !== input.productId || row.status !== 'refunded'
    || typeof row.price_yuan !== 'string' || !PRICE.test(row.price_yuan)
    || row.currency !== 'CNY' || row.device_installed !== false) fail('order-product-invalid')
  return { entitlementId: row.entitlement_id, productId: input.productId,
    status: 'refunded', priceYuan: row.price_yuan, currency: 'CNY', alreadyOwned: true,
    deviceInstalled: false, installExpiresAt: typeof row.install_expires_at === 'string'
      ? row.install_expires_at : null }
}

function base64url(value: unknown, bytes: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value) || value.length > 128) {
    fail('order-install-manifest-invalid')
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== value.replace(/=+$/u, '')) {
    fail('order-install-manifest-invalid')
  }
  return decoded
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) fail('order-install-manifest-invalid')
  return result
}

function signatureValid(payload: Record<string, unknown>, signature: unknown, keyBytes: Buffer): boolean {
  const message = canonical(payload)
  if (Buffer.byteLength(message) > 16 * 1024) fail('order-install-manifest-invalid')
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, keyBytes]), format: 'der', type: 'spki' })
  return verify(null, Buffer.from(message, 'utf8'), key, base64url(signature, 64))
}

/** Verify the platform-attested author key and signed source inventory, but keep deviceInstalled false. */
export interface VerifiedOrderAdapterSource {
  check: OrderAdapterInstallCheck
  /** Product version observed and cross-checked against the signed publisher manifest. */
  productVersion?: string
  taskType: string
  capabilityId: string
  acceptedInputKinds?: readonly string[]
  outputKind?: string
  contractVersion?: string
  inventoryAlgorithm: typeof LEGACY_INVENTORY_ALGORITHM | typeof SOURCE_INVENTORY_ALGORITHM
    | typeof COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM
  archiveBucket: string
  artifactDigest: string
  reviewedSellerRuntimeDigest: string
  /** Kept inside the Host. Presigned credentials must never cross the remote/UI boundary. */
  downloadUrl: string
  expiresAt: number
  files: ReadonlyArray<OrderSourceFile>
}

export async function readVerifiedOrderAdapterSource(input: { origin: string; productId: string;
  token: string; trustedPackageIssuerKeys: Record<string, string>; fetch?: typeof fetch }): Promise<VerifiedOrderAdapterSource> {
  if (!ID.test(input.productId)) fail('order-product-invalid')
  const current = await getProduct(input)
  if (current.archiveDigest === null || current.archiveSizeBytes === null) {
    throw new CatalogFailure('order-install-not-ready')
  }
  const row = record(await request({ ...input,
    path: `/api/v8/order-adapter-products/${input.productId}/install-manifest` }))
  const envelope = record(row?.publisher_manifest)
  const payload = record(envelope?.payload)
  const packageReceipt = record(row?.package_receipt)
  const packagePayload = record(packageReceipt?.payload)
  const details = record(packagePayload?.details)
  const files = payload?.files
  const sourceV5 = payload?.inventory_algorithm === SOURCE_INVENTORY_ALGORITHM
    || payload?.inventory_algorithm === COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM
  const dependencyMode = sourceV5 ? 'self-contained-no-install-v1' : 'pnpm-frozen-lockfile-v1'
  if (row === null || envelope === null || payload === null || packageReceipt === null
    || packagePayload === null || details === null
    || row.product_id !== current.id || typeof row.entitlement_id !== 'string' || !ID.test(row.entitlement_id)
    || row.publication_id !== current.publicationId || row.task_type !== current.taskType
    || row.version !== current.version || row.artifact_digest !== current.artifactDigest
    || row.reviewed_seller_runtime_digest !== current.reviewedSellerRuntimeDigest
    || row.archive_digest !== current.archiveDigest || row.archive_size_bytes !== current.archiveSizeBytes
    || typeof row.archive_version_id !== 'string' || !VERSION_ID.test(row.archive_version_id)
    || row.archive_format !== 'zip-source-v1' || row.install_dependency_mode !== dependencyMode
    || row.buyer_runtime_digest_required !== true || row.device_installed !== false
    || typeof row.expires_at !== 'number' || !Number.isSafeInteger(row.expires_at)
    || row.expires_at <= Date.now() / 1000 || row.expires_at > Date.now() / 1000 + 360
    || typeof row.download_url !== 'string' || row.download_url.length > 4096
    || typeof row.publisher_key_id !== 'string' || !KEY_ID.test(row.publisher_key_id)
    || typeof row.package_issuer_key_id !== 'string' || !KEY_ID.test(row.package_issuer_key_id)
    || envelope.key_id !== row.publisher_key_id || payload.publisher_key_id !== row.publisher_key_id
    || payload.schema !== 'qianshou.order-adapter-author-manifest.v2'
    || payload.publication_id !== current.publicationId
    || (payload.inventory_algorithm !== LEGACY_INVENTORY_ALGORITHM
      && payload.inventory_algorithm !== SOURCE_INVENTORY_ALGORITHM
      && payload.inventory_algorithm !== COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM)
    || payload.owner_id !== current.ownerId || payload.task_type !== current.taskType
    || typeof payload.capability_id !== 'string' || !TASK_TYPE.test(payload.capability_id)
    || (current.capabilityId !== undefined && payload.capability_id !== current.capabilityId)
    || payload.artifact_digest !== current.artifactDigest
    || payload.package_digest !== current.reviewedSellerRuntimeDigest
    || payload.version !== current.version || payload.platform_dispatchable_claim !== true
    || !Array.isArray(files)) fail('order-install-manifest-invalid')
  const sourceFiles: OrderSourceFile[] = files.map(value => {
    const file = record(value)
    if (file === null || typeof file.path !== 'string' || typeof file.size_bytes !== 'number'
      || typeof file.sha256 !== 'string') fail('order-install-manifest-invalid')
    return { path: file.path, sizeBytes: file.size_bytes, sha256: file.sha256 }
  })
  validateOrderSourceInventory(payload.inventory_algorithm, sourceFiles)
  let url: URL
  try { url = new URL(row.download_url) } catch { return fail('order-install-manifest-invalid') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash
    || url.searchParams.getAll('versionId').length !== 1
    || url.searchParams.get('versionId') !== row.archive_version_id) fail('order-install-manifest-invalid')
  const issuerKey = input.trustedPackageIssuerKeys[row.package_issuer_key_id as string]
  if (typeof issuerKey !== 'string' || issuerKey !== row.package_issuer_public_key) {
    throw new CatalogFailure('order-install-not-ready')
  }
  const now = Math.floor(Date.now() / 1000)
  if (packageReceipt.key_id !== row.package_issuer_key_id
    || packagePayload.schema !== 'task-adapter-publication-evidence.v1'
    || packagePayload.kind !== 'package' || packagePayload.publication_id !== current.publicationId
    || packagePayload.owner_id !== current.ownerId || packagePayload.task_type !== current.taskType
    || packagePayload.artifact_digest !== current.artifactDigest
    || packagePayload.package_digest !== current.reviewedSellerRuntimeDigest
    || packagePayload.result !== 'pass' || typeof packagePayload.issued_at !== 'number'
    || typeof packagePayload.expires_at !== 'number' || !Number.isSafeInteger(packagePayload.issued_at)
    || !Number.isSafeInteger(packagePayload.expires_at) || packagePayload.issued_at > now + 60
    || packagePayload.expires_at <= now || packagePayload.expires_at - packagePayload.issued_at > 90 * 86400
    || details.publisher_signature_verified !== true || details.immutable_package_verified !== true
    || details.dispatchable_package_verified !== true || details.publisher_owner_id !== current.ownerId
    || details.publisher_key_id !== row.publisher_key_id
    || details.archive_digest !== current.archiveDigest || details.archive_size_bytes !== current.archiveSizeBytes
    || details.archive_version_id !== row.archive_version_id
    || (!sourceV5 && details.archive_format !== 'zip-source-v1')
    || details.inventory_algorithm !== payload.inventory_algorithm
    || (!sourceV5 && details.install_dependency_mode !== 'pnpm-frozen-lockfile-v1')
    || details.archive_object_lock_verified !== true || typeof details.archive_bucket !== 'string'
    || typeof details.archive_object_key !== 'string'
    || details.immutable_package_ref !== `oss://${details.archive_bucket}/${details.archive_object_key}?versionId=${row.archive_version_id}`
    || (sourceV5
      ? details.author_manifest_sha256 !== `sha256:${createHash('sha256').update(canonical(envelope)).digest('hex')}`
      : canonical(details.author_manifest) !== canonical(envelope))) fail('order-install-manifest-invalid')
  const publicKey = base64url(row.publisher_public_key, 32)
  try {
    if (!signatureValid(packagePayload, packageReceipt.signature, base64url(issuerKey, 32))
      || !signatureValid(payload, envelope.signature, publicKey)) fail('order-install-manifest-invalid')
  } catch { fail('order-install-manifest-invalid') }
  const check: OrderAdapterInstallCheck = { productId: current.id, entitlementId: row.entitlement_id as string,
    publicationId: current.publicationId, archiveDigest: current.archiveDigest,
    archiveSizeBytes: current.archiveSizeBytes, archiveVersionId: row.archive_version_id as string,
    archiveFormat: 'zip-source-v1', signatureVerified: true, packageReceiptVerified: true,
    deviceInstalled: false,
    nextStep: 'archive-download-and-device-verification-required' }
  return { check, productVersion: current.version, taskType: current.taskType, capabilityId: payload.capability_id as string,
    ...(current.acceptedInputKinds === undefined ? {} : { acceptedInputKinds: current.acceptedInputKinds }),
    ...(current.outputKind === undefined ? {} : { outputKind: current.outputKind }),
    ...(current.contractVersion === undefined ? {} : { contractVersion: current.contractVersion }),
    inventoryAlgorithm: payload.inventory_algorithm as VerifiedOrderAdapterSource['inventoryAlgorithm'],
    archiveBucket: details.archive_bucket as string,
    artifactDigest: current.artifactDigest,
    reviewedSellerRuntimeDigest: current.reviewedSellerRuntimeDigest,
    downloadUrl: row.download_url as string, expiresAt: row.expires_at as number,
    files: sourceFiles }
}

/** Metadata-only check; the caller cannot obtain presigned download credentials. */
export async function checkOrderAdapterInstallManifest(input: { origin: string; productId: string;
  token: string; trustedPackageIssuerKeys: Record<string, string>; fetch?: typeof fetch }): Promise<OrderAdapterInstallCheck> {
  return (await readVerifiedOrderAdapterSource(input)).check
}
