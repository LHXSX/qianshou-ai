/** Real Cordis Loader and Tools registry for an account-bound Guangzhou free seed. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import QianshouPluginCatalog, { type Config } from '../src/index.ts'
import { CSV_SEED_IDENTITY } from '../src/official-seed-csv.ts'
import { approvalPayload, releasePayload } from '../src/release-preview.ts'
import * as MarketTools from '../src/reviewed-seed-market-tools.ts'

const accessToken = 'account-test-token-with-more-than-32-characters'
const artifactToken = 'artifact-test-token-with-more-than-32-characters'

async function market() {
  const bytes = await readFile(new URL('../seed/csv-profile/qianshou.csv-profile-1.0.0.qspkg', import.meta.url))
  const publisher = generateKeyPairSync('ed25519')
  const reviewer = generateKeyPairSync('ed25519')
  const release = {
    pluginId: CSV_SEED_IDENTITY.pluginId, version: CSV_SEED_IDENTITY.version,
    releaseId: CSV_SEED_IDENTITY.releaseId, title: 'CSV 结构体检', summary: '本机检查 CSV 列结构',
    packageSha256: createHash('sha256').update(bytes).digest('hex'), packageBytes: bytes.length,
    platforms: [platform()], architectures: [arch()],
    operations: [{ capabilityId: CSV_SEED_IDENTITY.capabilityId,
      operationId: CSV_SEED_IDENTITY.operationId, executorKind: 'node',
      inputSchemaSha256: CSV_SEED_IDENTITY.inputSchemaSha256,
      outputSchemaSha256: CSV_SEED_IDENTITY.outputSchemaSha256, permissions: [] }],
    publisher: { id: 'studio', signature: '' },
    approval: { reviewId: 'csv-review-1', reviewedAt: Date.now(), operatorId: 'reviewer', signature: '' },
    verificationScope: 'opaque-archive-bytes', installable: false,
  }
  release.publisher.signature = sign(null, Buffer.from(releasePayload(release as never)),
    publisher.privateKey).toString('base64')
  release.approval.signature = sign(null, Buffer.from(approvalPayload(release as never)),
    reviewer.privateKey).toString('base64')
  const control = { accountId: '167', checkStatus: 200, checkReply: undefined as unknown,
    newRouteEnabled: true, claimStatus: 200, metadata: 0, checks: 0, claims: 0,
    legacy: 0, artifacts: 0 }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/qianshou-market/releases' && url.searchParams.size === 0) {
      control.metadata += 1
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ releases: [release] })); return
    }
    if (url.pathname === '/api/qianshou/ai/plugins/license') {
      control.legacy += 1
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, accountId: control.accountId,
          authMode: 'bearer-request-bound' }))
      return
    }
    if (url.pathname === '/qianshou-market/license' && control.newRouteEnabled) {
      if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${accessToken}`
      ) {
        response.writeHead(401).end(); return
      }
      const input: Buffer[] = []
      request.on('data', (part: Buffer) => input.push(part))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(input).toString('utf8')) as unknown
        if (JSON.stringify(body) === JSON.stringify({ action: 'check' })) {
          control.checks += 1
          response.writeHead(control.checkStatus, { 'content-type': 'application/json' })
            .end(JSON.stringify(control.checkReply ?? { ok: true, accountId: control.accountId,
              authMode: 'bearer-request-bound' }))
          return
        }
        if (JSON.stringify(body) !== JSON.stringify({ action: 'claim', releaseId: release.releaseId })) {
          response.writeHead(400).end(); return
        }
        control.claims += 1
        if (control.claimStatus !== 200) {
          response.writeHead(control.claimStatus).end(); return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          ok: true, releaseId: release.releaseId, pluginId: release.pluginId,
          version: release.version, packageSha256: release.packageSha256,
          license: { licenseId: 'free-167', kind: 'free', accountId: control.accountId,
            claimedAt: Date.now() },
          download: { url: `/qianshou-market/releases?artifact=${release.releaseId}`,
            token: artifactToken, expiresAt: Date.now() + 5 * 60_000 },
        }))
      })
      return
    }
    if (url.pathname === '/qianshou-market/releases' && url.searchParams.get('artifact') === release.releaseId) {
      control.artifacts += 1
      if (request.headers.authorization !== `Bearer ${artifactToken}`) {
        response.writeHead(403).end(); return
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-qianshou-package-sha256': release.packageSha256 }).end(bytes)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('market listener absent')
  return { url: `http://127.0.0.1:${address.port}/`, control,
    publisherKeys: { studio: publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    operatorKeys: { reviewer: reviewer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

async function loaded(config: Partial<Config>, behavior: {
  accountId: string; approval: string; accountCarrier: boolean; reasons: string[]
}) {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-reviewed-host-'))
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  await writeFile(anchor, '{"name":"reviewed-host","dependencies":{}}\n')
  initProfile(dir, ['core'])
  const core = join(dir, 'node_modules', 'core')
  await mkdir(core, { recursive: true })
  await writeFile(join(core, 'package.json'), JSON.stringify({
    name: 'core', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'market', name: 'cordis:market', config: {
      connection: 'shipped', apiBaseUrl: '', installHome: home,
      registryUrl: 'https://registry.npmjs.org/', timeoutMs: 5_000,
      publisherKeys: {}, operatorKeys: {}, ...config,
    } },
    { id: 'market-tools', name: 'cordis:market-tools' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined,
    packageManager: { command: process.execPath, args: [], env: {} } }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), preparing => {
    preparing.provide('profileContext', profile)
    preparing.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    preparing.provide('approval' as never, { request: async (request: { reason: string }) => {
      behavior.reasons.push(request.reason); return behavior.approval
    } } as never)
    preparing.provide('qianshouAccount' as never, { state: async () => ({ phase: 'authenticated',
      account: { id: behavior.accountId } }) } as never)
    if (behavior.accountCarrier) preparing.provide('accountSession' as never,
      { ensureAccessToken: async () => accessToken } as never)
    Object.assign(preparing.loader.builtins, { prompt: SystemPrompt, tools: Tools,
      market: QianshouPluginCatalog, 'market-tools': MarketTools })
  })
  return { home, ctx, dispose: async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) },
    call: (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args,
      callId: ToolCallId(`reviewed-host-${name}-${Date.now()}`),
      signal: new AbortController().signal, agent: {} as never }) }
}

it('registers claim and run tools but Host denies unconfigured execution before any market write', async () => {
  const fixture = await market()
  onTestFinished(fixture.close)
  for (const overrides of [
    { connection: 'shipped' as const, apiBaseUrl: fixture.url,
      publisherKeys: fixture.publisherKeys, operatorKeys: fixture.operatorKeys },
    { connection: 'api' as const, apiBaseUrl: fixture.url,
      publisherKeys: {}, operatorKeys: fixture.operatorKeys },
    { connection: 'api' as const, apiBaseUrl: fixture.url,
      publisherKeys: fixture.publisherKeys, operatorKeys: {} },
  ]) {
    const app = await loaded(overrides, { accountId: '167', approval: 'allowed-once',
      accountCarrier: true, reasons: [] })
    try {
      expect(app.ctx.tools.get('plugin_csv_market_status')).toBeDefined()
      expect(app.ctx.tools.get('plugin_csv_market_install_free')).toBeDefined()
      expect(app.ctx.tools.get('plugin_csv_market_run_private')).toBeDefined()
      expect((await app.ctx.qianshouPluginCatalog.officialCsvSeedStatus()).phase)
        .toBe('not-configured')
      expect((await app.call('plugin_csv_market_install_free', {})).isError).toBe(true)
      expect((await app.call('plugin_csv_market_run_private', { csv: '列\n样例' })).isError).toBe(true)
    } finally { await app.dispose() }
  }
  expect(fixture.control.metadata).toBe(0)
  expect(fixture.control.checks).toBe(0)
  expect(fixture.control.claims).toBe(0)
  expect(fixture.control.legacy).toBe(0)
  expect(fixture.control.artifacts).toBe(0)
}, 60_000)

it('separates signed release and local login from the retired Cookie-only claim route', async () => {
  const fixture = await market()
  onTestFinished(fixture.close)
  fixture.control.newRouteEnabled = false
  const behavior = { accountId: '167', approval: 'allowed-once', accountCarrier: true,
    reasons: [] as string[] }
  const app = await loaded({ connection: 'api', apiBaseUrl: fixture.url,
    publisherKeys: fixture.publisherKeys, operatorKeys: fixture.operatorKeys }, behavior)
  onTestFinished(app.dispose)
  const catalog = app.ctx.qianshouPluginCatalog
  expect(await catalog.officialCsvSeedStatus()).toMatchObject({
    phase: 'claim-auth-unverified', pluginId: CSV_SEED_IDENTITY.pluginId,
    accountSignedIn: true, signedReleaseVerified: true, claimAuthChannelVerified: false,
    releaseId: CSV_SEED_IDENTITY.releaseId,
    packageSha256: CSV_SEED_IDENTITY.packageSha256,
  })
  const result = await app.call('plugin_csv_market_status', {})
  expect(result.isError).toBe(false)
  const item = result.content.find(value => value.type === 'text')
  expect(item?.type === 'text' ? JSON.parse(item.text) : null).toMatchObject({
    marketConfigReady: true, accountSignedIn: true, signedReleaseVerified: true,
    claimAuthChannelVerified: false, claimStatus: 'claim-auth-unverified',
    buyerLicenseVerified: false, dispatchable: false,
  })
  expect(app.ctx.tools.get('plugin_csv_market_install_free')).toBeDefined()
  expect(app.ctx.tools.get('plugin_csv_market_run_private')).toBeDefined()
  expect((await app.call('plugin_csv_market_install_free', {})).isError).toBe(true)
  expect((await app.call('plugin_csv_market_run_private', { csv: '列\n样例' })).isError).toBe(true)
  await expect(catalog.installOfficialCsvSeedForOwner({
    releaseId: CSV_SEED_IDENTITY.releaseId,
    packageSha256: CSV_SEED_IDENTITY.packageSha256,
  })).rejects.toThrow()
  expect(fixture.control.metadata).toBeGreaterThan(0)
  expect(fixture.control.checks).toBe(0)
  expect(fixture.control.claims).toBe(0)
  expect(fixture.control.legacy).toBe(0)
  expect(fixture.control.artifacts).toBe(0)
  expect(behavior.reasons).toEqual([])
}, 60_000)

it('keeps sign-in state separate from public release verification', async () => {
  const fixture = await market()
  onTestFinished(fixture.close)
  const app = await loaded({ connection: 'api', apiBaseUrl: fixture.url,
    publisherKeys: fixture.publisherKeys, operatorKeys: fixture.operatorKeys },
  { accountId: '167', approval: 'allowed-once', accountCarrier: false, reasons: [] })
  onTestFinished(app.dispose)
  expect((await app.ctx.qianshouPluginCatalog.officialCsvSeedStatus()).phase)
    .toBe('sign-in-required')
  expect(fixture.control.metadata).toBe(0)
  expect(fixture.control.claims).toBe(0)
}, 60_000)

it('rejects a wrong-account, malformed, unauthorized or unavailable check through both Host entry points', async () => {
  for (const kind of ['account', 'extra', 'unauthorized', 'unavailable'] as const) {
    const fixture = await market()
    try {
      if (kind === 'account') fixture.control.checkReply = { ok: true, accountId: '217',
        authMode: 'bearer-request-bound' }
      if (kind === 'extra') fixture.control.checkReply = { ok: true, accountId: '167',
        authMode: 'bearer-request-bound', cookie: true }
      if (kind === 'unauthorized') fixture.control.checkStatus = 401
      if (kind === 'unavailable') fixture.control.checkStatus = 503
      const app = await loaded({ connection: 'api', apiBaseUrl: fixture.url,
        publisherKeys: fixture.publisherKeys, operatorKeys: fixture.operatorKeys },
      { accountId: '167', approval: 'allowed-once', accountCarrier: true, reasons: [] })
      try {
        expect((await app.ctx.qianshouPluginCatalog.officialCsvSeedStatus()).phase)
          .toBe('claim-auth-unverified')
        expect((await app.call('plugin_csv_market_install_free', {})).isError).toBe(true)
        await expect(app.ctx.qianshouPluginCatalog.installOfficialCsvSeedForOwner({
          releaseId: CSV_SEED_IDENTITY.releaseId,
          packageSha256: CSV_SEED_IDENTITY.packageSha256,
        })).rejects.toThrow()
        expect(fixture.control.checks).toBeGreaterThanOrEqual(3)
        expect(fixture.control.claims).toBe(0)
        expect(fixture.control.legacy).toBe(0)
        expect(fixture.control.artifacts).toBe(0)
      } finally { await app.dispose() }
    } finally { await fixture.close() }
  }
}, 60_000)

it('loads the exact free seed through signed check, claim, artifact, owner approval and private run', async () => {
  const fixture = await market()
  onTestFinished(fixture.close)
  const behavior = { accountId: '167', approval: 'allowed-once', accountCarrier: true,
    reasons: [] as string[] }
  const app = await loaded({ connection: 'api', apiBaseUrl: fixture.url,
    publisherKeys: fixture.publisherKeys, operatorKeys: fixture.operatorKeys }, behavior)
  onTestFinished(app.dispose)
  expect((await app.ctx.qianshouPluginCatalog.officialCsvSeedStatus()).phase).toBe('ready')
  expect(fixture.control.checks).toBe(1)
  expect(fixture.control.claims).toBe(0)
  const install = await app.call('plugin_csv_market_install_free', {})
  expect(install.isError).toBe(false)
  const installedText = install.content.find(value => value.type === 'text')
  expect(installedText?.type === 'text' ? JSON.parse(installedText.text) : null).toMatchObject({
    installedForCurrentAccount: true, buyerLicenseVerified: true,
    scope: 'account-bound-private', dispatchable: false,
  })
  expect(behavior.reasons).toHaveLength(1)
  expect(fixture.control.artifacts).toBe(1)
  expect(fixture.control.legacy).toBe(0)
  const run = await app.call('plugin_csv_market_run_private', { csv: '列\n样例' })
  expect(run.isError).toBe(false)
  const resultText = run.content.find(value => value.type === 'text')
  expect(resultText?.type === 'text' ? JSON.parse(resultText.text) : null).toMatchObject({
    result: { rowCount: 1, columnCount: 1 }, buyerLicenseVerified: true,
    dispatchable: false,
  })
  expect(fixture.control.claims).toBeGreaterThanOrEqual(4)
  expect(fixture.control.artifacts).toBe(1)
}, 60_000)
