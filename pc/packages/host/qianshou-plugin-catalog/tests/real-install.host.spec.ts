/** Real profile installation through local pnpm, the Host Loader and the market Remote. */
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PluginManager from '../../../boot/plugin-manager/src/index.ts'
import { fixtureRegistry } from '../../../boot/plugin-manager/tests/fixture-registry.ts'
import QianshouPluginCatalog from '../src/index.ts'
import { declarationBytes } from '../src/preflight.ts'
import type { MarketListing } from '../src/types.ts'

async function signedMarket(): Promise<{ origin: string; publisherKeys: Record<string, string>; close(): Promise<void> }> {
  const keys = generateKeyPairSync('ed25519')
  const publisher = 'qianshou-fixture'
  const listing: MarketListing = {
    id: 'qianshou.fixture', title: 'Fixture', summary: 'Local text statistics bundle',
    capabilityId: 'text.transform', version: '1',
    packageSpec: 'qianshou-text-tools-fixture@1.0.0', installable: true,
    requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 },
  }
  listing.requirements.signature = { kind: 'publisher', publisher,
    value: sign(null, Buffer.from(declarationBytes(listing), 'utf8'), keys.privateKey).toString('base64') }
  const server = createServer((request, response) => {
    if (request.url !== '/plugins') { response.writeHead(404).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ listings: [listing] }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('market did not bind')
  return { origin: `http://127.0.0.1:${address.port}/`,
    publisherKeys: { [publisher]: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }) }
}

it('installs a signed exact-version fixture into an isolated profile, runs it, then unloads it without publishing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-market-real-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const registry = await fixtureRegistry(join(home, 'registry'))
  onTestFinished(async () => { await registry.close() })
  const market = await signedMarket()
  onTestFinished(async () => { await market.close() })
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  await writeFile(anchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, ['core'])
  const core = join(dir, 'node_modules', 'core')
  await mkdir(core, { recursive: true })
  await writeFile(join(core, 'package.json'), JSON.stringify({
    name: 'core', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'manager', name: 'cordis:manager' }, { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'market', name: 'cordis:market', config: {
      connection: 'api', apiBaseUrl: market.origin, installHome: home, timeoutMs: 5000,
      publisherKeys: market.publisherKeys,
    } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined, packageManager: registry.packageManager }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, { manager: PluginManager, prompt: SystemPrompt, tools: Tools,
      market: QianshouPluginCatalog })
  })
  try {
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
    const report = await ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.fixture' })
    expect(report.verdict).toBe('passed')
    const record = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.fixture' })
    expect(record).toMatchObject({ id: 'qianshou.fixture', visibility: 'draft', packageSpec: 'qianshou-text-tools-fixture@1.0.0' })
    expect((await ctx.qianshouPluginCatalog.installationActivity()).records[0])
      .toMatchObject({ state: 'active', packageSpec: 'qianshou-text-tools-fixture@1.0.0' })
    expect(await ctx.pluginManager.checkBundle('qianshou-text-tools-fixture'))
      .toMatchObject({ state: 'active', version: '1.0.0', rows: [{ phase: 'active' }] })
    const result = await ctx.tools.execute({ name: 'qianshou_text_statistics', arguments: { text: 'hello' },
      callId: ToolCallId('market-real-fixture'), signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(result.value).toContain('"version":"1.0.0"')
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).capabilities[0]?.advertisable).toBe(false)
    await expect(ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.fixture', visibility: 'public', confirmPublic: true,
    })).rejects.toThrow('not-advertisable')
    const removed = await ctx.pluginManager.removeBundle('qianshou-text-tools-fixture')
    expect(removed.application).toBe('applied')
    expect((await ctx.pluginManager.checkBundle('qianshou-text-tools-fixture')).state).toBe('missing')
    expect(ctx.tools.get('qianshou_text_statistics')).toBeUndefined()
    expect((await ctx.qianshouPluginCatalog.installed()).records[0]?.visibility).toBe('draft')
    expect((await ctx.qianshouPluginCatalog.installationActivity()).records[0])
      .toMatchObject({ state: 'inactive', packageSpec: 'qianshou-text-tools-fixture@1.0.0' })
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).capabilities[0])
      .toMatchObject({ activity: 'inactive', advertisable: false, record: { visibility: 'draft' } })
    expect(registry.requests).toContain('/qianshou-text-tools-fixture/-/qianshou-text-tools-fixture-1.0.0.tgz')
  } finally {
    await ctx.fiber.dispose()
  }
}, 90_000)
