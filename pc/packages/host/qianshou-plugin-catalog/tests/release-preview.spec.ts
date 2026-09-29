import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import QianshouPluginCatalog, { type Config } from '../src/index.ts'
import { approvalPayload, fetchReleasePreviews, parseReleaseBody, releasePayload } from '../src/release-preview.ts'

const publisher = generateKeyPairSync('ed25519')
const reviewer = generateKeyPairSync('ed25519')
const publisherKeys = { 'qianshou-studio': publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const operatorKeys = { 'qianshou-review': reviewer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }

function signedRelease() {
  const release = {
    pluginId: 'qianshou.example', version: '1.2.3', releaseId: 'reviewed-example-1',
    title: 'Example workflow', summary: 'A local workflow released for review.',
    packageSha256: 'a'.repeat(64), packageBytes: 1024,
    platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
    operations: [{
      capabilityId: 'text.transform', operationId: 'rewrite', executorKind: 'workflow',
      inputSchemaSha256: 'b'.repeat(64), outputSchemaSha256: 'c'.repeat(64),
      permissions: ['workspace.read'],
    }],
    publisher: { id: 'qianshou-studio', signature: '' },
    approval: { reviewId: 'review-1', reviewedAt: 1_780_000_000_000,
      operatorId: 'qianshou-review', signature: '' },
    verificationScope: 'opaque-archive-bytes', installable: false,
  }
  const payload = releasePayload(release as unknown as Parameters<typeof releasePayload>[0])
  release.publisher.signature = sign(null, Buffer.from(payload), publisher.privateKey).toString('base64')
  const approval = approvalPayload(release as unknown as Parameters<typeof approvalPayload>[0])
  release.approval.signature = sign(null, Buffer.from(approval), reviewer.privateKey).toString('base64')
  return release
}

function parsed(rows: unknown[]) {
  return parseReleaseBody({ releases: rows }, publisherKeys, operatorKeys)
}

it('reads only dual-signed read-only metadata and never creates an install spec', () => {
  const release = signedRelease()
  expect(releasePayload(release as unknown as Parameters<typeof releasePayload>[0])).toContain('"packageSha256":"' + 'a'.repeat(64) + '"')
  expect(parsed([release])).toEqual([{
    pluginId: 'qianshou.example', version: '1.2.3', releaseId: 'reviewed-example-1',
    title: 'Example workflow', summary: 'A local workflow released for review.',
    packageBytes: 1024, platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
    operations: [{ capabilityId: 'text.transform', operationId: 'rewrite', executorKind: 'workflow',
      permissions: ['workspace.read'] }],
    publisherId: 'qianshou-studio', reviewId: 'review-1', reviewedAt: 1_780_000_000_000,
    verificationScope: 'opaque-archive-bytes', installable: false,
  }])
  expect(JSON.stringify(parsed([release]))).not.toContain('packageSha256')
  expect(JSON.stringify(parsed([release]))).not.toContain('signature')
})

it('rejects malformed, duplicate, promoted and untrusted release responses as a whole', () => {
  const release = signedRelease()
  const modify = (changes: Record<string, unknown>) => ({ ...release, ...changes })
  for (const body of [
    { releases: [release], extra: true },
    { releases: [release, release] },
    { releases: [release, modify({ releaseId: 'another-id' })] },
    { releases: Array.from({ length: 101 }, () => release) },
    { releases: [modify({ installable: true })] },
    { releases: [modify({ verificationScope: 'verified-executable' })] },
    { releases: [modify({ title: 'Tampered title' })] },
    { releases: [modify({ unexpectedUrl: 'https://example.test/package' })] },
    { releases: [modify({ packageBytes: 0 })] },
    { releases: [modify({ operations: [{ ...release.operations[0], permissions: ['shell.root'] }] })] },
    { releases: [modify({ publisher: { ...release.publisher, id: 'unknown-publisher' } })] },
    { releases: [modify({ approval: { ...release.approval, operatorId: 'unknown-reviewer' } })] },
  ]) {
    expect(parseReleaseBody(body, publisherKeys, operatorKeys)).toBeNull()
  }
  expect(parseReleaseBody({ releases: [release] }, {}, operatorKeys)).toBeNull()
  expect(parseReleaseBody({ releases: [release] }, publisherKeys, {})).toBeNull()
  expect(parseReleaseBody({ releases: [release] }, publisherKeys, { 'qianshou-review': publisherKeys['qianshou-studio'] })).toBeNull()
  expect(parseReleaseBody({ releases: [] }, {}, {})).toEqual([])
})

it('bounds network bytes and refuses a release redirect', async () => {
  let redirect = true
  const server = createServer((request, response) => {
    if (request.url === '/qianshou-market/releases') {
      if (redirect) { response.writeHead(302, { location: '/untrusted' }).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end('x'.repeat(1024 * 1024 + 1)); return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('listen failed')
  const base = new URL(`http://127.0.0.1:${address.port}/`)
  try {
    await expect(fetchReleasePreviews(base, new AbortController().signal, publisherKeys, operatorKeys)).rejects.toThrow()
    redirect = false
    await expect(fetchReleasePreviews(base, new AbortController().signal, publisherKeys, operatorKeys)).rejects.toThrow('invalid-response')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})

async function withServer(releases: unknown, run: (base: string) => Promise<void>) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/qianshou-market/plugins') { response.end(JSON.stringify({ listings: [] })); return }
    if (request.url === '/qianshou-market/releases' && releases !== null) {
      response.end(JSON.stringify(releases)); return
    }
    response.writeHead(404).end(JSON.stringify({ error: 'missing' }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('listen failed')
  try { await run(`http://127.0.0.1:${address.port}/qianshou-market/`) }
  finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

function config(apiBaseUrl: string): Config {
  return { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 5000, connection: 'api',
    apiBaseUrl, installHome: '', publisherKeys, operatorKeys }
}

it('keeps /plugins available when the separate release route is missing, then renders signed previews without installing', async () => {
  for (const body of [null, { releases: [signedRelease()] }]) {
    await withServer(body, async (base) => {
      const ctx = new Context()
      try {
        await ctx.plugin(QianshouPluginCatalog, config(base))
        const page = await ctx.qianshouPluginCatalog.listings()
        expect(page.listings).toEqual([])
        expect(page.releaseSource).toBe(`${base}releases`)
        expect(page.releaseStatus).toBe(body === null ? 'unavailable' : 'available')
        expect(page.releases).toHaveLength(body === null ? 0 : 1)
        await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.example' })).rejects.toThrow('unknown-listing')
        expect((await ctx.qianshouPluginCatalog.installed()).records).toEqual([])
      } finally { await ctx.fiber.dispose() }
    })
  }
})
