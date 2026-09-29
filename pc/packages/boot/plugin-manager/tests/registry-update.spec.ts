/** Real pnpm registry replacement against self-owned, local-only archives. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PluginManager from '../src/index.ts'
import { fixtureRegistry } from './fixture-registry.ts'

it('installs a real tool, keeps its loaded generation during a pinned replacement, and unloads on removal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'plugin-registry-update-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const registry = await fixtureRegistry(join(home, 'registry'))
  onTestFinished(async () => { await registry.close() })
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  await writeFile(anchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, ['core'])
  const core = join(dir, 'node_modules', 'core')
  await mkdir(core, { recursive: true })
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: 'core', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'manager', name: 'cordis:manager' }, { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: anchor, cwd: home, home, overlays: [], telemetryDisabledEnv: undefined, packageManager: registry.packageManager }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, { manager: PluginManager, prompt: SystemPrompt, tools: Tools })
  })
  try {
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
    const manager = ctx.pluginManager
    const name = 'qianshou-text-tools-fixture'
    const installed = await manager.installBundle(`${name}@1.0.0`, { enabled: false })
    expect(installed, JSON.stringify(installed)).toMatchObject({ application: 'applied', bundle: name })
    expect(ctx.tools.get('qianshou_text_statistics')).toBeUndefined()
    expect(await manager.setBundleEnabled(name, true)).toMatchObject({ application: 'applied' })
    const call = () => ctx.tools.execute({ name: 'qianshou_text_statistics', arguments: { text: 'hello' },
      callId: ToolCallId('real-registry-tool'), signal: new AbortController().signal })
    const first = await call()
    expect(first.isError).toBe(false)
    expect(first.value).toContain('"version":"1.0.0"')
    expect(await manager.checkBundle(name)).toMatchObject({ state: 'active', rows: [{ phase: 'active' }] })
    const inspected = await manager.inspectUpdate(name, `${name}@latest`)
    if (inspected.status !== 'accepted') throw new Error(JSON.stringify(inspected))
    expect(inspected.target.spec).toBe(`${name}@2.0.0`)
    registry.setLatest(name, '1.0.0')
    expect(await manager.updateBundle(inspected.inspectionId)).toMatchObject({ application: 'restart-required', bundle: name })
    const saved = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
    expect(saved.dependencies[name]).toBe('2.0.0')
    expect(saved.dsh.profile.bundles).toContain(name)
    expect((await call()).value).toContain('"version":"1.0.0"')
    const removed = await manager.removeBundle(name)
    expect(removed, JSON.stringify(removed)).toMatchObject({ application: 'applied' })
    expect(ctx.tools.get('qianshou_text_statistics')).toBeUndefined()
    expect(registry.requests).toContain(`/${name}/-/qianshou-text-tools-fixture-2.0.0.tgz`)
    const beforeBadManifest = await readFile(join(dir, 'package.json'), 'utf8')
    const beforeBadLock = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')
    const bad = await manager.installBundle('qianshou-not-bundle-fixture@1.0.0')
    expect(bad, JSON.stringify(bad)).toMatchObject({ application: 'failed', error: { code: 'not-bundle' } })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(beforeBadManifest)
    expect(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(beforeBadLock)
    const failedName = 'qianshou-activation-failure-fixture'
    const failed = await manager.installBundle(`${failedName}@1.0.0`)
    expect(failed, JSON.stringify(failed)).toMatchObject({ application: 'failed', stage: 'enable', bundle: failedName })
    expect(await manager.checkBundle(failedName)).toMatchObject({ state: 'failed', selected: true, rows: [{ phase: 'failed' }] })
    expect(await manager.removeBundle(failedName)).toMatchObject({ application: 'applied' })
  } finally {
    await ctx.fiber.dispose()
  }
}, 60_000)
