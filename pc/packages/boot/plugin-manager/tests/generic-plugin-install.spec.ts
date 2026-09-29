/** A new operation family can be installed and executed without a built-in workflow template. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PluginManager from '../src/index.ts'

const bundlePath = fileURLToPath(new URL('../../../../qianshou/plugins/legal-preflight/', import.meta.url))

it('installs, activates, calls and removes a generated category through the real Host', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-generic-plugin-'))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const dir = join(home, 'profiles', 'test')
    const anchor = join(home, 'package.json')
    await writeFile(anchor, '{"name":"generic-plugin-test","dependencies":{}}\n')
    initProfile(dir, ['core'])
    const core = join(dir, 'node_modules', 'core')
    await mkdir(core, { recursive: true })
    await writeFile(join(core, 'package.json'), JSON.stringify({ name: 'core', version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'manager', name: 'cordis:manager' }, { id: 'prompt', name: 'cordis:prompt' },
      { id: 'tools', name: 'cordis:tools' },
    ] }]))
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
    const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir,
      patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
      overlays: [], telemetryDisabledEnv: undefined,
      packageManager: { command: process.execPath, args: ['--expose-internals', pnpm,
        '--config.store-dir=' + join(home, 'pnpm-store')],
      env: { npm_config_manage_package_manager_versions: 'false', npm_config_offline: 'true' } } }
    ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (scope) => {
      scope.provide('profileContext', profile)
      scope.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      Object.assign(scope.loader.builtins, { manager: PluginManager, prompt: SystemPrompt, tools: Tools })
    })
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
    const manager = ctx.pluginManager
    const inspection = await manager.inspect(bundlePath)
    expect(inspection, JSON.stringify(inspection)).toMatchObject({ status: 'accepted', kind: 'path',
      name: 'qianshou-legal-preflight', bundle: true })
    expect(await manager.installBundle(bundlePath, { enabled: false })).toMatchObject({
      application: 'applied', bundle: 'qianshou-legal-preflight' })
    expect(ctx.tools.get('qianshou_legal_redact')).toBeUndefined()
    expect(await manager.setBundleEnabled('qianshou-legal-preflight', true)).toMatchObject({ application: 'applied' })
    expect(await manager.checkBundle('qianshou-legal-preflight')).toMatchObject({
      state: 'active', rows: [{ phase: 'active' }] })
    const call = (name: string, args: unknown, id: string) => ctx!.tools.execute({ name,
      arguments: args, callId: ToolCallId(id), signal: new AbortController().signal })
    const redacted = await call('qianshou_legal_redact', { text: '电话 13800138000' }, 'redact')
    expect(redacted.isError).toBe(false)
    expect(JSON.parse(String(redacted.value))).toMatchObject({ redacted: '电话 138****8000', hitCount: 1 })
    const terms = await call('qianshou_legal_terms', { text: '定金与订金' }, 'terms')
    expect(terms.isError).toBe(false)
    expect(JSON.parse(String(terms.value))).toMatchObject({ termCount: 2 })
    const date = await call('qianshou_calendar_add', { startDate: '2028-02-28', durationDays: 2 }, 'date')
    expect(date.isError).toBe(false)
    expect(JSON.parse(String(date.value))).toMatchObject({ date: '2028-03-01', approximate: true })
    const invalid = await call('qianshou_calendar_add', { startDate: '2028-02-30', durationDays: 1 }, 'invalid-date')
    expect(invalid.isError).toBe(true)
    expect(await manager.removeBundle('qianshou-legal-preflight')).toMatchObject({ application: 'applied' })
    expect(ctx.tools.get('qianshou_legal_redact')).toBeUndefined()
  } finally {
    await ctx?.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
