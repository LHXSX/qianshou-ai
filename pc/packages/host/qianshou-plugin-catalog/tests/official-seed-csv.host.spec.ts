/** Real Host Loader/profile scope: bundled seed install, one-shot approval, and CSV execution. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { HostPluginSampleAdapter } from '@deepseek-ai/dsh-compute-core'
import QianshouPluginCatalog from '../src/index.ts'
import * as CsvTools from '../src/official-seed-csv-tools.ts'

it('loads only the scoped CSV tools, obtains real Host approval, installs and runs in one profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-csv-host-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  await writeFile(anchor, '{"name":"csv-seed-host","dependencies":{}}\n')
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
      registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000, publisherKeys: {}, operatorKeys: {},
    } },
    { id: 'csv-tools', name: 'cordis:csv-tools' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined,
    packageManager: { command: process.execPath, args: [], env: {} } }
  const approvals: string[] = []
  const sampleAdapters = new Set<HostPluginSampleAdapter>()
  let allow = false
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (preparing) => {
    preparing.provide('profileContext', profile)
    preparing.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    preparing.provide('approval' as never, { request: async (request: { reason: string }) => {
      approvals.push(request.reason)
      return allow ? 'allowed-once' : 'rejected'
    } } as never)
    preparing.provide('computeCore' as never, {
      listPrivatePluginActivations: async () => [{
        pluginId: 'owner.text-check', displayName: '文字核对', version: '1.0.0',
        packageSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64),
        draftId: 'plugin_draft_example', draftUpdatedAt: '2026-09-24T00:00:00.000Z',
        installedAt: '2026-09-24T00:01:00.000Z',
        operations: [{ operationId: 'text.check', adapterId: 'owner.text-host', adapterVersion: '1.0.0' }],
        state: 'unavailable-private', scope: 'private-local', dispatchable: false, publishable: false,
      }],
      registerHostPluginSampleAdapter: (adapter: HostPluginSampleAdapter) => {
        sampleAdapters.add(adapter)
        return () => { sampleAdapters.delete(adapter) }
      },
    } as never)
    Object.assign(preparing.loader.builtins, { prompt: SystemPrompt, tools: Tools,
      market: QianshouPluginCatalog, 'csv-tools': CsvTools })
  })
  const call = (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args,
    callId: ToolCallId(`csv-host-${name}-${Date.now()}`),
    signal: new AbortController().signal, agent: {} as never })
  try {
    expect(await ctx.qianshouPluginCatalog.privatePluginActivations()).toMatchObject({
      status: 'available', records: [{ pluginId: 'owner.text-check', state: 'unavailable-private',
        dispatchable: false, publishable: false }],
    })
    const startersBefore = await ctx.qianshouPluginCatalog.reviewedLocalStarters()
    expect(startersBefore.items.find(item => item.kind === 'csv-profile')).toEqual({
      kind: 'csv-profile', phase: 'available',
    })
    expect(startersBefore.items.find(item => item.kind === 'mac-drawn-video')).toMatchObject({
      kind: 'mac-drawn-video', phase: 'unavailable',
    })
    expect(ctx.tools.get('plugin_csv_profile_status')).toBeDefined()
    expect(ctx.tools.get('plugin_csv_profile_install_private')).toBeDefined()
    expect(ctx.tools.get('plugin_csv_profile_run_private')).toBeDefined()
    expect(sampleAdapters.size).toBe(0)
    expect((await call('plugin_csv_profile_run_private', { csv: '城市,人数\n上海,3' })).isError).toBe(true)
    expect((await call('plugin_csv_profile_install_private', {})).isError).toBe(true)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toContain('不购买、不发布、不接上海订单')
    expect((await ctx.qianshouPluginCatalog.installed()).records).toEqual([])
    allow = true
    const installed = await call('plugin_csv_profile_install_private', {})
    expect(installed.isError).toBe(false)
    const receipt = installed.content.find(item => item.type === 'text')
    expect(receipt?.type === 'text' ? JSON.parse(receipt.text) : null).toMatchObject({
      installedForOfflinePrivateTrial: true, samplePassed: true,
      marketAcquired: false, buyerLicenseVerified: false, dispatchable: false,
    })
    expect([...sampleAdapters].map(adapter => adapter.contract.bindingKind)).toEqual(['tool'])
    const result = await call('plugin_csv_profile_run_private', {
      csv: '城市,人数,备注\n上海,3,已完成\n广州,2,待确认\n', sampleRows: 2,
    })
    expect(result.isError).toBe(false)
    const output = result.content.find(item => item.type === 'text')
    expect(output?.type === 'text' ? JSON.parse(output.text) : null).toMatchObject({
      marketAcquired: false, buyerLicenseVerified: false, dispatchable: false,
      result: { rowCount: 2, columnCount: 3, sampleRows: [
        ['上海', '3', '已完成'], ['广州', '2', '待确认'] ] },
    })
    expect((await ctx.qianshouPluginCatalog.installed()).records).toEqual([])
    expect((await ctx.qianshouPluginCatalog.reviewedLocalStarters()).items
      .find(item => item.kind === 'csv-profile')).toEqual({
      kind: 'csv-profile', phase: 'installed',
    })
    const record = JSON.parse(await readFile(join(home, 'qianshou', 'private-seed-csv',
      'qianshou.csv-profile-1.0.0.json'), 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({ scope: 'private-local', dispatchable: false })
    await writeFile(join(home, 'qianshou', 'private-seed-csv',
      'qianshou.csv-profile-1.0.0.json'), '{}')
    expect((await ctx.qianshouPluginCatalog.reviewedLocalStarters()).items
      .find(item => item.kind === 'csv-profile')).toEqual({
      kind: 'csv-profile', phase: 'unavailable', reason: 'installation-needs-repair',
    })
  } finally { await ctx.fiber.dispose() }
}, 30_000)
