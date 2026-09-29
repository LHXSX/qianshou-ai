import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { FILE_ABI, FILE_BYTES_POLICY, parseGenericFileSchema } from '../src/generic-file-contract.ts'
import { readGenericOrderSource } from '../src/generic-order-source.ts'
import { canonicalOrderJson } from '../src/order-json-canonical.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'
import { runInstalledFileDeviceChallenge, verifyFileDeviceChallengePlan,
  verifyFileDeviceChallengeReceipt, fileDeviceAttestorUrl, type FileDeviceChallengeTrust,
  type InstalledFileDeviceChallengeInput } from '../src/order-file-device-challenge.ts'
import type { VerifiedOrderAdapterSource } from '../src/order-products-http.ts'

const schema = parseGenericFileSchema({ schema: FILE_ABI, verificationPolicy: FILE_BYTES_POLICY,
  inputs: [{ name: 'source', contentTypes: ['application/octet-stream'], maxBytes: 32 }],
  outputs: [{ name: 'result', filename: 'output.bin', contentType: 'application/octet-stream', maxBytes: 32, encoding: 'base64' }] })
const nonce = '302bcfe7-7ec0-4f4a-b702-bb2a65d39860'
const nodeId = 'b3cb439c-4adf-4669-8f1f-037ce1f3ecbc'
const bytes = Buffer.from([0, 255, 10, 3])
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown): string => `sha256:${sha(canonicalOrderJson(value))}`
const rawKey = (key: KeyObject): string => key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
const output = { schema: 'qianshou.quickjs-file-result.v1',
  files: [{ name: 'result', encoding: 'base64', content: bytes.toString('base64') }] }
const guestInput = { schema: 'qianshou.quickjs-file-input.v1', input: { text: 'independent-device-input' },
  attachments: [{ name: 'source', contentType: 'application/octet-stream', encoding: 'base64', content: bytes.toString('base64') }] }

function trustFixture(source?: VerifiedOrderAdapterSource) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const ordinary = generateKeyPairSync('ed25519')
  const verified: VerifiedOrderAdapterSource = source ?? {
    taskType: 'quickjs_char_count_v1', capabilityId: 'quickjs_char_count_v1',
    acceptedInputKinds: ['inline'], outputKind: 'artifact_ref', contractVersion: 'v1',
    inventoryAlgorithm: 'qianshou.source-package.v1',
    check: { productId: 'file-product', entitlementId: 'file-entitlement', publicationId: 'file-publication',
      archiveDigest: `sha256:${'a'.repeat(64)}`, archiveSizeBytes: 1,
      archiveVersionId: 'file-version-1', archiveFormat: 'zip-source-v1', signatureVerified: true,
      packageReceiptVerified: true, deviceInstalled: false, nextStep: 'archive-download-and-device-verification-required' },
    archiveBucket: 'test-bucket', artifactDigest: `sha256:${'b'.repeat(64)}`,
    reviewedSellerRuntimeDigest: `sha256:${'c'.repeat(64)}`,
    downloadUrl: 'https://archive.example/adapter.zip?versionId=file-version-1',
    expiresAt: Math.floor(Date.now() / 1000) + 300, files: [],
  }
  const trust: FileDeviceChallengeTrust = { source: verified, fileSchema: schema,
    fileAttestorKeyId: 'file-device-key', fileAttestorPublicKey: rawKey(publicKey),
    ordinaryAttestorPublicKeys: [rawKey(ordinary.publicKey)], nodeId, accountId: 7,
    contractSha256: `sha256:${'d'.repeat(64)}` }
  const fileBinding = { schema: FILE_ABI, purpose: 'qianshou:file-device-attestor',
    verification_policy: FILE_BYTES_POLICY, contract_sha256: trust.contractSha256,
    file_schema: schema, file_schema_sha256: sha(canonicalOrderJson(schema)), file_bytes_verified: true,
    attachment_manifest_sha256: digest([{ name: 'source', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: sha(bytes) }]),
    output_manifest_sha256: digest([{ name: 'result', filename: 'output.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: sha(bytes) }]) }
  const now = Math.floor(Date.now() / 1000)
  const pinned = { product_id: verified.check.productId, entitlement_id: verified.check.entitlementId,
    buyer_id: trust.accountId, publication_id: verified.check.publicationId, device_id: nodeId,
    archive_digest: verified.check.archiveDigest, archive_version_id: verified.check.archiveVersionId,
    artifact_digest: verified.artifactDigest, reviewed_seller_runtime_digest: verified.reviewedSellerRuntimeDigest }
  const payload = { schema: 'qianshou.order-adapter-file-challenge-plan.v1', ...pinned,
    challenge_nonce: nonce, input_kind: 'inline', challenge_input_sha256: digest(guestInput),
    input_ref: `/file/challenges/${nonce}/input`, issued_at: now, expires_at: now + 90, file_binding: fileBinding }
  const signed = (value: unknown, key = privateKey, keyId = trust.fileAttestorKeyId) => ({ key_id: keyId,
    payload: value, signature: sign(null, Buffer.from(canonicalOrderJson(value)), key).toString('base64url') })
  const receiptPayload = { schema: 'qianshou.order-adapter-file-challenge.v1', result: 'passed', ...pinned,
    runtime_digest: `sha256:${'e'.repeat(64)}`, challenge_nonce: nonce, challenge_input_sha256: digest(guestInput),
    challenge_result_sha256: digest(output), issued_at: now, expires_at: now + 600, file_binding: fileBinding }
  return { trust, payload, receiptPayload, signed, ordinary, privateKey }
}

async function installedFixture() {
  const home = await mkdtemp(join(tmpdir(), 'file-device-challenge-'))
  const root = join(home, 'author-skill')
  await cp(fileURLToPath(new URL('../examples/quickjs-char-count-skill/', import.meta.url)), root, { recursive: true })
  const sourceRoot = join(root, 'scripts/order_adapter')
  const definitionPath = join(sourceRoot, 'task-definition.json')
  const declarationPath = join(sourceRoot, 'local-adapter.json')
  const definition = JSON.parse(await readFile(definitionPath, 'utf8'))
  Object.assign(definition, { outputKind: 'artifact_ref', resultStrategy: FILE_BYTES_POLICY, fileSchema: schema })
  delete definition.outputSchema
  const declaration = JSON.parse(await readFile(declarationPath, 'utf8'))
  declaration.outputKind = 'artifact_ref'
  for (const sample of declaration.selfTests) {
    sample.attachments = { source: { path: 'samples/source.bin', contentType: 'application/octet-stream' } }
    await writeFile(join(sourceRoot, sample.expected), canonicalOrderJson(output))
  }
  await writeFile(definitionPath, canonicalOrderJson(definition))
  await writeFile(declarationPath, canonicalOrderJson(declaration))
  await writeFile(join(sourceRoot, 'samples/source.bin'), bytes)
  await writeFile(join(sourceRoot, 'src/adapter.quickjs.js'), `function run(input) {
    if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined') throw Error('host access');
    return {schema:'qianshou.quickjs-file-result.v1',files:[{name:'result',encoding:'base64',content:input.attachments[0].content}]};
  }`)
  const source = await readGenericOrderSource(join(root, 'SKILL.md'))
  const archive = await buildCanonicalOrderArchive(source.root, `sha256:${source.digest}`, 'qianshou.source-package.v1')
  const verified: VerifiedOrderAdapterSource = { ...trustFixture().trust.source,
    taskType: source.declaration.taskType, capabilityId: source.declaration.capabilityId,
    artifactDigest: archive.artifactDigest,
    check: { ...trustFixture().trust.source.check, archiveDigest: archive.archiveDigest, archiveSizeBytes: archive.sizeBytes },
    files: archive.files.map(file => ({ path: file.path, sizeBytes: file.size_bytes, sha256: file.sha256 })) }
  const setup = trustFixture(verified)
  const observed = vi.fn(async () => undefined)
  // External HTTPS and authenticated WS ports are isolated test ports. The guest runtime itself is actual pinned WASM.
  const send = vi.fn(async (address: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(address))
    expect(url.protocol).toBe('https:')
    expect(init?.redirect).toBe('error')
    expect(init?.credentials).toBe('omit')
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    if (url.hostname === 'archive.example') return new Response(Uint8Array.from(archive.bytes),
      { headers: { 'content-length': String(archive.sizeBytes) } })
    expect(url.hostname).toBe('file-attestor.example')
    if (init?.method === 'GET') {
      expect(url.pathname).toBe(`/file/challenges/${nonce}/input`)
      return Response.json({ schema: 'qianshou.order-adapter-remote-challenge-input.v1',
        challenge_nonce: nonce, input_kind: 'inline', input: guestInput, challenge_input_sha256: digest(guestInput) })
    }
    expect(url.pathname).toBe(`/file/challenges/${nonce}/result`)
    expect(observed).toHaveBeenCalledOnce()
    const posted = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(Object.keys(posted).sort()).toEqual(['challenge_output', 'runtime_digest', 'schema', 'signed_plan', 'worker_id'])
    expect(posted.challenge_output).toEqual(output)
    expect(posted.signed_plan).toEqual(setup.signed(setup.payload))
    expect(posted.worker_id).toBe(nodeId)
    expect(posted.schema).toBe('qianshou.order-adapter-remote-challenge-result.v1')
    return Response.json({ schema: 'qianshou.order-adapter-remote-challenge-result-response.v1', status: 'passed',
      receipt: setup.signed({ ...setup.receiptPayload, runtime_digest: posted.runtime_digest,
        challenge_result_sha256: digest(posted.challenge_output) }) })
  })
  const input: InstalledFileDeviceChallengeInput = { ...setup.trust, home,
    trustedArchiveHostname: 'archive.example', attestorOrigin: 'https://file-attestor.example/file/',
    attestorHostname: 'file-attestor.example', signedPlan: setup.signed(setup.payload),
    observeNodeChallenge: observed, fetch: send as typeof fetch }
  return { home, input, send, observed, ...setup }
}

it('runs a separately signed file challenge in actual pinned WASM before WS observation and verifies the result receipt', async () => {
  const fixture = await installedFixture()
  try {
    const result = await runInstalledFileDeviceChallenge(fixture.input)
    expect(result).toMatchObject({ challengeNonce: nonce, challengeInputSha256: digest(guestInput), challengeResultSha256: digest(output) })
    expect(result.receipt.payload.file_binding).toEqual(fixture.payload.file_binding)
    expect(result.receipt.payload.runtime_digest).toBe(result.runtimeDigest)
    expect(fixture.observed).toHaveBeenCalledWith({ challengeNonce: nonce, inputDigest: digest(guestInput),
      outputDigest: digest(output), runtimeDigest: result.runtimeDigest, artifactDigest: fixture.trust.source.artifactDigest })
    expect(fixture.send).toHaveBeenCalledTimes(3)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})

it.each([
  ['schema', 'qianshou.order-adapter-remote-challenge-plan.v1'], ['buyer_id', 8], ['device_id', nonce],
  ['archive_version_id', 'changed-version'], ['artifact_digest', `sha256:${'f'.repeat(64)}`],
  ['reviewed_seller_runtime_digest', `sha256:${'f'.repeat(64)}`], ['input_ref', `/challenges/${nonce}/input`],
  ['input_kind', 'file_ref'], ['expires_at', 1], ['issued_at', Math.floor(Date.now() / 1000) + 100],
])('rejects a newly signed plan with changed %s', (field, value) => {
  const fixture = trustFixture()
  expect(() => verifyFileDeviceChallengePlan(fixture.signed({ ...fixture.payload, [field]: value }), fixture.trust)).toThrow()
})

it.each([
  ['purpose', 'qianshou:order-adapter-attestor'], ['schema', 'qianshou.quickjs-files.v2'],
  ['verification_policy', 'author-file-policy.v1'], ['contract_sha256', `sha256:${'f'.repeat(64)}`],
  ['file_schema_sha256', `sha256:${sha(canonicalOrderJson(schema))}`], ['file_bytes_verified', false],
  ['attachment_manifest_sha256', 'invalid'], ['output_manifest_sha256', 'invalid'],
])('rejects a separately signed file binding with changed %s', (field, value) => {
  const fixture = trustFixture()
  expect(() => verifyFileDeviceChallengePlan(fixture.signed({ ...fixture.payload,
    file_binding: { ...fixture.payload.file_binding, [field]: value } }), fixture.trust)).toThrow()
})

it('rejects changed file declarations, author/self-test shortcuts, unknown fields, and normal-purpose signer reuse', () => {
  const fixture = trustFixture()
  expect(() => verifyFileDeviceChallengePlan(fixture.signed({ ...fixture.payload, author_verified: true }), fixture.trust)).toThrow()
  expect(() => verifyFileDeviceChallengePlan(fixture.signed({ ...fixture.payload,
    file_binding: { ...fixture.payload.file_binding, file_schema: { ...schema, inputs: [] } } }), fixture.trust)).toThrow()
  expect(() => verifyFileDeviceChallengePlan(fixture.signed(fixture.payload, fixture.ordinary.privateKey), fixture.trust)).toThrow()
  expect(() => verifyFileDeviceChallengePlan(fixture.signed(fixture.payload), { ...fixture.trust,
    ordinaryAttestorPublicKeys: [fixture.trust.fileAttestorPublicKey] })).toThrow()
  expect(() => verifyFileDeviceChallengePlan({ ...fixture.signed(fixture.payload), signature: 'A'.repeat(86) }, fixture.trust)).toThrow()
})

it.each([
  ['schema', 'qianshou.order-adapter-remote-challenge.v1'], ['result', 'self-tested'], ['buyer_id', 8],
  ['runtime_digest', `sha256:${'f'.repeat(64)}`], ['archive_digest', `sha256:${'f'.repeat(64)}`],
  ['challenge_nonce', 'not-a-nonce'], ['challenge_input_sha256', 'invalid'], ['challenge_result_sha256', 'invalid'],
])('rejects a newly signed device receipt with changed %s', (field, value) => {
  const fixture = trustFixture()
  expect(() => verifyFileDeviceChallengeReceipt(fixture.signed({ ...fixture.receiptPayload, [field]: value }), {
    ...fixture.trust, runtimeDigest: fixture.receiptPayload.runtime_digest,
  })).toThrow()
})

it('requires fresh receipt admission and permits durable signatures only with the explicit committed-installation mode', () => {
  const fixture = trustFixture()
  const now = Math.floor(Date.now() / 1000)
  const signed = fixture.signed({ ...fixture.receiptPayload, issued_at: now - 700, expires_at: now - 100 })
  const options = { ...fixture.trust, runtimeDigest: fixture.receiptPayload.runtime_digest }
  expect(() => verifyFileDeviceChallengeReceipt(signed, options)).toThrow()
  expect(verifyFileDeviceChallengeReceipt(signed, { ...options, requireFresh: false }).payload.file_binding)
    .toEqual(fixture.payload.file_binding)
  expect(() => verifyFileDeviceChallengeReceipt(signed, { ...options, requireFresh: false,
    contractSha256: `sha256:${'f'.repeat(64)}` })).toThrow()
})

it('sends no result when the authenticated WS observation is unavailable', async () => {
  const fixture = await installedFixture()
  try {
    await expect(runInstalledFileDeviceChallenge({ ...fixture.input,
      observeNodeChallenge: async () => { throw Error('WS disconnected') } })).rejects.toThrow('WS disconnected')
    expect(fixture.send).toHaveBeenCalledTimes(2)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})

it('rejects changed actual attachment bytes even when the unsigned HTTP wrapper claims the expected input digest', async () => {
  const fixture = await installedFixture()
  try {
    const send = vi.fn(async (address: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(address)).hostname === 'archive.example') return fixture.send(address, init)
      return Response.json({ schema: 'qianshou.order-adapter-remote-challenge-input.v1', challenge_nonce: nonce,
        input_kind: 'inline', challenge_input_sha256: digest(guestInput), input: { ...guestInput,
          attachments: [{ ...guestInput.attachments[0], content: Buffer.from('changed').toString('base64') }] } })
    })
    await expect(runInstalledFileDeviceChallenge({ ...fixture.input, fetch: send as typeof fetch })).rejects.toThrow()
    expect(fixture.observed).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(2)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})

it('refuses a successful HTTP result signed by a normal key after actual execution', async () => {
  const fixture = await installedFixture()
  try {
    const send = vi.fn(async (address: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') return fixture.send(address, init)
      const posted = JSON.parse(String(init.body)) as Record<string, unknown>
      return Response.json({ schema: 'qianshou.order-adapter-remote-challenge-result-response.v1', status: 'passed',
        receipt: fixture.signed({ ...fixture.receiptPayload, runtime_digest: posted.runtime_digest }, fixture.ordinary.privateKey) })
    })
    await expect(runInstalledFileDeviceChallenge({ ...fixture.input, fetch: send as typeof fetch })).rejects.toThrow()
    expect(fixture.observed).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(3)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})

it('refuses an untrusted HTTPS origin before installing or reading a challenge', async () => {
  const fixture = trustFixture()
  const send = vi.fn()
  await expect(runInstalledFileDeviceChallenge({ ...fixture.trust, home: '/tmp/file-device-unused',
    trustedArchiveHostname: 'archive.example', attestorOrigin: 'https://ordinary-attestor.example/file/',
    attestorHostname: 'file-attestor.example', signedPlan: fixture.signed(fixture.payload),
    observeNodeChallenge: vi.fn(), fetch: send })).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})

it.each(['attachment_manifest_sha256', 'output_manifest_sha256'])('rejects a plan whose signed %s differs from the actual independently supplied bytes', async field => {
  const fixture = await installedFixture()
  try {
    const signedPlan = fixture.signed({ ...fixture.payload,
      file_binding: { ...fixture.payload.file_binding, [field]: `sha256:${'f'.repeat(64)}` } })
    await expect(runInstalledFileDeviceChallenge({ ...fixture.input, signedPlan })).rejects.toThrow()
    expect(fixture.observed).not.toHaveBeenCalled()
    expect(fixture.send).toHaveBeenCalledTimes(2)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})

it('rejects a properly signed receipt whose output digest differs from the actual WASM output', async () => {
  const fixture = await installedFixture()
  try {
    const send = vi.fn(async (address: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') return fixture.send(address, init)
      const posted = JSON.parse(String(init.body)) as Record<string, unknown>
      return Response.json({ schema: 'qianshou.order-adapter-remote-challenge-result-response.v1', status: 'passed',
        receipt: fixture.signed({ ...fixture.receiptPayload, runtime_digest: posted.runtime_digest,
          challenge_result_sha256: digest({ changed: true }) }) })
    })
    await expect(runInstalledFileDeviceChallenge({ ...fixture.input, fetch: send as typeof fetch })).rejects.toThrow()
    expect(fixture.observed).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(3)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})

it.each([
  { schema: 'qianshou.quickjs-file-input.v1', input: guestInput.input, attachments: [] },
  { ...guestInput, url: 'https://author.example/input' },
  { ...guestInput, attachments: [{ ...guestInput.attachments[0], name: 'other' }] },
  { ...guestInput, attachments: [{ ...guestInput.attachments[0], encoding: 'url' }] },
  { ...guestInput, attachments: [{ ...guestInput.attachments[0], contentType: 'text/plain' }] },
  { ...guestInput, attachments: [{ ...guestInput.attachments[0], content: 'AB==' }] },
  { ...guestInput, attachments: [{ ...guestInput.attachments[0], content: Buffer.alloc(33).toString('base64') }] },
])('rejects an independently signed input containing undeclared attachment fields or bytes %j', async badInput => {
  const fixture = await installedFixture()
  try {
    const signedPlan = fixture.signed({ ...fixture.payload, challenge_input_sha256: digest(badInput) })
    const send = vi.fn(async (address: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(address)).hostname === 'archive.example') return fixture.send(address, init)
      return Response.json({ schema: 'qianshou.order-adapter-remote-challenge-input.v1', challenge_nonce: nonce,
        input_kind: 'inline', challenge_input_sha256: digest(badInput), input: badInput })
    })
    await expect(runInstalledFileDeviceChallenge({ ...fixture.input, signedPlan, fetch: send as typeof fetch })).rejects.toThrow()
    expect(fixture.observed).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(2)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})

it('bounds the complete HTTPS input wrapper and rejects malformed UTF-8 before running the guest', async () => {
  const fixture = await installedFixture()
  try {
    const rejected = [Buffer.from(JSON.stringify({ ...guestInput, ignored: 'x'.repeat(65 * 1024) })), Buffer.from([0xc3, 0x28])]
    for (const body of rejected) {
      const send = vi.fn(async (address: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(address)).hostname === 'archive.example') return fixture.send(address, init)
        return new Response(Uint8Array.from(body))
      })
      await expect(runInstalledFileDeviceChallenge({ ...fixture.input, fetch: send as typeof fetch })).rejects.toThrow()
      expect(fixture.observed).not.toHaveBeenCalled()
      // Subsequent execution reuses the verified installed archive and still fetches the current random challenge.
      expect(send.mock.calls.some(call => call[1]?.method === 'POST')).toBe(false)
    }
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})

it('refuses the ordinary inline source path before any install or network request', async () => {
  const fixture = trustFixture()
  const send = vi.fn()
  await expect(runInstalledFileDeviceChallenge({ ...fixture.trust,
    source: { ...fixture.trust.source, outputKind: 'inline_json' }, home: '/tmp/file-device-unused',
    trustedArchiveHostname: 'archive.example', attestorOrigin: 'https://file-attestor.example/file/',
    attestorHostname: 'file-attestor.example', signedPlan: fixture.signed(fixture.payload),
    observeNodeChallenge: vi.fn(), fetch: send })).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})

it.each([
  ['https://file-attestor.example/', `/file/challenges/${nonce}/input`],
  ['http://file-attestor.example/file/', `/file/challenges/${nonce}/input`],
  ['https://file-attestor.example:8443/file/', `/file/challenges/${nonce}/input`],
  ['https://user@file-attestor.example/file/', `/file/challenges/${nonce}/input`],
  ['https://file-attestor.example/file/?token=secret', `/file/challenges/${nonce}/input`],
  ['https://file-attestor.example/file/#fragment', `/file/challenges/${nonce}/input`],
  ['https://file-attestor.example/file/', `/challenges/${nonce}/input`],
  ['https://file-attestor.example/file/', `/file/challenges/${nonce}/input?url=https://author.example`],
  ['https://file-attestor.example/file/', '/file/health'],
])('rejects a file-service mount or nonce route outside the dedicated endpoint %s %s', (origin, path) => {
  expect(() => fileDeviceAttestorUrl(origin, 'file-attestor.example', path)).toThrow()
})

it('resolves the actual Shanghai file-attestor base without duplicating its file mount', () => {
  expect(fileDeviceAttestorUrl('https://file-attestor.example/file/', 'file-attestor.example',
    `/file/challenges/${nonce}/input`).href).toBe(`https://file-attestor.example/file/challenges/${nonce}/input`)
})

it('sends no result when the random challenge expires while awaiting the authenticated WS acknowledgement', async () => {
  const fixture = await installedFixture()
  try {
    const later = Date.now() + 120_000
    await expect(runInstalledFileDeviceChallenge({ ...fixture.input,
      observeNodeChallenge: async () => { vi.spyOn(Date, 'now').mockReturnValue(later) } })).rejects.toThrow()
    expect(fixture.send).toHaveBeenCalledTimes(2)
  } finally {
    vi.restoreAllMocks()
    await rm(fixture.home, { recursive: true, force: true })
  }
})
