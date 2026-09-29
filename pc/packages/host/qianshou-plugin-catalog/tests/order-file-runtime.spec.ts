import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadInstalledVerifiedOrderAdapterSource } from '../src/order-buyer-install.ts'
import { FILE_ABI, FILE_BYTES_POLICY, parseGenericFileSchema } from '../src/generic-file-contract.ts'
import type { GenericOrderSource } from '../src/generic-order-source.ts'
import type { FileDeviceChallengeReceipt } from '../src/order-file-device-challenge.ts'
import { loadOwnedInstalledFileRuntime, saveFileDeviceInstallReceipt } from '../src/order-file-runtime.ts'
import { canonicalOrderJson } from '../src/order-json-canonical.ts'
import type { VerifiedOrderAdapterSource } from '../src/order-products-http.ts'
import type { OrderAdapterBuyerEntitlement } from '../src/types.ts'

// Archive reopening and installed-byte verification have existing actual-WASM tests; marker FS and signature verification remain real.
vi.mock('../src/order-buyer-install.ts', () => ({ loadInstalledVerifiedOrderAdapterSource: vi.fn() }))

const homes: string[] = []
const workerId = 'b3cb439c-4adf-4669-8f1f-037ce1f3ecbc'
const nonce = '302bcfe7-7ec0-4f4a-b702-bb2a65d39860'
const runtimeDigest = `sha256:${'e'.repeat(64)}`
const hex = (value: unknown): string => createHash('sha256').update(canonicalOrderJson(value)).digest('hex')
const publicRoot = (key: KeyObject): string => key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')

beforeEach(() => { vi.resetAllMocks() })
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'file-runtime-marker-'))
  homes.push(home)
  const runtimeRoot = join(home, 'private-runtime')
  const root = join(runtimeRoot, 'scripts/order_adapter')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const fileSchema = parseGenericFileSchema({ schema: FILE_ABI, verificationPolicy: FILE_BYTES_POLICY,
    inputs: [{ name: 'source', contentTypes: ['application/octet-stream'], maxBytes: 32 }],
    outputs: [{ name: 'result', filename: 'out.bin', contentType: 'application/octet-stream', maxBytes: 32, encoding: 'base64' }] })
  const source: GenericOrderSource = { root, digest: 'b'.repeat(64), version: '1.0.0',
    inventoryAlgorithm: 'qianshou.source-package.v1', entryPath: 'src/adapter.quickjs.js', files: [],
    declaration: { schema: 'qianshou.local-adapter-candidate.v3', taskType: 'marker_file_v1', capabilityId: 'file.marker.v1',
      inputKinds: ['inline'], outputKind: 'artifact_ref', contractVersion: 'v1', category: 'document',
      platformDispatchable: true, selfTests: [{ input: 'samples/input.json', expected: 'samples/expected.json' }] },
    taskDefinition: { schema: 'qianshou.reviewed-task-definition.v1', taskType: 'marker_file_v1', capabilityId: 'file.marker.v1',
      category: 'document', inputKinds: ['inline'], outputKind: 'artifact_ref', inputContract: 'inline-json-bounded.v1',
      resultStrategy: FILE_BYTES_POLICY, paramsSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      inputSchema: { type: 'string', minLength: 2, maxLength: 1024, contentMediaType: 'application/json' }, fileSchema } }
  const signed: VerifiedOrderAdapterSource = { taskType: source.declaration.taskType, capabilityId: source.declaration.capabilityId,
    acceptedInputKinds: ['inline'], outputKind: 'artifact_ref', contractVersion: 'v1', inventoryAlgorithm: source.inventoryAlgorithm,
    archiveBucket: 'source-test', artifactDigest: `sha256:${source.digest}`, reviewedSellerRuntimeDigest: `sha256:${'c'.repeat(64)}`,
    downloadUrl: 'https://archive.example/package.zip?credential=host-only-download', expiresAt: Math.floor(Date.now() / 1000) + 300,
    files: [], check: { productId: 'file-product', entitlementId: 'file-entitlement', publicationId: 'file-publication',
      archiveDigest: `sha256:${'a'.repeat(64)}`, archiveSizeBytes: 100, archiveVersionId: 'locked-archive-1',
      archiveFormat: 'zip-source-v1', signatureVerified: true, packageReceiptVerified: true, deviceInstalled: false,
      nextStep: 'archive-download-and-device-verification-required' } }
  const entitlement: OrderAdapterBuyerEntitlement = { productId: signed.check.productId, entitlementId: signed.check.entitlementId,
    productName: 'file fixture', status: 'installed', deviceInstalled: true, runtimeDigest, installExpiresAt: null }
  const key = generateKeyPairSync('ed25519'), ordinary = generateKeyPairSync('ed25519')
  const now = Math.floor(Date.now() / 1000)
  const payload = { schema: 'qianshou.order-adapter-file-challenge.v1', result: 'passed', product_id: signed.check.productId,
    entitlement_id: signed.check.entitlementId, buyer_id: 7, publication_id: signed.check.publicationId, device_id: workerId,
    archive_digest: signed.check.archiveDigest, archive_version_id: signed.check.archiveVersionId,
    artifact_digest: signed.artifactDigest, reviewed_seller_runtime_digest: signed.reviewedSellerRuntimeDigest,
    runtime_digest: runtimeDigest, challenge_nonce: nonce, challenge_input_sha256: `sha256:${'1'.repeat(64)}`,
    challenge_result_sha256: `sha256:${'2'.repeat(64)}`, issued_at: now, expires_at: now + 600,
    file_binding: { schema: FILE_ABI, purpose: 'qianshou:file-device-attestor', verification_policy: FILE_BYTES_POLICY,
      contract_sha256: `sha256:${'d'.repeat(64)}`, file_schema_sha256: hex(fileSchema), file_schema: fileSchema,
      attachment_manifest_sha256: `sha256:${'3'.repeat(64)}`, output_manifest_sha256: `sha256:${'4'.repeat(64)}`, file_bytes_verified: true } }
  const receipt = (value: unknown = payload, signer = key.privateKey, keyId = 'file-device-key'): FileDeviceChallengeReceipt => ({
    key_id: keyId, payload: value as Readonly<Record<string, unknown>>,
    signature: sign(null, Buffer.from(canonicalOrderJson(value)), signer).toString('base64url') })
  const input = { entitlement, signed, home, workerId, accountId: 7,
    fileAttestorKeys: { 'file-device-key': publicRoot(key.publicKey) }, nonFilePurposeKeys: [publicRoot(ordinary.publicKey)] }
  vi.mocked(loadInstalledVerifiedOrderAdapterSource).mockResolvedValue({ source, runtimeDigest })
  return { home, runtimeRoot, marker: join(runtimeRoot, 'file-device-install.json'), source, signed, entitlement, fileSchema,
    payload, receipt, ordinary, key, input }
}

it('writes and reopens a real private receipt marker containing no account token or download credential', async () => {
  const setup = await fixture()
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt())
  const text = await readFile(setup.marker, 'utf8')
  expect(JSON.parse(text)).toEqual({ schema: 'qianshou.file-device-install.v1', receipt: setup.receipt() })
  expect(text).not.toContain('host-only-download')
  expect(text).not.toContain('credential=')
  expect(text).not.toContain('https://')
  expect(text).not.toContain('lease_token')
  expect(text).not.toContain('authorization')
  if (process.platform !== 'win32') expect((await lstat(setup.marker)).mode & 0o777).toBe(0o600)
  expect((await readdir(setup.runtimeRoot)).filter(name => name.endsWith('.tmp'))).toEqual([])
  const loaded = await loadOwnedInstalledFileRuntime(setup.input)
  expect(loaded?.runtime).toMatchObject({ productId: setup.signed.check.productId, entitlementId: setup.signed.check.entitlementId,
    artifactDigest: setup.signed.artifactDigest, runtimeDigest, contractSha256: setup.payload.file_binding.contract_sha256,
    fileSchemaSha256: hex(setup.fileSchema), outputKind: 'artifact_ref' })
  expect(loadInstalledVerifiedOrderAdapterSource).toHaveBeenCalledWith(setup.signed, setup.home)
})

it.each(['pending_install', 'refunded', 'unknown'] as const)('requires a current server-installed entitlement rather than %s', async status => {
  const setup = await fixture()
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt())
  expect(await loadOwnedInstalledFileRuntime({ ...setup.input, entitlement: { ...setup.entitlement, status } })).toBeNull()
  expect(loadInstalledVerifiedOrderAdapterSource).not.toHaveBeenCalled()
})

it('does not advertise local proof when the current server marks the device uninstalled or its runtime absent', async () => {
  const setup = await fixture()
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt())
  for (const entitlement of [{ ...setup.entitlement, deviceInstalled: false }, { ...setup.entitlement, runtimeDigest: null }]) {
    expect(await loadOwnedInstalledFileRuntime({ ...setup.input, entitlement })).toBeNull()
  }
  expect(loadInstalledVerifiedOrderAdapterSource).not.toHaveBeenCalled()
})

it('permits an expired committed receipt only when the caller supplies a current installed server entitlement', async () => {
  const setup = await fixture()
  const now = Math.floor(Date.now() / 1000)
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt({ ...setup.payload, issued_at: now - 700, expires_at: now - 100 }))
  expect((await loadOwnedInstalledFileRuntime(setup.input))?.runtime.runtimeDigest).toBe(runtimeDigest)
  expect(await loadOwnedInstalledFileRuntime({ ...setup.input, entitlement: { ...setup.entitlement, deviceInstalled: false } })).toBeNull()
})

it.each([
  ['device_id', nonce], ['buyer_id', 8], ['archive_version_id', 'other-archive'],
  ['archive_digest', `sha256:${'f'.repeat(64)}`], ['publication_id', 'other-publication'],
  ['runtime_digest', `sha256:${'f'.repeat(64)}`], ['artifact_digest', `sha256:${'f'.repeat(64)}`],
  ['schema', 'qianshou.order-adapter-remote-challenge.v1'],
])('rejects a separately signed persisted receipt bound to different %s', async (field, value) => {
  const setup = await fixture()
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt({ ...setup.payload, [field]: value }))
  await expect(loadOwnedInstalledFileRuntime(setup.input)).rejects.toThrow()
})

it('rejects an ordinary-purpose key, a reused purpose key and a changed current file declaration', async () => {
  const setup = await fixture()
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt(setup.payload, setup.ordinary.privateKey))
  await expect(loadOwnedInstalledFileRuntime(setup.input)).rejects.toThrow()
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt())
  await expect(loadOwnedInstalledFileRuntime({ ...setup.input,
    nonFilePurposeKeys: [publicRoot(setup.key.publicKey)] })).rejects.toThrow()
  const changed = parseGenericFileSchema({ ...setup.fileSchema, inputs: [] })
  vi.mocked(loadInstalledVerifiedOrderAdapterSource).mockResolvedValue({ runtimeDigest,
    source: { ...setup.source, taskDefinition: { ...setup.source.taskDefinition!, fileSchema: changed } } })
  await expect(loadOwnedInstalledFileRuntime(setup.input)).rejects.toThrow()
})

it('rejects a signed author-purpose claim and a changed runtime reported by the fresh server', async () => {
  const setup = await fixture()
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt({ ...setup.payload,
    file_binding: { ...setup.payload.file_binding, purpose: 'qianshou:author-self-test' } }))
  await expect(loadOwnedInstalledFileRuntime(setup.input)).rejects.toThrow()
  expect(await loadOwnedInstalledFileRuntime({ ...setup.input,
    entitlement: { ...setup.entitlement, runtimeDigest: `sha256:${'f'.repeat(64)}` } })).toBeNull()
})

it('requires the same signed product entitlement and a configured independent non-file key', async () => {
  const setup = await fixture()
  for (const input of [{ ...setup.input, nonFilePurposeKeys: [] },
    { ...setup.input, entitlement: { ...setup.entitlement, entitlementId: 'other-entitlement' } },
    { ...setup.input, signed: { ...setup.signed, outputKind: 'inline_json' } }]) {
    expect(await loadOwnedInstalledFileRuntime(input)).toBeNull()
  }
  expect(loadInstalledVerifiedOrderAdapterSource).not.toHaveBeenCalled()
})

it('rejects credentials in marker fields, malformed UTF-8, oversized records, missing records and symbolic links', async () => {
  const setup = await fixture()
  await expect(loadOwnedInstalledFileRuntime(setup.input)).rejects.toThrow()
  for (const bytes of [Buffer.from(JSON.stringify({ schema: 'qianshou.file-device-install.v1', receipt: setup.receipt(), token: 'unsafe' })),
    Buffer.from([0xc3, 0x28]), Buffer.alloc(8193, 'x')]) {
    await writeFile(setup.marker, bytes)
    await expect(loadOwnedInstalledFileRuntime(setup.input)).rejects.toThrow()
  }
  if (process.platform !== 'win32') {
    const external = join(setup.home, 'outside.json')
    await writeFile(external, canonicalOrderJson({ schema: 'qianshou.file-device-install.v1', receipt: setup.receipt() }))
    await rm(setup.marker)
    await symlink(external, setup.marker)
    await expect(loadOwnedInstalledFileRuntime(setup.input)).rejects.toThrow()
    await rm(setup.marker)
  }
  // Atomic replacement keeps only the newest signed proof and removes its temporary file.
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt())
  await chmod(setup.marker, 0o600)
  expect((await readdir(setup.runtimeRoot)).filter(name => name.endsWith('.tmp'))).toEqual([])
})

it('refuses undeclared file parameters or a missing file declaration despite a committed signed marker', async () => {
  const setup = await fixture()
  await saveFileDeviceInstallReceipt(setup.source, setup.receipt())
  const withoutFileSchema = { ...setup.source.taskDefinition! }
  delete withoutFileSchema.fileSchema
  for (const taskDefinition of [withoutFileSchema,
    { ...setup.source.taskDefinition!, paramsSchema: { type: 'object', properties: { url: { type: 'string' } }, required: [] } }]) {
    vi.mocked(loadInstalledVerifiedOrderAdapterSource).mockResolvedValue({ source: { ...setup.source, taskDefinition }, runtimeDigest })
    expect(await loadOwnedInstalledFileRuntime(setup.input)).toBeNull()
  }
})

it('bounds marker writes and removes temporary files when the real filesystem rejects atomic replacement', async () => {
  const setup = await fixture()
  await expect(saveFileDeviceInstallReceipt(setup.source, setup.receipt({ ...setup.payload, padding: 'x'.repeat(8192) }))).rejects.toThrow()
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  await mkdir(setup.marker)
  await expect(saveFileDeviceInstallReceipt(setup.source, setup.receipt())).rejects.toThrow()
  expect((await readdir(join(setup.home, 'private-runtime'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect((await lstat(setup.marker)).isDirectory()).toBe(true)
})
