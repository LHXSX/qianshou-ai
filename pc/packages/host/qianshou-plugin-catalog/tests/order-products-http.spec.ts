import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { cancelPendingOrderAdapterPurchase, checkOrderAdapterInstallManifest, listOrderAdapterProducts,
  listBuyerOrderAdapterEntitlements, purchaseOrderAdapterProduct,
  claimAuthorOrderAdapterEntitlement, submitSellerOrderProduct,
  readVerifiedOrderAdapterSource } from '../src/order-products-http.ts'

const id = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
const publication = '3a491d7e-31b5-4d0b-aa43-76d27f3c9a7b'
const entitlement = '56bf7555-0a4c-42e7-9ec3-fcf4f6ad2d07'
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`
const product = { id, publication_id: publication, owner_id: 11, task_type: 'bar_chart_svg_v1',
  name: '柱状图视频', description: '受限内联 JSON 配方生成 GIF 和 MP4', category: 'video',
  version: '0.1.0', artifact_digest: digest('a'), reviewed_seller_runtime_digest: digest('b'),
  sale_price_yuan: '10.00', currency: 'CNY', status: 'published', available_to_purchase: true,
  archive_digest: digest('c'), archive_size_bytes: 4096, review_reasons: [] }
const files = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
  'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift']

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function response(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200 }) }

it.each([
  ['pending_install', '0.00', false], ['installed', '10.00', true],
  ['unknown', '10.00', true], ['refunded', '10.00', true],
] as const)('claims author ownership while retaining %s and the original price', async (status, price, alreadyOwned) => {
  const requests: string[] = []
  const send = vi.fn(async (url: URL) => {
    requests.push(url.pathname)
    return response(requests.length === 1 ? product : { entitlement_id: entitlement,
      product_id: id, status, price_yuan: price, currency: 'CNY', already_owned: alreadyOwned,
      install_expires_at: null })
  })
  const result = await claimAuthorOrderAdapterEntitlement({ origin: 'https://central.example', token: 'fixture-token',
    productId: id, publicationId: publication, taskType: product.task_type,
    artifactDigest: product.artifact_digest, fetch: send as unknown as typeof fetch })
  expect(result).toMatchObject({ entitlementId: entitlement, status, priceYuan: price, deviceInstalled: false })
  expect(requests).toEqual([`/api/v8/order-adapter-products/${id}`, `/api/v8/order-adapter-products/${id}/author-entitlement`])
})

it('refuses an author source mismatch before claiming, and refuses a newly charged author entitlement', async () => {
  const send = vi.fn(async () => response(product))
  await expect(claimAuthorOrderAdapterEntitlement({ origin: 'https://central.example', token: 'fixture-token',
    productId: id, publicationId: publication, taskType: 'different_task',
    artifactDigest: product.artifact_digest, fetch: send as typeof fetch })).rejects.toThrow('order-author-source-changed')
  expect(send).toHaveBeenCalledTimes(1)
  const charged = vi.fn(async () => response(charged.mock.calls.length === 1 ? product : {
    entitlement_id: entitlement, product_id: id, status: 'pending_install', price_yuan: '10.00',
    currency: 'CNY', already_owned: false, install_expires_at: null,
  }))
  await expect(claimAuthorOrderAdapterEntitlement({ origin: 'https://central.example', token: 'fixture-token',
    productId: id, publicationId: publication, taskType: product.task_type,
    artifactDigest: product.artifact_digest, fetch: charged as typeof fetch })).rejects.toThrow('order-author-entitlement-invalid')
})

it('reads only dedicated published CNY products and never treats them as local installs', async () => {
  const send = vi.fn(async () => response({ items: [product] }))
  const result = await listOrderAdapterProducts({ origin: 'https://shanghai.example', fetch: send as typeof fetch })
  expect(result.products[0]).toMatchObject({ id, salePriceYuan: '10.00', currency: 'CNY',
    availableToPurchase: true, archiveDigest: digest('c') })
  expect(send.mock.calls).toHaveLength(1)
  expect((send.mock.calls[0] as unknown as [URL])[0].href)
    .toBe('https://shanghai.example/api/v8/order-adapter-products')
})

it('accepts a second reviewed task type without changing the client and rejects malformed names', async () => {
  const another = { ...product, task_type: 'legal_term_scan_v1', name: '术语扫描', category: 'text' }
  const send = vi.fn(async () => response({ items: [another] }))
  await expect(listOrderAdapterProducts({ origin: 'https://shanghai.example', fetch: send as typeof fetch }))
    .resolves.toMatchObject({ products: [{ taskType: 'legal_term_scan_v1', name: '术语扫描' }] })
  const invalid = vi.fn(async () => response({ items: [{ ...another, task_type: '../evil' }] }))
  await expect(listOrderAdapterProducts({ origin: 'https://shanghai.example', fetch: invalid as typeof fetch }))
    .rejects.toThrow('order-product-invalid')
})

it('treats a missing product list route as a missing route, not an empty catalog', async () => {
  const notFound = vi.fn(async () => new Response(null, { status: 404 }))
  await expect(listOrderAdapterProducts({ origin: 'https://shanghai.example', fetch: notFound as typeof fetch }))
    .rejects.toThrow('order-product-not-found')
  const empty = vi.fn(async () => response({ items: [] }))
  await expect(listOrderAdapterProducts({ origin: 'https://shanghai.example', fetch: empty as typeof fetch }))
    .resolves.toEqual({ products: [] })
})

it('recovers only server-held buyer entitlements bound to the current worker', async () => {
  const workerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const send = vi.fn(async () => response({ items: [{ entitlement_id: entitlement,
    product_id: id, product_name: '柱状图视频', status: 'pending_install',
    device_installed: false, runtime_digest: null, install_expires_at: '2099-01-01T00:00:00Z' }] }))
  const result = await listBuyerOrderAdapterEntitlements({ origin: 'https://shanghai.example',
    token: 'account-jwt', workerId, fetch: send as unknown as typeof fetch })
  expect(result.items).toEqual([{ entitlementId: entitlement, productId: id,
    productName: '柱状图视频', status: 'pending_install', deviceInstalled: false, runtimeDigest: null,
    installExpiresAt: '2099-01-01T00:00:00Z' }])
  const [url, init] = send.mock.calls[0] as unknown as [URL, RequestInit]
  expect(url.href).toBe(`https://shanghai.example/api/v8/order-adapter-products/my-entitlements?worker_id=${workerId}`)
  expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error',
    headers: { authorization: 'Bearer account-jwt' } })
  const forged = vi.fn(async () => response({ items: [{ entitlement_id: entitlement,
    product_id: '../other-account', product_name: '伪造', status: 'installed',
    device_installed: true, install_expires_at: null }] }))
  await expect(listBuyerOrderAdapterEntitlements({ origin: 'https://shanghai.example',
    token: 'account-jwt', workerId, fetch: forged as typeof fetch }))
    .rejects.toThrow('order-product-invalid')
  const missingDigest = vi.fn(async () => response({ items: [{ entitlement_id: entitlement,
    product_id: id, product_name: '柱状图视频', status: 'installed',
    device_installed: true, runtime_digest: null, install_expires_at: null }] }))
  await expect(listBuyerOrderAdapterEntitlements({ origin: 'https://shanghai.example',
    token: 'account-jwt', workerId, fetch: missingDigest as typeof fetch }))
    .rejects.toThrow('order-product-invalid')
})

it('retains an unknown entitlement without invalidating other device records or declaring installation', async () => {
  const send = vi.fn(async () => response({ items: [{ entitlement_id: entitlement,
    product_id: id, product_name: '统计', status: 'unknown', device_installed: false,
    runtime_digest: null, install_expires_at: null }] }))
  await expect(listBuyerOrderAdapterEntitlements({ origin: 'https://central.example', token: 'fixture-token',
    fetch: send as typeof fetch })).resolves.toMatchObject({ items: [{ status: 'unknown', deviceInstalled: false }] })
})

it('posts only on explicit purchase, sends one idempotency key and reports entitlement without installation', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const send = vi.fn(async (url: URL, init: RequestInit) => {
    requests.push({ url: url.href, init })
    return response(requests.length === 1 ? product : {
      entitlement_id: entitlement, product_id: id, status: 'pending_install', price_yuan: '10.00',
      currency: 'CNY', already_owned: false, device_installed: false,
      install_expires_at: '2026-09-26T00:00:00Z',
    })
  })
  const result = await purchaseOrderAdapterProduct({ origin: 'https://shanghai.example', productId: id,
    token: 'account-jwt', idempotencyKey: 'purchase:stable-key-123', fetch: send as unknown as typeof fetch })
  expect(result).toEqual({ entitlementId: entitlement, productId: id, status: 'pending_install',
    priceYuan: '10.00', currency: 'CNY', alreadyOwned: false, deviceInstalled: false,
    installExpiresAt: '2026-09-26T00:00:00Z' })
  expect(requests.map(item => item.init.method)).toEqual(['GET', 'POST'])
  expect(requests[1]?.init).toMatchObject({ redirect: 'error', credentials: 'omit',
    headers: { authorization: 'Bearer account-jwt', 'Idempotency-Key': 'purchase:stable-key-123' } })
  expect(JSON.stringify(result)).not.toContain('account-jwt')
})

it('releases only a server-confirmed pending hold and does not invent an installed receipt', async () => {
  const send = vi.fn(async (_url: URL, _init: RequestInit) => response({ entitlement_id: entitlement,
    product_id: id, status: 'refunded', price_yuan: '10.00', currency: 'CNY',
    already_owned: true, device_installed: false, install_expires_at: null }))
  const result = await cancelPendingOrderAdapterPurchase({ origin: 'https://shanghai.example',
    productId: id, token: 'account-jwt', fetch: send as unknown as typeof fetch })
  expect(result).toMatchObject({ status: 'refunded', deviceInstalled: false, currency: 'CNY' })
  expect((send.mock.calls[0] as unknown as [URL, RequestInit])[0].pathname)
    .toBe(`/api/v8/order-adapter-products/${id}/cancel-purchase`)
  expect((send.mock.calls[0] as unknown as [URL, RequestInit])[1]).toMatchObject({ method: 'POST',
    redirect: 'error', credentials: 'omit', headers: { authorization: 'Bearer account-jwt' } })
  const unconfirmed = vi.fn(async () => response({ entitlement_id: entitlement, product_id: id,
    status: 'installed', price_yuan: '10.00', currency: 'CNY', device_installed: false }))
  await expect(cancelPendingOrderAdapterPurchase({ origin: 'https://shanghai.example', productId: id,
    token: 'account-jwt', fetch: unconfirmed as typeof fetch })).rejects.toThrow('order-product-invalid')
})

it('validates platform-attested author signature and keeps archive/device installation pending', async () => {
  const pair = generateKeyPairSync('ed25519')
  const issuer = generateKeyPairSync('ed25519')
  const key = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const issuerKey = issuer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const payload = { schema: 'qianshou.order-adapter-author-manifest.v2',
    publication_id: publication, owner_id: 11,
    publisher_key_id: 'author-a', task_type: 'bar_chart_svg_v1', capability_id: 'video.render',
    inventory_algorithm: 'qianshou.bar-chart-package.v4',
    artifact_digest: digest('a'), package_digest: digest('b'), version: '0.1.0',
    platform_dispatchable_claim: true,
    files: files.map(path => ({ path, size_bytes: 12, sha256: 'd'.repeat(64) })) }
  const envelope = { key_id: 'author-a', payload,
    signature: sign(null, Buffer.from(canonical(payload)), pair.privateKey).toString('base64url') }
  const packagePayload = { schema: 'task-adapter-publication-evidence.v1', kind: 'package',
    publication_id: publication, owner_id: 11, task_type: 'bar_chart_svg_v1',
    artifact_digest: digest('a'), package_digest: digest('b'), result: 'pass',
    issued_at: Math.floor(Date.now() / 1000) - 10, expires_at: Math.floor(Date.now() / 1000) + 3600,
    details: { publisher_signature_verified: true, immutable_package_verified: true,
      dispatchable_package_verified: true, publisher_owner_id: 11, publisher_key_id: 'author-a',
      archive_digest: digest('c'), archive_size_bytes: 4096, archive_version_id: 'version+1',
      archive_format: 'zip-source-v1', install_dependency_mode: 'pnpm-frozen-lockfile-v1',
      inventory_algorithm: 'qianshou.bar-chart-package.v4',
      archive_object_lock_verified: true, archive_bucket: 'test-bucket', archive_object_key: 'packages/a.zip',
      immutable_package_ref: 'oss://test-bucket/packages/a.zip?versionId=version+1',
      author_manifest: envelope } }
  const packageReceipt = { key_id: 'issuer-a', payload: packagePayload,
    signature: sign(null, Buffer.from(canonical(packagePayload)), issuer.privateKey).toString('base64url') }
  const manifest = { product_id: id, entitlement_id: entitlement, publication_id: publication,
    task_type: 'bar_chart_svg_v1', version: '0.1.0', artifact_digest: digest('a'),
    reviewed_seller_runtime_digest: digest('b'), archive_digest: digest('c'),
    archive_size_bytes: 4096, archive_version_id: 'version+1', archive_format: 'zip-source-v1',
    install_dependency_mode: 'pnpm-frozen-lockfile-v1',
    download_url: 'https://oss.example/adapter.zip?versionId=version%2B1&signature=secret',
    expires_at: Math.floor(Date.now() / 1000) + 300, publisher_manifest: envelope,
    publisher_key_id: 'author-a', publisher_public_key: key, buyer_runtime_digest_required: true,
    package_receipt: packageReceipt, package_issuer_key_id: 'issuer-a', package_issuer_public_key: issuerKey,
    device_installed: false }
  const send = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest') ? manifest : product))
  const result = await checkOrderAdapterInstallManifest({ origin: 'https://shanghai.example',
    productId: id, token: 'account-jwt', trustedPackageIssuerKeys: { 'issuer-a': issuerKey },
    fetch: send as unknown as typeof fetch })
  expect(result).toMatchObject({ productId: id, entitlementId: entitlement, signatureVerified: true,
    packageReceiptVerified: true, deviceInstalled: false,
    nextStep: 'archive-download-and-device-verification-required' })
  expect(JSON.stringify(result)).not.toContain('signature=secret')
  const oldAuthorPayload = { ...payload, schema: 'qianshou.order-adapter-author-manifest.v1' }
  const oldAuthorEnvelope = { ...envelope, payload: oldAuthorPayload,
    signature: sign(null, Buffer.from(canonical(oldAuthorPayload)), pair.privateKey).toString('base64url') }
  const oldAuthor = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest')
    ? { ...manifest, publisher_manifest: oldAuthorEnvelope } : product))
  await expect(checkOrderAdapterInstallManifest({ origin: 'https://shanghai.example',
    productId: id, token: 'account-jwt', trustedPackageIssuerKeys: { 'issuer-a': issuerKey },
    fetch: oldAuthor as unknown as typeof fetch })).rejects.toThrow('order-install-manifest-invalid')
  const legacyPayload = { ...packagePayload, details: {
    ...packagePayload.details, inventory_algorithm: 'qianshou.bar-chart-package.v2' } }
  const legacyReceipt = { key_id: 'issuer-a', payload: legacyPayload,
    signature: sign(null, Buffer.from(canonical(legacyPayload)), issuer.privateKey).toString('base64url') }
  const legacy = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest')
    ? { ...manifest, package_receipt: legacyReceipt } : product))
  await expect(checkOrderAdapterInstallManifest({ origin: 'https://shanghai.example',
    productId: id, token: 'account-jwt', trustedPackageIssuerKeys: { 'issuer-a': issuerKey },
    fetch: legacy as unknown as typeof fetch })).rejects.toThrow('order-install-manifest-invalid')
  const forged = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest')
    ? { ...manifest, publisher_manifest: { ...envelope, signature: 'A'.repeat(86) } } : product))
  await expect(checkOrderAdapterInstallManifest({ origin: 'https://shanghai.example',
    productId: id, token: 'account-jwt', trustedPackageIssuerKeys: { 'issuer-a': issuerKey },
    fetch: forged as unknown as typeof fetch }))
    .rejects.toThrow('order-install-manifest-invalid')
  const ambiguousVersion = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest')
    ? { ...manifest, download_url: manifest.download_url + '&versionId=other' } : product))
  await expect(checkOrderAdapterInstallManifest({ origin: 'https://shanghai.example',
    productId: id, token: 'account-jwt', trustedPackageIssuerKeys: { 'issuer-a': issuerKey },
    fetch: ambiguousVersion as unknown as typeof fetch }))
    .rejects.toThrow('order-install-manifest-invalid')
  await expect(checkOrderAdapterInstallManifest({ origin: 'https://shanghai.example',
    productId: id, token: 'account-jwt', trustedPackageIssuerKeys: {},
    fetch: send as unknown as typeof fetch })).rejects.toThrow('order-install-not-ready')
})

it('accepts a separately signed generic source inventory and rejects an unbound receipt', async () => {
  const author = generateKeyPairSync('ed25519')
  const issuer = generateKeyPairSync('ed25519')
  const authorKey = author.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const issuerKey = issuer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const current = { ...product, task_type: 'legal_term_scan_v1', category: 'text',
    capability_id: 'text.scan', accepted_input_kinds: ['inline'],
    output_kind: 'inline_json', contract_version: 'v1' }
  const paths = ['local-adapter.json', 'package.json', 'pnpm-lock.yaml',
    'src/adapter.mjs', 'src/terms.json', 'task-definition.json']
  const payload = { schema: 'qianshou.order-adapter-author-manifest.v2',
    publication_id: publication, owner_id: 11, publisher_key_id: 'author-generic',
    task_type: current.task_type, capability_id: 'text.scan',
    inventory_algorithm: 'qianshou.source-package.v1', artifact_digest: digest('a'),
    package_digest: digest('b'), version: '0.1.0', platform_dispatchable_claim: true,
    files: paths.map(path => ({ path, size_bytes: 12, sha256: 'd'.repeat(64) })) }
  const envelope = { key_id: 'author-generic', payload,
    signature: sign(null, Buffer.from(canonical(payload)), author.privateKey).toString('base64url') }
  const details = { publisher_signature_verified: true, immutable_package_verified: true,
    dispatchable_package_verified: true, publisher_owner_id: 11, publisher_key_id: 'author-generic',
    archive_digest: digest('c'), archive_size_bytes: 4096, archive_version_id: 'version-2',
    inventory_algorithm: 'qianshou.source-package.v1', archive_object_lock_verified: true,
    archive_bucket: 'test-bucket', archive_object_key: 'packages/generic.zip',
    immutable_package_ref: 'oss://test-bucket/packages/generic.zip?versionId=version-2',
    author_manifest_sha256: `sha256:${createHash('sha256').update(canonical(envelope)).digest('hex')}` }
  const packagePayload = { schema: 'task-adapter-publication-evidence.v1', kind: 'package',
    publication_id: publication, owner_id: 11, task_type: current.task_type,
    artifact_digest: digest('a'), package_digest: digest('b'), result: 'pass',
    issued_at: Math.floor(Date.now() / 1000) - 10, expires_at: Math.floor(Date.now() / 1000) + 3600,
    details }
  const receipt = { key_id: 'issuer-a', payload: packagePayload,
    signature: sign(null, Buffer.from(canonical(packagePayload)), issuer.privateKey).toString('base64url') }
  const manifest = { product_id: id, entitlement_id: entitlement, publication_id: publication,
    task_type: current.task_type, version: '0.1.0', artifact_digest: digest('a'),
    reviewed_seller_runtime_digest: digest('b'), archive_digest: digest('c'),
    archive_size_bytes: 4096, archive_version_id: 'version-2', archive_format: 'zip-source-v1',
    install_dependency_mode: 'self-contained-no-install-v1',
    download_url: 'https://oss.example/generic.zip?versionId=version-2',
    expires_at: Math.floor(Date.now() / 1000) + 300, publisher_manifest: envelope,
    publisher_key_id: 'author-generic', publisher_public_key: authorKey,
    buyer_runtime_digest_required: true, package_receipt: receipt,
    package_issuer_key_id: 'issuer-a', package_issuer_public_key: issuerKey,
    device_installed: false }
  const send = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest') ? manifest : current))
  const input = { origin: 'https://shanghai.example', productId: id, token: 'account-jwt',
    trustedPackageIssuerKeys: { 'issuer-a': issuerKey } }
  await expect(checkOrderAdapterInstallManifest({ ...input, fetch: send as unknown as typeof fetch }))
    .resolves.toMatchObject({ signatureVerified: true, packageReceiptVerified: true,
      deviceInstalled: false })
  await expect(readVerifiedOrderAdapterSource({ ...input, fetch: send as unknown as typeof fetch }))
    .resolves.toMatchObject({ taskType: 'legal_term_scan_v1', capabilityId: 'text.scan',
      acceptedInputKinds: ['inline'], outputKind: 'inline_json', contractVersion: 'v1' })
  const mismatchedCapability = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest')
    ? manifest : { ...current, capability_id: 'text.other' }))
  await expect(readVerifiedOrderAdapterSource({ ...input,
    fetch: mismatchedCapability as unknown as typeof fetch }))
    .rejects.toThrow('order-install-manifest-invalid')
  const changedDetails = { ...details, inventory_algorithm: 'qianshou.bar-chart-package.v4' }
  const changedPayload = { ...packagePayload, details: changedDetails }
  const changedReceipt = { ...receipt, payload: changedPayload,
    signature: sign(null, Buffer.from(canonical(changedPayload)), issuer.privateKey).toString('base64url') }
  const mismatched = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest')
    ? { ...manifest, package_receipt: changedReceipt } : current))
  await expect(checkOrderAdapterInstallManifest({ ...input, fetch: mismatched as unknown as typeof fetch }))
    .rejects.toThrow('order-install-manifest-invalid')
  const forgedAuthorHash = { ...details, author_manifest_sha256: digest('e') }
  const forgedPayload = { ...packagePayload, details: forgedAuthorHash }
  const forgedReceipt = { ...receipt, payload: forgedPayload,
    signature: sign(null, Buffer.from(canonical(forgedPayload)), issuer.privateKey).toString('base64url') }
  const forgedAuthor = vi.fn(async (url: URL) => response(url.pathname.endsWith('/install-manifest')
    ? { ...manifest, package_receipt: forgedReceipt } : current))
  await expect(checkOrderAdapterInstallManifest({ ...input, fetch: forgedAuthor as unknown as typeof fetch }))
    .rejects.toThrow('order-install-manifest-invalid')
})


it('submits an explicit canonical free sale price, but never infers it from missing input', async () => {
  const send = vi.fn(async () => response({ id, publication_id: publication, status: 'review',
    sale_price_yuan: '0.00', currency: 'CNY', can_approve: false, review_reasons: [] }))
  await expect(submitSellerOrderProduct({ origin: 'https://central.example', token: 'fixture-token',
    publicationId: publication, salePriceYuan: '0.00', fetch: send }))
    .resolves.toMatchObject({ salePriceYuan: '0.00', status: 'review' })
  expect(JSON.parse((send.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string))
    .toEqual({ publication_id: publication, sale_price_yuan: '0.00', currency: 'CNY' })
  for (const price of ['', ' ', '0', '0.0', '-0.01', '1.001', '100000.01']) {
    await expect(submitSellerOrderProduct({ origin: 'https://central.example', token: 'fixture-token',
      publicationId: publication, salePriceYuan: price, fetch: send })).rejects.toThrow('order-product-invalid')
  }
  expect(send).toHaveBeenCalledOnce()
})
