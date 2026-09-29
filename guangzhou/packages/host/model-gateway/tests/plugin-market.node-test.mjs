import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPluginMarketRoute, PLUGIN_MARKET_PATH } from '../src/plugin-market.ts'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publisherKeys = { 'approved-publisher': publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }

// Independent fixture bytes match the Mac Host's signed declaration format.
function signedListing(overrides = {}) {
  const listing = {
    id: 'qianshou.article', title: '文章', summary: '运营方已审核的展示条目',
    capabilityId: 'text.transform', version: '1', packageSpec: '', installable: false,
    requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 },
    ...overrides,
  }
  listing.requirements = { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
    ...overrides.requirements }
  const { packages, model, minFreeDiskBytes, minTotalMemoryBytes, platforms, architectures } = listing.requirements
  const payload = JSON.stringify({ id: listing.id, capabilityId: listing.capabilityId, version: listing.version,
    packageSpec: listing.packageSpec, packages, model, minFreeDiskBytes, minTotalMemoryBytes,
    ...(platforms === undefined ? {} : { platforms }), ...(architectures === undefined ? {} : { architectures }) })
  listing.requirements.signature = { kind: 'publisher', publisher: 'approved-publisher',
    value: sign(null, Buffer.from(payload), privateKey).toString('base64') }
  return listing
}

async function withCatalogFile(run) {
  const directory = await mkdtemp(join(tmpdir(), 'qianshou-approved-market-'))
  try {
    const path = join(directory, 'plugins.json')
    await run(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function requestRoute(options, method = 'GET') {
  const route = createPluginMarketRoute(options)
  const server = createServer((request, response) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== PLUGIN_MARKET_PATH) {
      response.writeHead(404).end()
      return
    }
    void route.handler(request, response)
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${PLUGIN_MARKET_PATH}`, { method })
    return { status: response.status, headers: response.headers, body: await response.json() }
  } finally {
    await new Promise(resolve => { server.close(resolve) })
  }
}

test('an unconfigured public catalog is truthfully empty and read only', async () => {
  const listing = await requestRoute({})
  assert.equal(listing.status, 200)
  assert.deepEqual(listing.body, { listings: [] })
  assert.match(listing.headers.get('content-type') ?? '', /application\/json/)
  assert.equal(listing.headers.get('cache-control'), 'no-store')
  assert.equal(listing.headers.get('x-content-type-options'), 'nosniff')
  const denied = await requestRoute({}, 'POST')
  assert.equal(denied.status, 405)
  assert.equal(denied.headers.get('allow'), 'GET')
})

test('the public endpoint returns only an operator-file row with a trusted publisher signature', async () => {
  await withCatalogFile(async catalogPath => {
    const listing = signedListing({ requirements: { platforms: ['darwin'], architectures: ['arm64'] } })
    await writeFile(catalogPath, JSON.stringify({ version: 1, listings: [listing] }))
    const response = await requestRoute({ catalogPath, publisherKeys })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { listings: [listing] })
    assert.equal(response.body.listings[0].installable, false)
    assert.equal('price' in response.body.listings[0], false)
  })
})

test('one forged or unapproved row rejects the entire catalog', async () => {
  await withCatalogFile(async catalogPath => {
    const valid = signedListing()
    for (const invalid of [
      { ...valid, version: '2' },
      { ...valid, installable: true },
      { ...valid, price: 1 },
      { ...valid, requirements: { ...valid.requirements, architectures: ['x64'] } },
      { ...valid, requirements: { ...valid.requirements, signature: { ...valid.requirements.signature, publisher: 'unknown' } } },
    ]) {
      await writeFile(catalogPath, JSON.stringify({ version: 1, listings: [valid, invalid] }))
      const response = await requestRoute({ catalogPath, publisherKeys })
      assert.equal(response.status, 503)
      assert.deepEqual(response.body, { error: { code: 'PLUGIN_CATALOG_UNAVAILABLE' } })
    }
    await writeFile(catalogPath, JSON.stringify({ version: 1, listings: [valid, valid] }))
    assert.equal((await requestRoute({ catalogPath, publisherKeys })).status, 503)
  })
})

test('a configured missing or oversized file fails closed', async () => {
  await withCatalogFile(async catalogPath => {
    assert.equal((await requestRoute({ catalogPath, publisherKeys })).status, 503)
    await writeFile(catalogPath, 'x'.repeat(1024 * 1024 + 1))
    assert.equal((await requestRoute({ catalogPath, publisherKeys })).status, 503)
  })
  assert.throws(() => createPluginMarketRoute({ catalogPath: 'relative/plugins.json' }), /PLUGIN_CATALOG_PATH_INVALID/)
})
