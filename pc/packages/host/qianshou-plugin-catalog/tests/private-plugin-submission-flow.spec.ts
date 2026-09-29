/** Host Remote bridge: safe preview, exact confirmation and one account-bound HTTP submission. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import QianshouPluginCatalog, { type Config } from '../src/index.ts'

const archive = Buffer.from('PK\u0003\u0004redacted-declaration')
const sha = createHash('sha256').update(archive).digest('hex')
const privateSha = 'a'.repeat(64)
const candidateSha = 'b'.repeat(64)
const accountId = '167'
const token = 'private-submission-token-123456'
const identity = { draftId: 'plugin_draft_example', expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
  packageSha256: privateSha, candidateSha256: candidateSha,
  capabilityIds: { 'text.check': 'text.check' } }
const prepared = { archive, preview: { packageSha256: sha, packageBytes: archive.byteLength,
  sourcePrivatePackageSha256: privateSha, sourceCandidateSha256: candidateSha,
  manifest: { pluginId: 'owner.text-check', version: '1.0.0', operations: [{
    operationId: 'text.check', capabilityId: 'text.check', executorKind: 'tool',
    permissions: ['workspace.read'], inputSchemaSha256: 'c'.repeat(64),
    outputSchemaSha256: 'd'.repeat(64),
  }] } } }
const submission = { submissionId: '12345678-1234-4234-8234-123456789abc', accountId,
  publisherId: 'qianshou.lab', title: '文字核对', summary: '核对文字',
  submittedAt: 1_800_000_000_000, packageSha256: sha, packageBytes: archive.byteLength,
  unpackedTreeSha256: 'e'.repeat(64), manifest: { format: 'qianshou.declaration.v1' } }
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }))
})

async function origin(onBody: (body: Record<string, unknown>) => unknown): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      expect(request.url).toBe('/qianshou-market/submissions')
      expect(request.headers.authorization).toBe(`Bearer ${token}`)
      expect(request.headers.cookie).toBeUndefined()
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const result = onBody(body)
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    })().catch(error => { response.writeHead(500).end(String(error)) })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test origin missing')
  return `http://127.0.0.1:${address.port}/`
}

function config(apiBaseUrl: string): Config {
  return { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 5000,
    connection: 'api', apiBaseUrl, installHome: '', publisherKeys: { 'qianshou.lab': 'test-public-key' } }
}

it('keeps declaration bytes in Host and binds preview, submit and mine to the same account', async () => {
  let postCount = 0
  let mineCount = 0
  const apiBaseUrl = await origin(body => {
    if (body['action'] === 'mine') {
      mineCount++
      return { ok: true, submissions: [{ ...submission, review: { status: 'pending' } }] }
    }
    postCount++
    expect(body['action']).toBe('submit')
    expect(Buffer.from(body['archiveBase64'] as string, 'base64')).toEqual(archive)
    return { ok: true, submission }
  })
  const ctx = new Context()
  const prepare = vi.fn(async () => prepared)
  ctx.provide('computeCore', { preparePrivatePluginSubmission: prepare })
  ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: accountId } }) })
  ctx.provide('accountSession', { ensureAccessToken: async () => token })
  try {
    await ctx.plugin(QianshouPluginCatalog, config(apiBaseUrl))
    const preview = await ctx.qianshouPluginCatalog.previewPrivatePluginSubmission(identity)
    expect(preview).toMatchObject({ accountId, publisherIds: ['qianshou.lab'],
      pluginId: 'owner.text-check', packageSha256: sha, packageBytes: archive.byteLength,
      operations: [{ operationId: 'text.check', capabilityId: 'text.check' }] })
    expect(JSON.stringify(preview)).not.toContain('archive')
    expect(JSON.stringify(preview)).not.toContain(token)
    await expect(ctx.qianshouPluginCatalog.submitPrivatePluginSubmission({ ...identity,
      publisherId: 'qianshou.lab', title: '文字核对', summary: '核对文字',
      approvedAccountId: accountId, approvedPackageSha256: 'f'.repeat(64) }))
      .rejects.toThrow('QIANSHOU_PLUGIN_SUBMISSION_CONFIRMATION_INVALID')
    expect(postCount).toBe(0)
    const sent = await ctx.qianshouPluginCatalog.submitPrivatePluginSubmission({ ...identity,
      publisherId: 'qianshou.lab', title: '文字核对', summary: '核对文字',
      approvedAccountId: accountId, approvedPackageSha256: sha })
    expect(sent).toMatchObject({ state: 'submitted', receipt: { accountId, packageSha256: sha,
      reviewStatus: 'pending' } })
    expect(postCount).toBe(1)
    expect(prepare).toHaveBeenCalledTimes(3)
    const mine = await ctx.qianshouPluginCatalog.myPrivatePluginSubmissions()
    expect(mine).toMatchObject({ status: 'available', records: [{ accountId,
      packageSha256: sha, reviewStatus: 'pending' }] })
    expect(mineCount).toBe(1)
  } finally { await ctx.fiber.dispose() }
})

it('refuses submission preparation before market configuration or sign-in', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(QianshouPluginCatalog, { ...config('http://127.0.0.1:1/'), connection: 'shipped' })
    await expect(ctx.qianshouPluginCatalog.previewPrivatePluginSubmission(identity))
      .rejects.toThrow('QIANSHOU_MARKET_NOT_CONFIGURED')
  } finally { await ctx.fiber.dispose() }
  const unsigned = new Context()
  try {
    await unsigned.plugin(QianshouPluginCatalog, config('http://127.0.0.1:1/'))
    await expect(unsigned.qianshouPluginCatalog.previewPrivatePluginSubmission(identity))
      .rejects.toThrow('QIANSHOU_ACCOUNT_REQUIRED')
  } finally { await unsigned.fiber.dispose() }
})
