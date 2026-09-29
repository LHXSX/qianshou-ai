import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { claimPrivateExecutionCandidate } from '../src/private-execution-access.ts'

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const submissionId = '12345678-1234-4234-8234-123456789abc'
const licenseId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const reviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const inputSchema = { type: 'object', properties: { text: { type: 'string' } },
  required: ['text'], additionalProperties: false }
const outputSchema = { type: 'object', properties: { result: { type: 'string' } },
  required: ['result'], additionalProperties: false }
const requirements = { platforms: ['darwin'], architectures: ['arm64'],
  maxInputBytes: 1024, maxOutputBytes: 1024, maxRunMs: 1000 }
const executor = { kind: 'qianshou.string-map.v1', program: { mappings: [
  { from: 'text', to: 'result', transform: 'trim' },
] } }
const manifest = { format: 'qianshou.reviewable-execution.v1', pluginId: 'owner.trim',
  version: '1.0.0', operations: [{ operationId: 'trim', capabilityId: 'text.trim',
    inputSchema, outputSchema, requirements, executor,
    implementationSha256: sha(JSON.stringify(executor)) }] }
const bytes = Buffer.from(JSON.stringify(manifest))
const packageSha256 = sha(bytes)
const releaseId = `execution.${packageSha256}`
const operations = manifest.operations.map(item => ({ operationId: item.operationId,
  capabilityId: item.capabilityId, executorKind: 'qianshou.string-map.v1',
  implementationSha256: item.implementationSha256,
  inputSchemaSha256: sha(JSON.stringify(item.inputSchema)),
  outputSchemaSha256: sha(JSON.stringify(item.outputSchema)),
  permissions: [], requirements: item.requirements }))

afterEach(() => { vi.unstubAllGlobals() })

function fixture() {
  const publisher = generateKeyPairSync('ed25519')
  const operator = generateKeyPairSync('ed25519')
  const document = { format: 'qianshou.execution-release-candidate.v1', submissionId,
    accountId: 'owner-1', publisherId: 'owner.studio', pluginId: manifest.pluginId,
    version: manifest.version, releaseId, title: 'Trim text', summary: 'Trim a field locally',
    packageSha256, packageBytes: bytes.length,
    unpackedTreeSha256: sha(JSON.stringify([['artifact.json', packageSha256]])),
    verificationScope: 'self-contained-declarative-program', operations,
    installable: false, saleable: false, dispatchable: false }
  const publisherProof = { id: 'owner.studio', accountId: 'owner-1',
    signature: sign(null, Buffer.from(`qianshou-execution-candidate-publisher-v1\n${JSON.stringify(document)}`),
      publisher.privateKey).toString('base64') }
  const approvalFields = { candidate: document, publisher: publisherProof, reviewId,
    operatorId: 'qianshou.ops', operatorAccountId: 'auditor', reviewedAt: Date.now() }
  const approval = { reviewId, operatorId: 'qianshou.ops', operatorAccountId: 'auditor',
    reviewedAt: approvalFields.reviewedAt,
    signature: sign(null, Buffer.from(`qianshou-execution-candidate-review-v1\n${JSON.stringify(approvalFields)}`),
      operator.privateKey).toString('base64') }
  const candidate = { ...document, publisher: publisherProof, approval }
  const download = { url: `/qianshou-market/execution-access?submission=${submissionId}&sha256=${packageSha256}`,
    token: 'a'.repeat(43), expiresAt: Date.now() + 5 * 60_000 }
  const response = { ok: true, releaseId, pluginId: manifest.pluginId,
    version: manifest.version, packageSha256, candidate,
    license: { format: 'qianshou.execution-self-license.v1', licenseId, submissionId,
      accountId: 'owner-1', releaseId, packageSha256, grantedAt: Date.now(),
      scope: 'self-use-review-candidate' },
    installable: false, saleable: false, dispatchable: false, download }
  let owner = 'owner-1'
  const account = { snapshot: async () => ({ phase: 'authenticated', account: { id: owner } }),
    ensureAccessToken: async () => 'account-token-1234567890', switchTo: (value: string) => { owner = value } }
  const request = { apiBaseUrl: 'https://market.example', account, publisherKeys: {
    'owner.studio': publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }, operatorKeys: {
    'qianshou.ops': operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }, submissionId, packageSha256 }
  return { response, account, request, download }
}

it('checks exact reviewed bytes and both signatures without exposing the download token', async () => {
  const { response, request, download } = fixture()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    calls.push(init.method ?? '')
    if (init.method === 'POST') {
      expect(url.toString()).toBe('https://market.example/qianshou-market/execution-access')
      expect(init.headers).toMatchObject({ Authorization: 'Bearer account-token-1234567890' })
      return new Response(JSON.stringify(response), { status: 200,
        headers: { 'content-type': 'application/json' } })
    }
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${download.token}` })
    return new Response(bytes, { status: 200,
      headers: { 'content-type': 'application/json', 'x-qianshou-package-sha256': packageSha256 } })
  }))
  const result = await claimPrivateExecutionCandidate(request)
  expect(calls).toEqual(['POST', 'GET'])
  expect(result).toMatchObject({ state: 'claimed', accountId: 'owner-1', releaseId,
    packageSha256, licenseId, installable: false, saleable: false, dispatchable: false })
  expect(JSON.stringify({ ...result, bytes: undefined })).not.toContain(download.token)
})

it('rejects altered review proof, wrong download digest, and an account switch', async () => {
  const { response, request, account } = fixture()
  let malformed = false
  let alteredBytes = false
  let switched = false
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
    if (init.method === 'POST') {
      if (switched) account.switchTo('owner-2')
      return new Response(JSON.stringify({ ...response,
        candidate: malformed ? { ...response.candidate, title: 'Forged title' } : response.candidate }),
      { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(alteredBytes ? Buffer.from('{}') : bytes, { status: 200,
      headers: { 'content-type': 'application/json', 'x-qianshou-package-sha256': packageSha256 } })
  }))
  malformed = true
  await expect(claimPrivateExecutionCandidate(request)).rejects.toThrow('QIANSHOU_EXECUTION_ACCESS_INVALID')
  malformed = false
  alteredBytes = true
  await expect(claimPrivateExecutionCandidate(request)).rejects.toThrow('QIANSHOU_EXECUTION_ACCESS_INVALID')
  alteredBytes = false
  switched = true
  await expect(claimPrivateExecutionCandidate(request)).rejects.toThrow('QIANSHOU_EXECUTION_ACCESS_INVALID')
})
