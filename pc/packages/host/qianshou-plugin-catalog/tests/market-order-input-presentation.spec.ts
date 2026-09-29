import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { skillAuthoringTemplate } from '../src/skill-authoring-template.ts'
import { readGenericOrderSource } from '../src/generic-order-source.ts'
import { canonicalOrderJson } from '../src/order-json-canonical.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'
import { inspectOrderProductSourceArchive } from '../src/order-product-source-archive.ts'
import { projectMarketOrderInputPresentation, readMarketOrderInputPresentation } from '../src/market-order-input-presentation.ts'
import type { VerifiedOrderAdapterSource } from '../src/order-products-http.ts'
import type { MarketOrderInputPresentationRequest } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'market-presentation-'))
  roots.push(root)
  for (const [name, content] of Object.entries(skillAuthoringTemplate.files)) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), content)
  }
  const adapter = join(root, 'scripts/order_adapter')
  const path = join(adapter, 'task-definition.json')
  const definition = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const input = definition.inputSchema as Record<string, unknown>
  delete input.contentSchema
  await writeFile(path, canonicalOrderJson(definition))
  await writeFile(join(adapter, 'samples/count-one.input.json'), canonicalOrderJson({ text: '你好🙂', format: 'plain' }))
  await writeFile(join(adapter, 'samples/count-two.input.json'), canonicalOrderJson({ text: '千手AI', format: 'plain' }))
  await writeFile(join(adapter, 'src/adapter.quickjs.js'), 'function run() { throw new Error("NO_SAMPLE_EXECUTION_ALLOWED") }')
  const loaded = await readGenericOrderSource(join(root, 'SKILL.md'))
  const archive = await buildCanonicalOrderArchive(adapter, `sha256:${loaded.digest}`, loaded.inventoryAlgorithm)
  const productId = '11111111-1111-4111-8111-111111111111'
  const publicationId = '22222222-2222-4222-8222-222222222222'
  const author = generateKeyPairSync('ed25519'); const issuer = generateKeyPairSync('ed25519')
  const publicKey = author.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const issuerKey = issuer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const packageDigest = `sha256:${'b'.repeat(64)}`
  const payload = { schema: 'qianshou.order-adapter-author-manifest.v2', publication_id: publicationId,
    owner_id: 11, publisher_key_id: 'author-test', task_type: loaded.declaration.taskType,
    capability_id: loaded.declaration.capabilityId, inventory_algorithm: loaded.inventoryAlgorithm,
    artifact_digest: archive.artifactDigest, package_digest: packageDigest, version: '1.0.0',
    platform_dispatchable_claim: true, files: archive.files }
  const envelope = { key_id: 'author-test', payload,
    signature: sign(null, Buffer.from(canonicalOrderJson(payload)), author.privateKey).toString('base64url') }
  const details = { publisher_signature_verified: true, immutable_package_verified: true,
    dispatchable_package_verified: true, publisher_owner_id: 11, publisher_key_id: 'author-test',
    archive_digest: archive.archiveDigest, archive_size_bytes: archive.sizeBytes, archive_version_id: 'version-1',
    inventory_algorithm: loaded.inventoryAlgorithm, archive_object_lock_verified: true,
    archive_bucket: 'test-bucket', archive_object_key: 'input.zip',
    immutable_package_ref: 'oss://test-bucket/input.zip?versionId=version-1',
    author_manifest_sha256: `sha256:${sha(canonicalOrderJson(envelope))}` }
  const receiptPayload = { schema: 'task-adapter-publication-evidence.v1', kind: 'package',
    publication_id: publicationId, owner_id: 11, task_type: loaded.declaration.taskType,
    artifact_digest: archive.artifactDigest, package_digest: packageDigest, result: 'pass',
    issued_at: Math.floor(Date.now() / 1000) - 10, expires_at: Math.floor(Date.now() / 1000) + 3600, details }
  const receipt = { key_id: 'issuer-test', payload: receiptPayload,
    signature: sign(null, Buffer.from(canonicalOrderJson(receiptPayload)), issuer.privateKey).toString('base64url') }
  const product = { id: productId, publication_id: publicationId, owner_id: 11,
    task_type: loaded.declaration.taskType, name: '旧文字技能', description: '只读展示', category: 'text',
    capability_id: loaded.declaration.capabilityId, accepted_input_kinds: ['inline'], output_kind: 'inline_json',
    contract_version: 'v1', version: '1.0.0', artifact_digest: archive.artifactDigest,
    reviewed_seller_runtime_digest: packageDigest, sale_price_yuan: '10.00', currency: 'CNY', status: 'published',
    available_to_purchase: true, archive_digest: archive.archiveDigest, archive_size_bytes: archive.sizeBytes, review_reasons: [] }
  const manifest = { product_id: productId, entitlement_id: '33333333-3333-4333-8333-333333333333', publication_id: publicationId,
    task_type: loaded.declaration.taskType, version: '1.0.0', artifact_digest: archive.artifactDigest,
    reviewed_seller_runtime_digest: packageDigest, archive_digest: archive.archiveDigest, archive_size_bytes: archive.sizeBytes,
    archive_version_id: 'version-1', archive_format: 'zip-source-v1', install_dependency_mode: 'self-contained-no-install-v1',
    download_url: 'https://archive.example/input.zip?versionId=version-1', expires_at: Math.floor(Date.now() / 1000) + 300,
    publisher_manifest: envelope, publisher_key_id: 'author-test', publisher_public_key: publicKey,
    buyer_runtime_digest_required: true, package_receipt: receipt, package_issuer_key_id: 'issuer-test',
    package_issuer_public_key: issuerKey, device_installed: false }
  const request: MarketOrderInputPresentationRequest = { productId, taskType: loaded.declaration.taskType,
    version: '1.0.0', artifactDigest: archive.artifactDigest }
  const calls: { url: URL; init?: RequestInit }[] = []
  const send: typeof fetch = async (target, init) => {
    const url = new URL(target instanceof Request ? target.url : target)
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    return url.hostname === 'archive.example' ? new Response(new Uint8Array(archive.bytes))
      : Response.json(url.pathname.endsWith('/install-manifest') ? manifest : product)
  }
  const read = { request, origin: 'https://central.example', token: 'owner-access-token',
    trustedPackageIssuerKeys: { 'issuer-test': issuerKey }, trustedArchiveHostname: 'archive.example', fetch: send }
  const source: VerifiedOrderAdapterSource = { productVersion: request.version, taskType: request.taskType,
    capabilityId: loaded.declaration.capabilityId, artifactDigest: request.artifactDigest,
    check: { productId, entitlementId: manifest.entitlement_id, publicationId, archiveDigest: archive.archiveDigest,
      archiveSizeBytes: archive.sizeBytes, archiveVersionId: 'version-1', archiveFormat: 'zip-source-v1',
      signatureVerified: true, packageReceiptVerified: true, deviceInstalled: false,
      nextStep: 'archive-download-and-device-verification-required' }, inventoryAlgorithm: loaded.inventoryAlgorithm,
    archiveBucket: 'test-bucket', reviewedSellerRuntimeDigest: packageDigest,
    downloadUrl: manifest.download_url, expiresAt: manifest.expires_at,
    files: archive.files.map(file => ({ path: file.path, sizeBytes: file.size_bytes, sha256: file.sha256 })) }
  return { request, read, calls, manifest, source, files: inspectOrderProductSourceArchive(archive.bytes, source).files }
}

it('verifies real signatures and immutable archive bytes then presents Chinese controls without executing the throwing adapter', async () => {
  const f = await fixture()
  const result = await readMarketOrderInputPresentation(f.read)
  expect(result).toMatchObject({ ...f.request, status: 'available', reason: null, fixedInputJson: '{"format":"plain"}' })
  expect(JSON.parse(result.contentSchemaJson!)).toMatchObject({ required: ['text'], properties: { text: { title: '输入内容' } } })
  expect(f.calls).toHaveLength(3)
  expect(f.calls.every(call => call.init?.method === 'GET')).toBe(true)
  expect(f.calls[2]!.init?.headers).toEqual({ accept: 'application/zip' })
  expect(JSON.stringify(result)).not.toContain('download_url')
})

it.each(['taskType', 'version', 'artifactDigest'] as const)('refuses changed %s before fetching archive bytes', async (key) => {
  const f = await fixture()
  const request = { ...f.request, [key]: key === 'artifactDigest' ? `sha256:${'a'.repeat(64)}` : 'other' }
  expect(await readMarketOrderInputPresentation({ ...f.read, request })).toMatchObject({ status: 'unavailable', reason: 'source-changed' })
  expect(f.calls).toHaveLength(2)
})

it('does not bypass missing source access or an altered publisher signature', async () => {
  const f = await fixture()
  expect(await readMarketOrderInputPresentation({ ...f.read, token: '' })).toMatchObject({ reason: 'source-access-required' })
  expect(f.calls).toHaveLength(0)
  f.manifest.publisher_manifest.signature = 'A'.repeat(86)
  expect(await readMarketOrderInputPresentation(f.read)).toMatchObject({ status: 'unavailable', reason: 'source-unavailable' })
  expect(f.calls).toHaveLength(2)
})

it('refuses a storage host mismatch without sending owner credentials to storage', async () => {
  const f = await fixture()
  expect(await readMarketOrderInputPresentation({ ...f.read, trustedArchiveHostname: 'other.example' }))
    .toMatchObject({ reason: 'source-unavailable' })
  expect(f.calls).toHaveLength(2)
})

it.each(['source-denied', 'changed-bytes', 'wrong-size'] as const)('refuses %s without providing inferred controls', async (kind) => {
  const f = await fixture()
  const send: typeof fetch = async (target, init) => {
    const url = new URL(target instanceof Request ? target.url : target)
    if (kind === 'source-denied' && url.pathname.endsWith('/install-manifest')) return new Response(null, { status: 403 })
    const response = await f.read.fetch(target, init)
    if (url.hostname !== 'archive.example') return response
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (kind === 'changed-bytes') bytes[0] = 0
    return new Response(bytes, { headers: kind === 'wrong-size' ? { 'content-length': String(bytes.length + 1) } : {} })
  }
  expect(await readMarketOrderInputPresentation({ ...f.read, fetch: send }))
    .toMatchObject({ status: 'unavailable', contentSchemaJson: null, fixedInputJson: null })
})

it('leaves explicit schemas and complex or inconsistent samples unavailable rather than guessing fields', async () => {
  const f = await fixture()
  for (const sample of [{ text: 'other', format: 'different' }, { text: { private: 'nested' } },
    { other: 'different' }, { 'text.label': 'not supported', format: 'plain' }]) {
    const files = new Map(f.files)
    files.set('samples/count-two.input.json', Buffer.from(JSON.stringify(sample)))
    expect(projectMarketOrderInputPresentation(f.request, f.source, files).status).toBe('unavailable')
  }
  const files = new Map(f.files)
  const task = JSON.parse(files.get('task-definition.json')!.toString()) as Record<string, unknown>
  ;(task.inputSchema as Record<string, unknown>).contentSchema = { type: 'object' }
  files.set('task-definition.json', Buffer.from(JSON.stringify(task)))
  expect(projectMarketOrderInputPresentation(f.request, f.source, files).reason).toBe('input-definition-not-legacy')
})
