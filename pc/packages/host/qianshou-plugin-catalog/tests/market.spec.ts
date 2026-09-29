import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import QianshouPluginCatalog, { type Config } from '../src/index.ts'
import { listingMayInstall, marketBundleIdentity, parseMarketListing, readMarketInstallFile, writeMarketInstall } from '../src/market.ts'
import { declarationBytes } from '../src/preflight.ts'
import type { MarketListing } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'qianshou-market-'))
  roots.push(path)
  return path
}

/** One complete plugin config; a test names only what it changes. */
function marketConfig(overrides: Partial<Config> = {}): Config {
  return {
    registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000, connection: 'shipped',
    apiBaseUrl: '', installHome: '', publisherKeys: {}, ...overrides,
  }
}

const keys = generateKeyPairSync('ed25519')
const KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const PUBLISHER = 'qianshou-tools'
const TRUSTED = { [PUBLISHER]: KEY }
const TEST_BUNDLE_NAME = 'qianshou-article'
const TEST_BUNDLE_VERSION = '2.0.0'
const TEST_BUNDLE_SPEC = `${TEST_BUNDLE_NAME}@${TEST_BUNDLE_VERSION}`

/** Local manager observations used by market install tests; an install result alone is not readiness. */
function packageManager(run: (spec: string) => Promise<{ application: string; bundle?: string } | undefined> = async () =>
  ({ application: 'applied', bundle: TEST_BUNDLE_NAME }),
  identity: { name: string; version: string } = { name: TEST_BUNDLE_NAME, version: TEST_BUNDLE_VERSION }) {
  const specs: string[] = []
  let active = false
  let version = identity.version
  let phase: 'active' | 'loading' = 'active'
  return {
    specs,
    activate(nextVersion = identity.version, nextPhase: 'active' | 'loading' = 'active') {
      active = true; version = nextVersion; phase = nextPhase
    },
    manager: {
      async installBundle(spec: string) {
        specs.push(spec)
        const result = await run(spec)
        if (result?.application === 'applied' && result.bundle === identity.name) active = true
        return result
      },
      async removeBundle() { return undefined },
      async listBundles() {
        return active ? [{ name: identity.name, version, enabled: true, installed: true, rows: [{ entryId: 'live-row' }] }] : []
      },
      async checkBundle() {
        return active
          ? { scope: 'host-loading', name: identity.name,
            state: phase === 'active' ? 'active' : 'incomplete', selected: true, version,
            rows: [{ phase }], errors: [], checkedAt: Date.now() }
          : { scope: 'host-loading', name: identity.name, state: 'missing', selected: false,
            rows: [], errors: [], checkedAt: Date.now() }
      },
    },
  }
}

/** One row as a market API sends it, signed over its own declaration bytes. */
function apiRow(overrides: Partial<MarketListing> = {}): Record<string, unknown> {
  const base: MarketListing = {
    id: 'qianshou.article',
    title: '文章',
    summary: 'article',
    capabilityId: 'text.transform',
    version: '2',
    packageSpec: TEST_BUNDLE_SPEC,
    installable: true,
    requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 },
  }
  const listing: MarketListing = { ...base, ...overrides, requirements: { ...base.requirements, ...overrides.requirements } }
  const payload = declarationBytes(listing)
  listing.requirements = {
    ...listing.requirements,
    signature: { kind: 'publisher', publisher: PUBLISHER, value: sign(null, Buffer.from(payload, 'utf8'), keys.privateKey).toString('base64') },
  }
  return JSON.parse(JSON.stringify(listing)) as Record<string, unknown>
}

it('accepts exact registry releases and refuses floating or local market package specs', () => {
  expect(marketBundleIdentity(TEST_BUNDLE_SPEC)).toEqual({ name: TEST_BUNDLE_NAME, version: TEST_BUNDLE_VERSION })
  expect(marketBundleIdentity('@qianshou/writer@1.2.3')).toEqual({ name: '@qianshou/writer', version: '1.2.3' })
  for (const spec of ['qianshou-article@2', 'qianshou-article@latest', 'qianshou-article@^2.0.0',
    'https://example.com/writer.tgz', '/tmp/writer', 'file:/tmp/writer']) {
    expect(marketBundleIdentity(spec)).toBeNull()
    expect(listingMayInstall(parseMarketListing(apiRow({ packageSpec: spec }))!)).toBe(false)
  }
})

it('separates private package installation from empty-package declarations', () => {
  const signedVideo = parseMarketListing(apiRow({ id: 'qianshou.drawn-video',
    capabilityId: 'video.drawn-mac-5s', version: '0.1.0', packageSpec: 'qianshou-drawn-video@0.1.0' }))!
  expect(listingMayInstall(signedVideo)).toBe(true)
  const emptyApiDeclaration = parseMarketListing(apiRow({ packageSpec: '', version: '1' }))!
  expect(listingMayInstall(emptyApiDeclaration)).toBe(false)
  const disabledPreview = parseMarketListing(apiRow({ id: 'qianshou.image',
    capabilityId: 'image.generate', packageSpec: 'qianshou-image@1.0.0', installable: false }))!
  expect(listingMayInstall(disabledPreview)).toBe(false)
})

/** Serve one market document for the duration of `run`. */
async function withServer(listings: () => unknown, run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url !== '/plugins') { response.writeHead(404).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ listings: listings() }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('listen failed')
  try {
    await run(`http://127.0.0.1:${address.port}/`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

it('ships article as installable and image as not installable', async () => {
  const ctx = new Context()
  const installHome = await home()
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const page = await ctx.qianshouPluginCatalog.listings()
    expect(page.mode).toBe('shipped')
    expect(page.listings.find(item => item.id === 'qianshou.article')?.summary).toContain('草稿')
    expect(page.listings.map(item => [item.id, item.capabilityId, item.installable])).toEqual([
      ['qianshou.article', 'text.transform', true],
      ['qianshou.image', 'image.generate', false],
    ])
    await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.image' })).rejects.toThrow('not-advertisable')
    await expect(ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.image' })).rejects.toThrow('not-advertisable')
    expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('checks shipped article resources and saves its declaration without reporting empty package checks as passed', async () => {
  const ctx = new Context()
  const installHome = await home()
  let refreshed = 0
  ctx.provide('qianshou.market.hello', { refresh: async () => { refreshed += 1 } })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
    expect(report).toMatchObject({ listingId: 'qianshou.article', verdict: 'passed', failedStep: null, actions: [] })
    expect(report.steps.map(step => [step.id, step.state])).toEqual([
      ['signature', 'not-applicable'], ['dependencies', 'not-applicable'],
      ['model', 'not-applicable'], ['resources', 'passed'],
    ])
    expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
    const record = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    expect(record.capabilityId).toBe('text.transform')
    expect(refreshed).toBe(1)
    const saved = JSON.parse(await readFile(join(installHome, 'qianshou', 'market-installed.json'), 'utf8')) as {
      version: number
      installed: { id: string; capabilityId: string }[]
    }
    expect(saved.version).toBe(1)
    expect(saved.installed).toEqual([expect.objectContaining({ id: 'qianshou.article', capabilityId: 'text.transform' })])
    expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [record] })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('preserves old built-in visibility while treating unknown legacy rows as unverified drafts', async () => {
  const ctx = new Context()
  const installHome = await home()
  const path = join(installHome, 'qianshou', 'market-installed.json')
  writeMarketInstall(path, {
    id: 'qianshou.article', capabilityId: 'text.transform', version: '1',
    installedAt: new Date().toISOString(), visibility: 'public', inviteAccountIds: [],
  })
  writeMarketInstall(path, {
    id: 'qianshou.unknown', capabilityId: 'text.transform', version: '1',
    installedAt: new Date().toISOString(), visibility: 'draft', inviteAccountIds: [],
  })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    expect((await ctx.qianshouPluginCatalog.installed()).records)
      .toMatchObject([{ id: 'qianshou.article', visibility: 'public' }, { id: 'qianshou.unknown', visibility: 'draft' }])
    expect((await ctx.qianshouPluginCatalog.installationActivity()).records).toMatchObject([
      { id: 'qianshou.article', packageSpec: '', state: 'active' },
      { id: 'qianshou.unknown', packageSpec: null, state: 'unknown' },
    ])
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).capabilities).toMatchObject([
      { record: { id: 'qianshou.article', visibility: 'public' }, activity: 'active', advertisable: true },
      { record: { id: 'qianshou.unknown', visibility: 'draft' }, activity: 'unknown', advertisable: false },
    ])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('removes only the selected built-in declaration, reads it back and allows adding it again', async () => {
  const ctx = new Context()
  const installHome = await home()
  const path = join(installHome, 'qianshou', 'market-installed.json')
  let refreshed = 0
  ctx.provide('qianshou.market.hello', { refresh: async () => { refreshed += 1 } })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const article = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    writeMarketInstall(path, {
      id: 'qianshou.other', capabilityId: 'text.transform', version: '1',
      installedAt: new Date().toISOString(), visibility: 'draft', inviteAccountIds: [],
    })
    expect(await ctx.qianshouPluginCatalog.remove({ id: 'qianshou.article' }))
      .toEqual({ id: 'qianshou.article', removed: true })
    expect(refreshed).toBe(2)
    expect(readMarketInstallFile(path).map(row => row.id)).toEqual(['qianshou.other'])
    expect((await ctx.qianshouPluginCatalog.installed()).records.map(row => row.id)).toEqual(['qianshou.other'])
    expect(await ctx.qianshouPluginCatalog.remove({ id: 'qianshou.article' }))
      .toEqual({ id: 'qianshou.article', removed: false })
    expect(refreshed).toBe(2)
    const addedAgain = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    expect(addedAgain).toMatchObject({ id: article.id, capabilityId: article.capabilityId })
    expect(readMarketInstallFile(path).map(row => row.id)).toEqual(['qianshou.article', 'qianshou.other'])
    expect(refreshed).toBe(3)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('does not remove or uninstall a package-backed API listing through declaration removal', async () => {
  const ctx = new Context()
  const installHome = await home()
  const removeBundle = async () => { throw new Error('must not uninstall') }
  ctx.provide('pluginManager', {
    installBundle: async () => ({ application: 'applied' }), removeBundle,
  })
  await withServer(() => [apiRow()], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      await expect(ctx.qianshouPluginCatalog.remove({ id: 'qianshou.article' })).rejects.toThrow('remove-unavailable')
      expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('rejects malformed or unsupported OS and CPU claims in an API listing', () => {
  const valid = apiRow()
  const requirements = valid.requirements as Record<string, unknown>
  for (const claim of [
    { platforms: [] }, { platforms: ['darwin', 'darwin'] }, { platforms: ['freebsd'] },
    { architectures: [] }, { architectures: ['arm64', 'arm64'] }, { architectures: ['mips'] },
    { gpuVramBytes: 1024 },
  ]) {
    expect(parseMarketListing({ ...valid, requirements: { ...requirements, ...claim } })).toBeNull()
  }
  expect(parseMarketListing(valid)?.requirements.platforms).toBeUndefined()
  expect(parseMarketListing(valid)?.requirements.architectures).toBeUndefined()
})

it('refuses to install a signed API listing that excludes this computer OS or CPU architecture', async () => {
  const anotherPlatform: 'darwin' | 'win32' = platform() === 'darwin' ? 'win32' : 'darwin'
  const anotherArchitecture: 'arm64' | 'x64' = arch() === 'arm64' ? 'x64' : 'arm64'
  const cases = [
    {
      requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
        platforms: [anotherPlatform] },
      reason: 'RESOURCE_PLATFORM_UNSUPPORTED',
    },
    {
      requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
        architectures: [anotherArchitecture] },
      reason: 'RESOURCE_ARCHITECTURE_UNSUPPORTED',
    },
  ]
  for (const testCase of cases) {
    const ctx = new Context()
    const installHome = await home()
    const installedSpecs: string[] = []
    ctx.provide('pluginManager', {
      installBundle: async (spec: string) => { installedSpecs.push(spec); return { application: 'applied' } },
      removeBundle: async () => undefined,
    })
    await withServer(() => [apiRow({ requirements: testCase.requirements })], async (origin) => {
      try {
        await ctx.plugin(QianshouPluginCatalog, marketConfig({
          connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
        }))
        const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
        expect(report.failedStep).toBe('resources')
        expect(report.steps[3]).toMatchObject({ state: 'failed', reason: testCase.reason })
        await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('preflight-failed')
        expect(installedSpecs).toEqual([])
        expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
      } finally {
        await ctx.fiber.dispose()
      }
    })
  }
})

it('detects a changed OS claim after the API listing was signed', async () => {
  const ctx = new Context()
  const installHome = await home()
  const signed = apiRow({ requirements: {
    signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
    platforms: [platform() as 'darwin' | 'win32' | 'linux'],
  } })
  const tampered = { ...signed, requirements: { ...(signed.requirements as Record<string, unknown>), platforms: ['win32', 'linux'] } }
  await withServer(() => [tampered], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.steps[0]).toMatchObject({ state: 'failed', reason: 'SIGNATURE_INVALID' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('keeps a declaration when the hello refresh fails', async () => {
  const ctx = new Context()
  const installHome = await home()
  ctx.provide('qianshou.market.hello', { refresh: async () => { throw new Error('socket down') } })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const record = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    expect((await ctx.qianshouPluginCatalog.installed()).records).toEqual([record])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reads an API catalog while keeping an explicitly disabled image preview off', async () => {
  const ctx = new Context()
  const installHome = await home()
  const packageState = packageManager()
  ctx.provide('pluginManager', packageState.manager)
  await withServer(() => [
    apiRow(),
    apiRow({ id: 'qianshou.image', capabilityId: 'image.generate', packageSpec: 'qianshou-image@1.0.0', installable: false }),
  ], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const page = await ctx.qianshouPluginCatalog.listings()
      expect(page.mode).toBe('api')
      expect(page.listings.find(item => item.id === 'qianshou.image')?.installable).toBe(false)
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.image' })).rejects.toThrow('not-advertisable')
      const record = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
      expect(packageState.specs).toEqual([TEST_BUNDLE_SPEC])
      expect(record).toMatchObject({ id: 'qianshou.article', capabilityId: 'text.transform', version: '2', visibility: 'draft' })
      expect((await ctx.qianshouPluginCatalog.installationActivity()).records[0])
        .toMatchObject({ packageSpec: TEST_BUNDLE_SPEC, state: 'active' })
      packageState.activate('2.0.1')
      expect((await ctx.qianshouPluginCatalog.installationActivity()).records[0])
        .toMatchObject({ packageSpec: TEST_BUNDLE_SPEC, state: 'inactive' })
      expect((await ctx.qianshouPluginCatalog.myCapabilities()).capabilities[0]?.advertisable).toBe(false)
      await expect(ctx.qianshouPluginCatalog.publishCapability({
        id: 'qianshou.article', visibility: 'public', confirmPublic: true,
      })).rejects.toThrow('not-advertisable')
      expect((await ctx.qianshouPluginCatalog.installed()).records[0]?.visibility).toBe('draft')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('installs a signed exact Mac video package as a private draft but never advertises it for orders', async () => {
  const ctx = new Context()
  const installHome = await home()
  const identity = { name: 'qianshou-drawn-video', version: '0.1.0' }
  const spec = `${identity.name}@${identity.version}`
  const packageState = packageManager(async () => ({ application: 'applied', bundle: identity.name }), identity)
  ctx.provide('pluginManager', packageState.manager)
  await withServer(() => [apiRow({ id: 'qianshou.drawn-video', title: '五秒绘图视频',
    capabilityId: 'video.drawn-mac-5s', version: identity.version, packageSpec: spec,
    requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0,
      minTotalMemoryBytes: 0, platforms: ['darwin'] } })], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const listing = (await ctx.qianshouPluginCatalog.listings()).listings[0]
      expect(listing?.installable).toBe(true)
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.drawn-video' })
      expect(report.verdict).toBe(platform() === 'darwin' ? 'passed' : 'failed')
      if (platform() !== 'darwin') return
      const installed = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.drawn-video' })
      expect(installed).toMatchObject({ capabilityId: 'video.drawn-mac-5s', packageSpec: spec,
        visibility: 'draft', inviteAccountIds: [] })
      expect(packageState.specs).toEqual([spec])
      expect((await ctx.qianshouPluginCatalog.installationActivity()).records[0]).toMatchObject({ state: 'active' })
      expect((await ctx.qianshouPluginCatalog.myCapabilities()).capabilities[0])
        .toMatchObject({ activity: 'active', advertisable: false })
      await expect(ctx.qianshouPluginCatalog.publishCapability({ id: 'qianshou.drawn-video',
        visibility: 'public', confirmPublic: true })).rejects.toThrow('not-advertisable')
      expect((await ctx.qianshouPluginCatalog.installed()).records[0]?.visibility).toBe('draft')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('refuses a row with no signature instead of installing it, and writes nothing', async () => {
  const ctx = new Context()
  const installHome = await home()
  await withServer(() => [{ ...apiRow(), requirements: undefined }], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.verdict).toBe('failed')
      expect(report.steps[0]).toMatchObject({ id: 'signature', state: 'failed', reason: 'SIGNATURE_MISSING' })
      expect(report.steps.slice(1).map(step => step.state)).toEqual(['not-checked', 'not-checked', 'not-checked'])
      expect(report.actions).toEqual(['fix', 'recheck', 'cancel', 'rollback'])
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('preflight-failed')
      expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('names an unknown publisher and an invalid signature separately', async () => {
  const ctx = new Context()
  const installHome = await home()
  const unsigned = apiRow()
  const tampered = apiRow()
  await withServer(() => [{ ...unsigned, requirements: { ...(unsigned.requirements as Record<string, unknown>), signature: { kind: 'publisher', publisher: 'nobody', value: 'A'.repeat(88) } } }], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.steps[0]).toMatchObject({ state: 'failed', reason: 'SIGNATURE_PUBLISHER_UNKNOWN', detail: 'publisher=nobody' })
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('preflight-failed')
    } finally {
      await ctx.fiber.dispose()
    }
  })
  const other = new Context()
  try {
    await withServer(() => [{ ...tampered, version: '3' }], async (origin) => {
      await other.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await other.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.steps[0]).toMatchObject({ state: 'failed', reason: 'SIGNATURE_INVALID', detail: `publisher=${PUBLISHER}` })
    })
  } finally {
    await other.fiber.dispose()
  }
})

it('reports a missing dependency, repairs it through the plugin manager, and rolls the repair back', async () => {
  const ctx = new Context()
  const installHome = await home()
  const installedSpecs: string[] = []
  const removed: string[] = []
  ctx.provide('pluginManager', {
    installBundle: async (spec: string) => { installedSpecs.push(spec); return { application: 'applied' } },
    removeBundle: async (name: string) => { removed.push(name); return { changed: true } },
  })
  await withServer(() => [
    apiRow({ requirements: { signature: null, packages: [{ name: 'qianshou-extra', minimumVersion: '1.2.0' }], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 } }),
  ], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.steps[1]).toMatchObject({ state: 'failed', reason: 'DEPENDENCY_MISSING', detail: 'name=qianshou-extra min=1.2.0' })
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('preflight-failed')
      const repaired = await ctx.qianshouPluginCatalog.repair({ id: 'qianshou.article' })
      expect(installedSpecs).toEqual(['qianshou-extra@1.2.0'])
      expect(repaired).toMatchObject({ step: 'dependencies', outcome: 'unchanged', detail: 'installed=qianshou-extra' })
      expect(repaired.report.steps[1]).toMatchObject({ state: 'failed', reason: 'DEPENDENCY_MISSING' })
      const rolled = await ctx.qianshouPluginCatalog.rollback({ id: 'qianshou.article' })
      expect(removed).toEqual(['qianshou-extra'])
      expect(rolled).toMatchObject({ restored: false, reverted: ['qianshou-extra'], detail: 'declaration-unchanged' })
      expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it.each([
  { application: 'restart-required', detail: 'activation-pending', reverted: ['qianshou-extra'] },
  { application: 'overridden', detail: 'install-failed', reverted: [] },
  { application: 'cancelled', detail: 'install-failed', reverted: [] },
  { application: 'failed', detail: 'install-failed', reverted: [] },
  { application: undefined, detail: 'install-failed', reverted: [] },
])('does not count a $application dependency install as repaired', async ({ application, detail, reverted }) => {
  const ctx = new Context()
  const installHome = await home()
  const removed: string[] = []
  ctx.provide('pluginManager', {
    installBundle: async () => application === undefined ? undefined : { application },
    removeBundle: async (name: string) => { removed.push(name) },
  })
  await withServer(() => [apiRow({ requirements: {
    signature: null, packages: [{ name: 'qianshou-extra', minimumVersion: '1.2.0' }],
    model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
  } })], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const result = await ctx.qianshouPluginCatalog.repair({ id: 'qianshou.article' })
      expect(result).toMatchObject({ step: 'dependencies', outcome: 'unchanged', detail: `${detail} name=qianshou-extra` })
      expect(result.report.verdict).toBe('failed')
      await ctx.qianshouPluginCatalog.rollback({ id: 'qianshou.article' })
      expect(removed).toEqual(reverted)
      expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('fails the dependency step for an installed module below the declared version', async () => {
  const ctx = new Context()
  const installHome = await home()
  await withServer(() => [
    apiRow({ requirements: { signature: null, packages: [{ name: 'zod', minimumVersion: '99.0.0' }], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 } }),
  ], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.steps[1]).toMatchObject({ state: 'failed', reason: 'DEPENDENCY_VERSION_LOW' })
      expect(report.steps[1]?.detail).toContain('name=zod installed=')
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('preflight-failed')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('passes the dependency step for a module this computer has installed', async () => {
  const ctx = new Context()
  const installHome = await home()
  ctx.provide('pluginManager', packageManager().manager)
  await withServer(() => [
    apiRow({ requirements: { signature: null, packages: [{ name: 'zod', minimumVersion: '4.0.0' }], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 } }),
  ], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.verdict).toBe('passed')
      const record = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
      expect(record.id).toBe('qianshou.article')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('fails the model step when the declared route is not registered here', async () => {
  const ctx = new Context()
  const installHome = await home()
  ctx.provide('pluginManager', {
    installBundle: async () => ({ application: 'applied' }),
    removeBundle: async () => undefined,
  })
  await withServer(() => [
    apiRow({ requirements: { signature: null, packages: [], model: 'deepseek', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 } }),
  ], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.steps[2]).toMatchObject({ state: 'failed', reason: 'MODEL_PROVIDER_MISSING', detail: 'required=deepseek' })
      const repaired = await ctx.qianshouPluginCatalog.repair({ id: 'qianshou.article' })
      expect(repaired).toMatchObject({ step: 'model', outcome: 'unavailable', detail: 'owner-model-route' })
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('preflight-failed')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('passes the model step once the declared route is registered', async () => {
  const ctx = new Context()
  const installHome = await home()
  ctx.provide('llm', { listProviders: () => [{ id: 'deepseek' }, { id: 'replay' }] })
  ctx.provide('pluginManager', packageManager().manager)
  await withServer(() => [
    apiRow({ requirements: { signature: null, packages: [], model: 'deepseek', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 } }),
  ], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report).toMatchObject({ verdict: 'passed' })
      expect(report.steps[2]).toMatchObject({ id: 'model', state: 'passed' })
      expect((await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).id).toBe('qianshou.article')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('fails the resource step against the disk and memory floors it observes', async () => {
  const ctx = new Context()
  const installHome = await home()
  await withServer(() => [
    apiRow({ requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 10 ** 15, minTotalMemoryBytes: 0 } }),
  ], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' })
      expect(report.steps[3]).toMatchObject({ state: 'failed', reason: 'RESOURCE_DISK_LOW' })
      expect(report.steps[3]?.detail).toContain('required=1000000000000000')
      const repaired = await ctx.qianshouPluginCatalog.repair({ id: 'qianshou.article' })
      expect(repaired).toMatchObject({ step: 'resources', outcome: 'unavailable', detail: 'owner-free-space' })
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('preflight-failed')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('rolls a written declaration back to the bytes this computer had before the install', async () => {
  const ctx = new Context()
  const installHome = await home()
  const path = join(installHome, 'qianshou', 'market-installed.json')
  const previous = `${JSON.stringify({ version: 1, installed: [{ id: 'qianshou.article', capabilityId: 'text.transform', version: '0', installedAt: '2026-09-01T00:00:00.000Z' }] }, null, 2)}\n`
  await mkdir(join(installHome, 'qianshou'), { recursive: true })
  await writeFile(path, previous)
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const record = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    expect(record.version).toBe('1')
    expect(await readFile(path, 'utf8')).not.toBe(previous)
    const rolled = await ctx.qianshouPluginCatalog.rollback({ id: 'qianshou.article' })
    expect(rolled).toMatchObject({ restored: true, reverted: [], detail: 'declaration-restored' })
    expect(await readFile(path, 'utf8')).toBe(previous)
    expect((await ctx.qianshouPluginCatalog.installed()).records).toEqual([
      expect.objectContaining({ id: 'qianshou.article', version: '0' }),
    ])
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([
  { application: 'restart-required', error: 'activation-pending' },
  { application: 'overridden', error: 'install-failed' },
  { application: 'cancelled', error: 'install-failed' },
  { application: 'failed', error: 'install-failed' },
  { application: undefined, error: 'install-failed' },
])('does not save a declaration when package application is $application', async ({ application, error }) => {
  const ctx = new Context()
  const installHome = await home()
  ctx.provide('pluginManager', packageManager(async () => application === undefined ? undefined
    : { application, bundle: TEST_BUNDLE_NAME }).manager)
  await withServer(() => [apiRow()], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow(error)
      expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('does not declare a package that needs restart, then records its exact active release after boot', async () => {
  const ctx = new Context()
  const installHome = await home()
  const packageState = packageManager(async () => ({ application: 'restart-required', bundle: TEST_BUNDLE_NAME }))
  ctx.provide('pluginManager', packageState.manager)
  await withServer(() => [apiRow()], async (origin) => {
    try {
      await ctx.plugin(QianshouPluginCatalog, marketConfig({
        connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
      }))
      await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('activation-pending')
      expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
      packageState.activate()
      const record = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
      expect(record).toMatchObject({ id: 'qianshou.article', visibility: 'draft' })
      expect(packageState.specs).toEqual([TEST_BUNDLE_SPEC])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('does not declare cancelled, overridden or wrong-identity installer outcomes', async () => {
  const outcomes = [
    { application: 'cancelled', bundle: TEST_BUNDLE_NAME },
    { application: 'overridden', bundle: TEST_BUNDLE_NAME },
    { application: 'applied', bundle: 'other-bundle' },
    { application: 'applied' },
  ]
  for (const outcome of outcomes) {
    const ctx = new Context()
    const installHome = await home()
    const packageState = packageManager(async () => outcome)
    ctx.provide('pluginManager', packageState.manager)
    await withServer(() => [apiRow()], async (origin) => {
      try {
        await ctx.plugin(QianshouPluginCatalog, marketConfig({
          connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
        }))
        await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('install-failed')
        expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
        expect(packageState.specs).toEqual([TEST_BUNDLE_SPEC])
      } finally {
        await ctx.fiber.dispose()
      }
    })
  }
})

it('refuses a bundle with the wrong installed version or a Host row still loading', async () => {
  for (const [version, phase] of [['1.9.9', 'active'], [TEST_BUNDLE_VERSION, 'loading']] as const) {
    const ctx = new Context()
    const installHome = await home()
    const packageState = packageManager()
    packageState.activate(version, phase)
    ctx.provide('pluginManager', packageState.manager)
    await withServer(() => [apiRow()], async (origin) => {
      try {
        await ctx.plugin(QianshouPluginCatalog, marketConfig({
          connection: 'api', apiBaseUrl: origin, installHome, timeoutMs: 5000, publisherKeys: TRUSTED,
        }))
        await expect(ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })).rejects.toThrow('install-failed')
        expect(await ctx.qianshouPluginCatalog.installed()).toEqual({ records: [] })
      } finally {
        await ctx.fiber.dispose()
      }
    })
  }
})

it('refuses api mode without an origin', async () => {
  const ctx = new Context()
  await expect(ctx.plugin(QianshouPluginCatalog, marketConfig({ connection: 'api', timeoutMs: 1000 }))).rejects.toThrow(
    'Market API must be HTTPS',
  )
  await ctx.fiber.dispose()
})
