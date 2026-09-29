import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { listMyPrivatePluginSubmissions, submitPrivatePluginDeclaration,
  type PrivatePluginDeclarationSubmitRequest } from '../src/private-plugin-submissions.ts'

const archive = Buffer.from('PK\u0003\u0004declaration-only-test-archive')
const packageSha256 = createHash('sha256').update(archive).digest('hex')
const unpackedTreeSha256 = 'a'.repeat(64)
const token = 'test-access-token-1234567890'
const submissionId = '12345678-1234-4234-8234-123456789abc'
const reviewId = '12345678-1234-4234-8234-123456789abd'
const submissions = {
  submissionId, accountId: '167', publisherId: 'qianshou.lab', title: 'Sample tool',
  summary: 'A data-only declaration', submittedAt: 1_800_000_000_000,
  packageSha256, packageBytes: archive.byteLength, unpackedTreeSha256,
  manifest: { format: 'qianshou.declaration.v1' },
}
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }))
})

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const instance = createServer(handler)
  servers.push(instance)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  if (address === null || typeof address === 'string') throw new Error('test server address unavailable')
  return `http://127.0.0.1:${address.port}/qianshou-market/`
}
function account() {
  let id = '167'
  return { snapshot: vi.fn(async () => ({ phase: 'authenticated', account: { id } })),
    ensureAccessToken: vi.fn(async () => token), switchTo: (next: string) => { id = next } }
}
function request(apiBaseUrl: string, owner = account()): PrivatePluginDeclarationSubmitRequest {
  return { apiBaseUrl, account: owner, publisherId: 'qianshou.lab', title: 'Sample tool',
    summary: 'A data-only declaration', archiveBytes: archive, approvedAccountId: '167',
    approvedPackageSha256: packageSha256 }
}
function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify(body))
}
async function read(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

it('submits one exact approved package from Host using Bearer without cookies', async () => {
  let calls = 0
  const origin = await server((incoming, outgoing) => {
    void (async () => {
      calls += 1
      expect(incoming.url).toBe('/qianshou-market/submissions')
      expect(incoming.method).toBe('POST')
      expect(incoming.headers.authorization).toBe(`Bearer ${token}`)
      expect(incoming.headers.cookie).toBeUndefined()
      const body = await read(incoming)
      expect(Object.keys(body).sort()).toEqual(['action', 'archiveBase64', 'publisherId', 'summary', 'title'])
      expect(body['action']).toBe('submit')
      expect(Buffer.from(body['archiveBase64'] as string, 'base64')).toEqual(archive)
      json(outgoing, { ok: true, submission: submissions })
    })().catch(error => { outgoing.writeHead(500).end(String(error)) })
  })
  const owner = account()
  const result = await submitPrivatePluginDeclaration(request(origin, owner))
  expect(result).toEqual({ state: 'submitted', receipt: {
    submissionId, accountId: '167', publisherId: 'qianshou.lab', title: 'Sample tool',
    summary: 'A data-only declaration', submittedAt: submissions.submittedAt,
    packageSha256, packageBytes: archive.byteLength, reviewStatus: 'pending' } })
  expect(owner.ensureAccessToken).toHaveBeenCalledOnce()
  expect(calls).toBe(1)
  expect(JSON.stringify(result)).not.toContain('archiveBase64')
  expect(JSON.stringify(result)).not.toContain(token)
})

it('rejects changed package and account before network submission', async () => {
  let calls = 0
  const origin = await server((_incoming, outgoing) => { calls += 1; outgoing.writeHead(500).end() })
  await expect(submitPrivatePluginDeclaration({ ...request(origin),
    approvedPackageSha256: 'b'.repeat(64) })).rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_INVALID')
  const owner = account()
  owner.switchTo('other')
  await expect(submitPrivatePluginDeclaration(request(origin, owner)))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_ACCOUNT_CHANGED')
  expect(calls).toBe(0)
})

it('never claims success for a wrong account or digest in the server receipt', async () => {
  for (const altered of [{ accountId: 'other' }, { packageSha256: 'b'.repeat(64) }]) {
    const origin = await server((_incoming, outgoing) => json(outgoing,
      { ok: true, submission: { ...submissions, ...altered } }))
    const result = await submitPrivatePluginDeclaration(request(origin))
    expect(result).toEqual({ state: 'unknown', accountId: '167', packageSha256,
      reconciliation: 'mine-required' })
  }
})

it('distinguishes a definitive publisher binding refusal from an uncertain POST', async () => {
  const origin = await server((_incoming, outgoing) => json(outgoing,
    { ok: false, code: 'PUBLISHER_NOT_BOUND' }, 403))
  expect(await submitPrivatePluginDeclaration(request(origin))).toEqual({
    state: 'refused', reason: 'publisher-not-bound',
  })
  const unauthorized = await server((_incoming, outgoing) => json(outgoing,
    { ok: false, code: 'LOGIN_REQUIRED' }, 401))
  expect(await submitPrivatePluginDeclaration(request(unauthorized))).toEqual({
    state: 'refused', reason: 'sign-in-required',
  })
})

it('reports a timed-out or interrupted POST as unknown and reconciles through mine', async () => {
  let posted = 0
  const stop = new AbortController()
  const origin = await server((incoming, outgoing) => {
    void (async () => {
      const body = await read(incoming)
      if (body['action'] === 'submit') {
        posted += 1
        stop.abort()
        return
      }
      json(outgoing, { ok: true, submissions: [{ ...submissions, review: { status: 'pending' } }] })
    })().catch(error => { outgoing.writeHead(500).end(String(error)) })
  })
  const owner = account()
  const result = await submitPrivatePluginDeclaration({ ...request(origin, owner), signal: stop.signal })
  expect(result).toEqual({ state: 'unknown', accountId: '167', packageSha256,
    reconciliation: 'mine-required' })
  const mine = await listMyPrivatePluginSubmissions({ apiBaseUrl: origin, account: owner })
  expect(mine.accountId).toBe('167')
  expect(mine.submissions).toHaveLength(1)
  expect(mine.submissions[0]?.submissionId).toBe(submissionId)
  expect(posted).toBe(1)
})

it('reads bounded account-owned pages without a stale or repeated cursor', async () => {
  const secondId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const bodies: Record<string, unknown>[] = []
  let repeat = false
  const origin = await server((incoming, outgoing) => {
    void (async () => {
      const body = await read(incoming)
      bodies.push(body)
      const second = body['cursor'] !== undefined
      json(outgoing, { ok: true, submissions: [{ ...submissions,
        submissionId: second ? secondId : submissionId, review: { status: 'pending' } }],
      nextCursor: second ? (repeat ? submissionId : null) : submissionId })
    })().catch(error => { outgoing.writeHead(500).end(String(error)) })
  })
  const request = { apiBaseUrl: origin, account: account() }
  const mine = await listMyPrivatePluginSubmissions(request)
  expect(mine.submissions.map(item => item.submissionId)).toEqual([submissionId, secondId])
  expect(bodies).toEqual([{ action: 'mine' }, { action: 'mine', cursor: submissionId }])
  repeat = true
  await expect(listMyPrivatePluginSubmissions(request))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
})

it('fails closed on a changed account, redirect and overlarge mine response', async () => {
  const owner = account()
  const origin = await server((incoming, outgoing) => {
    void (async () => {
      await read(incoming)
      owner.switchTo('other')
      json(outgoing, { ok: true, submissions: [{ ...submissions, review: { status: 'pending' } }] })
    })().catch(error => { outgoing.writeHead(500).end(String(error)) })
  })
  await expect(listMyPrivatePluginSubmissions({ apiBaseUrl: origin, account: owner }))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
  const redirected = await server((_incoming, outgoing) => {
    outgoing.writeHead(302, { location: '/elsewhere' }).end()
  })
  await expect(listMyPrivatePluginSubmissions({ apiBaseUrl: redirected, account: account() }))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
  const huge = await server((_incoming, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'application/json',
      'content-length': String(4 * 1024 * 1024 + 1) }).end('{}')
  })
  await expect(listMyPrivatePluginSubmissions({ apiBaseUrl: huge, account: account() }))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
})

it('projects only bounded review status for the active account', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const rejection = { submissionId, packageSha256, reviewId, operatorId: 'qianshou.ops',
    operatorAccountId: 'admin', reviewedAt: submissions.submittedAt + 1,
    note: 'Please revise the declaration' }
  const signature = sign(null,
    Buffer.from(`qianshou-plugin-rejection-v1\n${JSON.stringify(rejection)}`), privateKey).toString('base64')
  let altered: Record<string, unknown> = {}
  const origin = await server((_incoming, outgoing) => json(outgoing, { ok: true, submissions: [
    { ...submissions, review: { status: 'rejected', reviewId, operatorId: 'qianshou.ops',
      operatorAccountId: 'admin', reviewedAt: submissions.submittedAt + 1,
      note: 'Please revise the declaration', signature, ...altered } },
  ] }))
  const request = { apiBaseUrl: origin, account: account(),
    operatorKeys: { 'qianshou.ops': publicKey.export({ format: 'der', type: 'spki' }).toString('base64') } }
  const result = await listMyPrivatePluginSubmissions(request)
  expect(result.submissions).toEqual([{ submissionId, accountId: '167',
    publisherId: 'qianshou.lab', title: 'Sample tool', summary: 'A data-only declaration',
    submittedAt: submissions.submittedAt, packageSha256, packageBytes: archive.byteLength,
    reviewStatus: 'rejected', reviewId, reviewNote: 'Please revise the declaration' }])
  expect(JSON.stringify(result)).not.toContain('manifest')
  expect(JSON.stringify(result)).not.toContain('signature')
  altered = { note: 'Forged approval text' }
  await expect(listMyPrivatePluginSubmissions(request))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
  altered = { signature: sign(null, Buffer.from('other'), privateKey).toString('base64') }
  await expect(listMyPrivatePluginSubmissions(request))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
  altered = {}
  await expect(listMyPrivatePluginSubmissions({ ...request, operatorKeys: {} }))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
})

it('accepts a signed declaration review only for the exact account, package and manifest', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const manifest = { format: 'qianshou.declaration.v1', pluginId: 'owner.sample-tool',
    version: '1.0.0', releaseId: `draft.${'d'.repeat(64)}` }
  const submitted = { ...submissions, manifest }
  const reviewedFields = { format: 'qianshou.declaration-review.v1', submissionId,
    accountId: '167', publisherId: 'qianshou.lab', pluginId: manifest.pluginId,
    version: manifest.version, releaseId: manifest.releaseId, title: submitted.title,
    summary: submitted.summary, packageSha256, packageBytes: archive.byteLength,
    unpackedTreeSha256, manifestSha256: createHash('sha256')
      .update(JSON.stringify(manifest)).digest('hex'), reviewId, operatorId: 'qianshou.ops',
    operatorAccountId: 'admin', reviewedAt: submitted.submittedAt + 1,
    scope: 'declaration-only', installable: false }
  const signature = sign(null, Buffer.from(`qianshou-plugin-declaration-review-v1\n${JSON.stringify(reviewedFields)}`),
    privateKey).toString('base64')
  let altered: Record<string, unknown> = {}
  const origin = await server((_incoming, outgoing) => json(outgoing, { ok: true, submissions: [
    { ...submitted, review: { status: 'declaration-reviewed', ...reviewedFields,
      signature, ...altered } },
  ] }))
  const operatorKeys = { 'qianshou.ops': publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
  const request = { apiBaseUrl: origin, account: account(), operatorKeys }
  const result = await listMyPrivatePluginSubmissions(request)
  expect(result.submissions).toEqual([{ submissionId, accountId: '167',
    publisherId: 'qianshou.lab', title: submitted.title, summary: submitted.summary,
    submittedAt: submitted.submittedAt, packageSha256, packageBytes: archive.byteLength,
    reviewStatus: 'declaration-reviewed', reviewId }])
  expect(JSON.stringify(result)).not.toContain(signature)
  altered = { packageSha256: 'b'.repeat(64) }
  await expect(listMyPrivatePluginSubmissions(request))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
  altered = { signature: sign(null, Buffer.from('different review'), privateKey).toString('base64') }
  await expect(listMyPrivatePluginSubmissions(request))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
  altered = {}
  await expect(listMyPrivatePluginSubmissions({ ...request, operatorKeys: {} }))
    .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE')
})
