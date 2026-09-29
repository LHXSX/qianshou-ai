/** Real fixed-version package install, Host executor registration, local run, and removal. */
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import PluginManager from '../src/index.ts'
import { fixtureRegistry } from './fixture-registry.ts'
import * as ComputeCore from '../../../host/compute-core/src/index.ts'
import { createMacDrawnVideoFactory } from '../../../host/compute-core/src/mac-drawn-video-factory.ts'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../../../host/compute-core/src/protocol.ts'
import QianshouPluginCatalog from '../../../host/qianshou-plugin-catalog/src/index.ts'
import { declarationBytes } from '../../../host/qianshou-plugin-catalog/src/preflight.ts'
import type { MarketListing } from '../../../host/qianshou-plugin-catalog/src/types.ts'

const capabilityId = ComputeCapabilityId('video.drawn-mac-5s')
const packageName = 'qianshou-mac-drawn-video-fixture'
const macVideoAvailable = createMacDrawnVideoFactory().available

it.skipIf(macVideoAvailable)('refuses Mac video execution when macOS, Swift, or a trusted ffmpeg/ffprobe pair is unavailable', () => {
  const factory = createMacDrawnVideoFactory()
  expect(factory.available).toBe(false)
  expect(() => factory.create()).toThrow('COMPUTE_DRAWN_VIDEO_TOOL_UNAVAILABLE')
})

it.skipIf(!macVideoAvailable)('installs a signed Mac video listing, runs its executor, then withdraws it on removal (requires macOS, Swift, and trusted ffmpeg/ffprobe)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-video-bundle-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const registry = await fixtureRegistry(join(home, 'registry'))
  onTestFinished(async () => { await registry.close() })
  const publisher = generateKeyPairSync('ed25519')
  const listing: MarketListing = {
    id: 'qianshou.mac-drawn-video', title: 'Mac 五秒绘图视频', summary: 'Local fixed template',
    capabilityId: String(capabilityId), version: '0.1.0', packageSpec: `${packageName}@0.1.0`,
    installable: true,
    requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0,
      minTotalMemoryBytes: 0, platforms: ['darwin'] },
  }
  listing.requirements.signature = { kind: 'publisher', publisher: 'qianshou-video-fixture',
    value: sign(null, Buffer.from(declarationBytes(listing)), publisher.privateKey).toString('base64') }
  const marketServer = createServer((request, response) => {
    if (request.url !== '/plugins') { response.writeHead(404).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ listings: [listing] }))
  })
  await new Promise<void>((resolve) => { marketServer.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => { marketServer.closeAllConnections(); await new Promise<void>(resolve => marketServer.close(() => resolve())) })
  const address = marketServer.address()
  if (address === null || typeof address === 'string') throw new Error('market did not bind')
  const marketOrigin = `http://127.0.0.1:${address.port}/`
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  await writeFile(anchor, '{"name":"video-installation","dependencies":{}}\n')
  initProfile(dir, ['core'])
  const core = join(dir, 'node_modules', 'core')
  await mkdir(core, { recursive: true })
  await writeFile(join(core, 'package.json'), JSON.stringify({
    name: 'core', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'connection', name: 'cordis:connection' },
    { id: 'compute', name: 'cordis:compute', config: { statePath: join(home, 'compute-plans.json') } },
    { id: 'manager', name: 'cordis:manager' },
    { id: 'market', name: 'cordis:market', config: { connection: 'api', apiBaseUrl: marketOrigin,
      installHome: home, timeoutMs: 5000, publisherKeys: { 'qianshou-video-fixture':
        publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') } } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined, packageManager: registry.packageManager }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (preparing) => {
    preparing.provide('profileContext', profile)
    preparing.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(preparing.loader.builtins, {
      connection: { apply(connectionCtx: typeof preparing) {
        connectionCtx.provide('connection', { fetch: { register: () => () => {} } } as never)
      } },
      compute: ComputeCore, manager: PluginManager, market: QianshouPluginCatalog,
    })
  })
  try {
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
    expect(ctx.macDrawnVideoFactory.available).toBe(true)
    expect(ctx.computeCore.executors.list()).not.toContainEqual(expect.objectContaining({ capabilityId }))
    expect((await ctx.qianshouPluginCatalog.preflight({ id: listing.id })).verdict).toBe('passed')
    const installed = await ctx.qianshouPluginCatalog.install({ id: listing.id })
    expect(installed).toMatchObject({ packageSpec: `${packageName}@0.1.0`, visibility: 'draft',
      inviteAccountIds: [] })
    expect(await ctx.pluginManager.checkBundle(packageName)).toMatchObject({ state: 'active', version: '0.1.0' })
    expect((await ctx.qianshouPluginCatalog.installationActivity()).records[0]).toMatchObject({ state: 'active' })
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).capabilities[0])
      .toMatchObject({ activity: 'active', advertisable: false })
    await expect(ctx.qianshouPluginCatalog.publishCapability({ id: listing.id, visibility: 'public',
      confirmPublic: true })).rejects.toThrow('not-advertisable')
    expect(ctx.computeCore.executors.resolve(capabilityId, '0.1.0')).toMatchObject({ capabilityId, version: '0.1.0' })
    const workspacePath = join(home, 'task-workspace')
    await mkdir(workspacePath)
    const task: ComputeTaskEnvelope = {
      version: 'qianshou.task.v1', taskId: ComputeTaskId('installed-video-local-test'), capabilityId,
      capabilityVersion: '0.1.0', inputRefs: [], parameters: { title: '海边骑车', subtitle: '沿着海岸出发' },
      deadlineAt: new Date(Date.now() + 180_000).toISOString(), maxOutputBytes: 20 * 1024 * 1024,
      idempotencyKey: 'installed-video-local-test-once',
    }
    const result = await ctx.computeCore.executors.execute(task, {
      signal: new AbortController().signal, workspacePath, inputs: [], interactionPolicy: 'autonomous',
      reportProgress: () => undefined,
    })
    expect(result.metadata).toMatchObject({ mediaType: 'video/mp4', durationSeconds: '5', renderer: 'macos-appkit-drawing' })
    expect(result.outputs).toHaveLength(1)
    const output = result.outputs[0]!
    expect((await stat(output.path)).size).toBe(output.bytes)
    expect((await readFile(output.path)).subarray(4, 8).toString('ascii')).toBe('ftyp')
    const removed = await ctx.pluginManager.removeBundle(packageName)
    expect(removed.application).toBe('applied')
    expect((await ctx.pluginManager.checkBundle(packageName)).state).toBe('missing')
    expect(() => ctx.computeCore.executors.resolve(capabilityId, '0.1.0')).toThrow('COMPUTE_EXECUTOR_UNAVAILABLE')
    expect((await ctx.qianshouPluginCatalog.installationActivity()).records[0]).toMatchObject({ state: 'inactive' })
    expect(registry.requests).toContain(`/${packageName}/-/${packageName}-0.1.0.tgz`)
  } finally { await ctx.fiber.dispose() }
}, 240_000)
