import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { activateVerifiedFileOrderAdapter } from '../src/order-file-activation.ts'
import { loadInstalledVerifiedOrderAdapterSource } from '../src/order-buyer-install.ts'
import { runInstalledFileDeviceChallenge, verifyFileDeviceChallengePlan, verifyFileDeviceChallengeReceipt,
  type FileDeviceChallengeReceipt } from '../src/order-file-device-challenge.ts'
import { FILE_ABI, FILE_BYTES_POLICY, parseGenericFileSchema } from '../src/generic-file-contract.ts'
import type { GenericOrderSource } from '../src/generic-order-source.ts'
import { canonicalOrderJson } from '../src/order-json-canonical.ts'
import type { VerifiedOrderAdapterSource } from '../src/order-products-http.ts'

// Prior tests execute installed files in actual pinned WASM. This suite isolates that existing executor and its archive reader.
vi.mock('../src/order-buyer-install.ts', () => ({ loadInstalledVerifiedOrderAdapterSource: vi.fn() }))
vi.mock('../src/order-file-device-challenge.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/order-file-device-challenge.ts')>(), runInstalledFileDeviceChallenge: vi.fn(),
}))

const homes: string[] = []
const workerId = 'b3cb439c-4adf-4669-8f1f-037ce1f3ecbc'
const nonce = '302bcfe7-7ec0-4f4a-b702-bb2a65d39860'
const runtimeDigest = `sha256:${'e'.repeat(64)}`
const hex = (value: unknown): string => createHash('sha256').update(canonicalOrderJson(value)).digest('hex')
const publicRoot = (key: KeyObject): string => key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
beforeEach(() => { vi.resetAllMocks() })
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'file-activation-gate-'))
  homes.push(home)
  const runtimeRoot = join(home, 'private-runtime')
  const root = join(runtimeRoot, 'scripts/order_adapter')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const fileSchema = parseGenericFileSchema({ schema: FILE_ABI, verificationPolicy: FILE_BYTES_POLICY,
    inputs: [{ name: 'source', contentTypes: ['application/octet-stream'], maxBytes: 32 }],
    outputs: [{ name: 'result', filename: 'out.bin', contentType: 'application/octet-stream', maxBytes: 32, encoding: 'base64' }] })
  const source: GenericOrderSource = { root, digest: 'b'.repeat(64), version: '1.0.0',
    inventoryAlgorithm: 'qianshou.source-package.v1', entryPath: 'src/adapter.quickjs.js', files: [],
    declaration: { schema: 'qianshou.local-adapter-candidate.v3', taskType: 'activation_file_v1', capabilityId: 'file.activation.v1',
      inputKinds: ['inline'], outputKind: 'artifact_ref', contractVersion: 'v1', category: 'document',
      platformDispatchable: true, selfTests: [{ input: 'samples/input.json', expected: 'samples/expected.json' }] },
    taskDefinition: { schema: 'qianshou.reviewed-task-definition.v1', taskType: 'activation_file_v1', capabilityId: 'file.activation.v1',
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
  const key = generateKeyPairSync('ed25519'), ordinary = generateKeyPairSync('ed25519')
  const now = Math.floor(Date.now() / 1000)
  const pinned = { product_id: signed.check.productId, entitlement_id: signed.check.entitlementId, buyer_id: 7,
    publication_id: signed.check.publicationId, device_id: workerId, archive_digest: signed.check.archiveDigest,
    archive_version_id: signed.check.archiveVersionId, artifact_digest: signed.artifactDigest,
    reviewed_seller_runtime_digest: signed.reviewedSellerRuntimeDigest }
  const binding = { schema: FILE_ABI, purpose: 'qianshou:file-device-attestor', verification_policy: FILE_BYTES_POLICY,
    contract_sha256: `sha256:${'d'.repeat(64)}`, file_schema_sha256: hex(fileSchema), file_schema: fileSchema,
    attachment_manifest_sha256: `sha256:${'3'.repeat(64)}`, output_manifest_sha256: `sha256:${'4'.repeat(64)}`, file_bytes_verified: true }
  const envelope = (payload: Readonly<Record<string, unknown>>): FileDeviceChallengeReceipt => ({ key_id: 'file-device-key', payload,
    signature: sign(null, Buffer.from(canonicalOrderJson(payload)), key.privateKey).toString('base64url') })
  const signedPlan = envelope({ schema: 'qianshou.order-adapter-file-challenge-plan.v1', ...pinned,
    challenge_nonce: nonce, input_kind: 'inline', challenge_input_sha256: `sha256:${'1'.repeat(64)}`,
    input_ref: `/file/challenges/${nonce}/input`, issued_at: now, expires_at: now + 90, file_binding: binding })
  const receipt = envelope({ schema: 'qianshou.order-adapter-file-challenge.v1', result: 'passed', ...pinned,
    runtime_digest: runtimeDigest, challenge_nonce: nonce, challenge_input_sha256: `sha256:${'1'.repeat(64)}`,
    challenge_result_sha256: `sha256:${'2'.repeat(64)}`, issued_at: now, expires_at: now + 600, file_binding: binding })
  const challenge: Record<string, unknown> = { schema: 'qianshou.order-adapter-activation-challenge.v1', product_id: signed.check.productId,
    worker_id: workerId, attestor_key_id: 'file-device-key', attestor_public_key: publicRoot(key.publicKey),
    attestor_origin: 'https://file-attestor.example/file/', signed_plan: signedPlan }
  const confirmed: Record<string, unknown> = { product_id: signed.check.productId, device_id: workerId,
    runtime_digest: runtimeDigest, device_installed: true, status: 'installed' }
  const marker = join(runtimeRoot, 'file-device-install.json')
  const events: string[] = []
  const observe = vi.fn(async () => { events.push('WS acknowledged') })
  let current = true
  const assertCurrent = vi.fn(async () => { events.push('current checked'); if (!current) throw Error('account context changed') })
  vi.mocked(loadInstalledVerifiedOrderAdapterSource).mockImplementation(async () => {
    events.push('runtime reopened'); return { source, runtimeDigest }
  })
  vi.mocked(runInstalledFileDeviceChallenge).mockImplementation(async input => {
    // Dedicated plan and receipt signatures are verified with real Ed25519 despite the isolated executor port.
    verifyFileDeviceChallengePlan(input.signedPlan, input)
    const verifiedReceipt = verifyFileDeviceChallengeReceipt(receipt, { ...input, runtimeDigest })
    events.push('challenge executed')
    await input.observeNodeChallenge({ challengeNonce: nonce, inputDigest: String(receipt.payload.challenge_input_sha256),
      outputDigest: String(receipt.payload.challenge_result_sha256), runtimeDigest, artifactDigest: signed.artifactDigest })
    return { receipt: verifiedReceipt, runtimeDigest, challengeNonce: nonce,
      challengeInputSha256: String(receipt.payload.challenge_input_sha256), challengeResultSha256: String(receipt.payload.challenge_result_sha256) }
  })
  const send = vi.fn(async (address: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(address))
    expect(url.origin).toBe('https://shanghai.example')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    expect(init?.credentials).toBe('omit')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer authenticated-account-token')
    if (url.pathname.endsWith('/activation-challenge')) {
      expect(JSON.parse(String(init?.body))).toEqual({ worker_id: workerId })
      events.push('plan requested'); return Response.json(challenge)
    }
    expect(url.pathname).toBe(`/api/v8/order-adapter-products/${signed.check.productId}/install-receipt`)
    expect(JSON.parse(String(init?.body))).toEqual(receipt)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(observe).toHaveBeenCalledOnce()
    events.push('server committed'); return Response.json(confirmed)
  })
  const input = { source: signed, home, coreOrigin: 'https://shanghai.example/', token: 'authenticated-account-token',
    workerId, accountId: 7, trustedArchiveHostname: 'archive.example', trustedFileAttestorHostname: 'file-attestor.example',
    fileAttestorKeys: { 'file-device-key': publicRoot(key.publicKey) }, nonFilePurposeKeys: [publicRoot(ordinary.publicKey)],
    observeNodeChallenge: observe, assertCurrent, fetch: send as typeof fetch }
  return { source, signed, home, marker, key, ordinary, receipt, signedPlan, challenge, confirmed, send, observe,
    assertCurrent, events, input, setCurrent: (value: boolean) => { current = value } }
}

it('uses local enrolled keys, then persists a real signed marker only after exact server commit and runtime reopen', async () => {
  const setup = await fixture()
  expect(await activateVerifiedFileOrderAdapter(setup.input)).toEqual({ productId: setup.signed.check.productId,
    deviceId: workerId, runtimeDigest, deviceInstalled: true, dispatchEligible: true })
  expect(runInstalledFileDeviceChallenge).toHaveBeenCalledWith(expect.objectContaining({
    fileAttestorKeyId: 'file-device-key', fileAttestorPublicKey: publicRoot(setup.key.publicKey),
    ordinaryAttestorPublicKeys: [publicRoot(setup.ordinary.publicKey)], accountId: 7, nodeId: workerId,
  }))
  expect(setup.events.indexOf('WS acknowledged')).toBeLessThan(setup.events.indexOf('server committed'))
  expect(setup.events.lastIndexOf('runtime reopened')).toBeGreaterThan(setup.events.indexOf('server committed'))
  const text = await readFile(setup.marker, 'utf8')
  expect(JSON.parse(text)).toEqual({ schema: 'qianshou.file-device-install.v1', receipt: setup.receipt })
  expect(text).not.toContain(setup.input.token)
  expect(text).not.toContain('host-only-download')
  expect(text).not.toContain('https://')
})

it.each(['missing-local-root', 'server-replaced-root'])('refuses %s without executing or saving any proof', async mode => {
  const setup = await fixture()
  if (mode === 'missing-local-root') setup.challenge.attestor_key_id = 'unenrolled-server-key'
  else setup.challenge.attestor_public_key = publicRoot(setup.ordinary.publicKey)
  await expect(activateVerifiedFileOrderAdapter(setup.input)).rejects.toThrow()
  expect(runInstalledFileDeviceChallenge).not.toHaveBeenCalled()
  expect(setup.send).toHaveBeenCalledOnce()
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a local file root reused for the ordinary signing purpose through actual signature validation', async () => {
  const setup = await fixture()
  await expect(activateVerifiedFileOrderAdapter({ ...setup.input,
    nonFilePurposeKeys: [publicRoot(setup.key.publicKey)] })).rejects.toThrow()
  expect(setup.send).toHaveBeenCalledOnce()
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  ['product_id', 'other-product'], ['device_id', nonce], ['runtime_digest', `sha256:${'f'.repeat(64)}`],
  ['device_installed', false], ['status', 'pending_install'],
])('does not persist when server confirmation has wrong %s', async (field, value) => {
  const setup = await fixture()
  setup.confirmed[field] = value
  await expect(activateVerifiedFileOrderAdapter(setup.input)).rejects.toThrow()
  expect(setup.send).toHaveBeenCalledTimes(2)
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not persist or claim activation when Shanghai rejects the signed receipt', async () => {
  const setup = await fixture()
  const send = vi.fn(async (address: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(address)).pathname.endsWith('/install-receipt')) return new Response(null, { status: 409 })
    return setup.send(address, init)
  })
  await expect(activateVerifiedFileOrderAdapter({ ...setup.input, fetch: send as typeof fetch })).rejects.toThrow()
  expect(send).toHaveBeenCalledTimes(2)
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not send a receipt or save state when authenticated worker WS acknowledgement fails', async () => {
  const setup = await fixture()
  await expect(activateVerifiedFileOrderAdapter({ ...setup.input,
    observeNodeChallenge: async () => { throw Error('worker WS unavailable') } })).rejects.toThrow('worker WS unavailable')
  expect(setup.send).toHaveBeenCalledOnce()
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([1, 2, 3, 4, 5, 6])('does not persist when account/worker assertCurrent fails at checkpoint %i', async checkpoint => {
  const setup = await fixture()
  let calls = 0
  await expect(activateVerifiedFileOrderAdapter({ ...setup.input, assertCurrent: async () => {
    if (++calls === checkpoint) throw Error('context is no longer current')
  } })).rejects.toThrow('context is no longer current')
  const exists = await readFile(setup.marker).then(() => true, error => {
    expect(error).toMatchObject({ code: 'ENOENT' }); return false
  })
  expect(exists).toBe(false)
})

it('does not persist when installed bytes changed after server commit', async () => {
  const setup = await fixture()
  vi.mocked(loadInstalledVerifiedOrderAdapterSource).mockResolvedValueOnce({ source: setup.source, runtimeDigest })
    .mockResolvedValueOnce({ source: setup.source, runtimeDigest: `sha256:${'f'.repeat(64)}` })
  await expect(activateVerifiedFileOrderAdapter(setup.input)).rejects.toThrow()
  expect(setup.send).toHaveBeenCalledTimes(2)
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not persist if the account changes during the final asynchronous runtime reopen', async () => {
  const setup = await fixture()
  let loads = 0
  vi.mocked(loadInstalledVerifiedOrderAdapterSource).mockImplementation(async () => {
    if (++loads === 2) setup.setCurrent(false)
    return { source: setup.source, runtimeDigest }
  })
  await expect(activateVerifiedFileOrderAdapter(setup.input)).rejects.toThrow('account context changed')
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('restores a previous committed marker when the final context check fails after writing the new receipt', async () => {
  const setup = await fixture()
  const payload = { ...setup.receipt.payload, challenge_nonce: workerId }
  const receipt = { key_id: setup.receipt.key_id, payload,
    signature: sign(null, Buffer.from(canonicalOrderJson(payload)), setup.key.privateKey).toString('base64url') }
  const previous = canonicalOrderJson({ schema: 'qianshou.file-device-install.v1', receipt })
  await writeFile(setup.marker, previous, { mode: 0o600 })
  let calls = 0
  await expect(activateVerifiedFileOrderAdapter({ ...setup.input, assertCurrent: async () => {
    if (++calls === 6) throw Error('context changed after save')
  }, fetch: (async (address: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(address)).pathname.endsWith('/install-receipt')) return Response.json(setup.confirmed)
    return setup.send(address, init)
  }) as typeof fetch })).rejects.toThrow('context changed after save')
  expect(await readFile(setup.marker, 'utf8')).toBe(previous)
})

it('does not overwrite a different marker committed concurrently while handling a failed final context check', async () => {
  const setup = await fixture()
  const payload = { ...setup.receipt.payload, challenge_nonce: workerId }
  const receipt = { key_id: setup.receipt.key_id, payload,
    signature: sign(null, Buffer.from(canonicalOrderJson(payload)), setup.key.privateKey).toString('base64url') }
  const concurrent = canonicalOrderJson({ schema: 'qianshou.file-device-install.v1', receipt })
  let calls = 0
  await expect(activateVerifiedFileOrderAdapter({ ...setup.input, assertCurrent: async () => {
    if (++calls === 6) { await writeFile(setup.marker, concurrent, { mode: 0o600 }); throw Error('context changed concurrently') }
  } })).rejects.toThrow('context changed concurrently')
  expect(await readFile(setup.marker, 'utf8')).toBe(concurrent)
})

it('does not send file bytes to a file-attestor configured on the Shanghai control hostname', async () => {
  const setup = await fixture()
  setup.challenge.attestor_origin = 'https://shanghai.example/file/'
  await expect(activateVerifiedFileOrderAdapter({ ...setup.input,
    trustedFileAttestorHostname: 'shanghai.example' })).rejects.toThrow()
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not activate a file source that declares execution parameters outside the reviewed empty parameter set', async () => {
  const setup = await fixture()
  vi.mocked(loadInstalledVerifiedOrderAdapterSource).mockResolvedValue({ runtimeDigest,
    source: { ...setup.source, taskDefinition: { ...setup.source.taskDefinition!,
      paramsSchema: { type: 'object', properties: { api_key: { type: 'string' } }, required: [] } } } })
  await expect(activateVerifiedFileOrderAdapter(setup.input)).rejects.toThrow()
  await expect(readFile(setup.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})
