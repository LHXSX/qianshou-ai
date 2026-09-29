/** Real disposable Host composition: a generated candidate reaches the order agent only after owner pinning. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createIsolatedInlineRunner } from '@deepseek-ai/dsh-compute-core'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalPluginCandidateBuilder } from '../../../packages/host/compute-core/src/plugin-candidate.ts'
import { LocalPluginDraftStore } from '../../../packages/host/compute-core/src/plugin-draft.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import PluginManager from '../../../packages/boot/plugin-manager/src/index.ts'
import {
  createLocalTextStatisticsOrderRunner,
  installedLocalPluginDigest,
  resolveLocalTextStatisticsOrderBinding,
  type LocalTextStatisticsOrderHost,
} from '../../../packages/host/node-contributor/src/local-plugin-order.ts'
import { apply as applyNodeContributor, type NodeContributorService } from '../../../packages/host/node-contributor/src/plugin.ts'
import { loadOrderExecutorSelection } from '../../../packages/host/node-contributor/src/order-executor-selection.ts'
import { createOrderAcceptanceAgent } from '../order-agent.ts'

it.each(['qianshou:text-statistics-v1', 'qianshou:text-statistics-v2', 'external-v2'] as const)(
  'installs %s in a disposable Host and checks its exact word_count eligibility', async (ref) => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-order-plugin-install-'))
  const v2 = ref !== 'qianshou:text-statistics-v1'
  const external = ref === 'external-v2'
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  let drafts: LocalPluginDraftStore | undefined
  try {
    drafts = new LocalPluginDraftStore({ path: join(home, 'drafts.json'), maxDrafts: 2, maxBytes: 131072 })
    const draft = await drafts.save({ spec: {
      pluginId: 'owner.order-test', version: v2 ? '2.0.0' : '1.0.0', displayName: '接单文字统计', operations: [{
        id: 'owner.order-test.count', title: '统计文字', description: '统计字符、字节、非空行和摘要',
        binding: { kind: 'workflow', ref: external ? 'qianshou:text-statistics-v2' : ref },
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { characters: { type: 'integer' }, utf8Bytes: { type: 'integer' },
          nonemptyLines: { type: 'integer' }, sha256: { type: 'string' },
          ...(v2 ? { wordCounts: { type: 'array', items: { type: 'object', properties: {
            word: { type: 'string' }, count: { type: 'integer' },
          }, required: ['word', 'count'], additionalProperties: false } } } : {}) },
          required: [...['characters', 'utf8Bytes', 'nonemptyLines', 'sha256'], ...(v2 ? ['wordCounts'] : [])], additionalProperties: false },
        permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
        resources: { minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 65536,
          maxOutputBytes: v2 ? 262144 : 1024, maxRunMs: 1000 },
      }],
    } })
    const candidate = await new LocalPluginCandidateBuilder(drafts, join(home, 'candidates')).prepare(draft.id)
    expect(candidate.dispatchable).toBe(false)
    let packagePath = candidate.packagePath
    let packageName = candidate.packageName
    if (external) {
      // The adapter declaration and bytes matter; its origin and generated package name do not.
      packageName = '@vendor/wordfreq'
      packagePath = join(home, 'vendor-package')
      await mkdir(packagePath)
      const manifest = JSON.parse(await readFile(join(candidate.packagePath, 'package.json'), 'utf8')) as Record<string, unknown>
      manifest.name = packageName
      delete manifest.qianshouWorkflowRef
      await writeFile(join(packagePath, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      await writeFile(join(packagePath, 'cordis.patch.yml'), JSON.stringify([
        { insert: [{ id: 'vendor-wordfreq', name: packageName }] },
      ]))
      await writeFile(join(packagePath, 'index.js'),
        (await readFile(join(candidate.packagePath, 'index.js'), 'utf8')).replaceAll(candidate.packageName, packageName))
      await writeFile(join(packagePath, 'README.md'), 'Independent vendor package; no draft marker.\n')
    }
    const dir = join(home, 'profiles', 'test')
    const anchor = join(home, 'package.json')
    await writeFile(anchor, '{"name":"installation","dependencies":{}}\n')
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
    const pnpm = fileURLToPath(new URL('../../desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
    const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: anchor, cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
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
    expect(await manager.inspect(packagePath)).toMatchObject({ status: 'accepted', bundle: true })
    const installed = await manager.installBundle(packagePath, { enabled: false })
    if (installed.application !== 'applied') throw new Error(JSON.stringify(installed))
    expect(await manager.setBundleEnabled(packageName, true)).toMatchObject({ application: 'applied' })
    const binding = resolveLocalTextStatisticsOrderBinding(external ? {
      packageName, toolName: candidate.toolName,
      packageDigest: (await installedLocalPluginDigest(dir, packageName)) ?? '',
    } : candidate)
    if (binding === null) throw new Error('missing owner binding')
    const installedHost: LocalTextStatisticsOrderHost = {
      profileDir: () => dir,
      manager: () => manager,
      tools: () => ctx?.tools,
    }
    ctx.provide('connection', { fetch: { register: () => () => undefined } })
    const ownerPolicy = { mode: 'idle', enabledServiceIds: [] as string[] }
    ctx.provide('computeCore', { ownerSupplyPolicy: async () => ownerPolicy })
    applyNodeContributor(ctx, { mode: 'BACKGROUND_ONLY', autoStart: false,
      allowedTaskTypes: ['word_count'],
      isolatedProvider: 'qianshou-cloud', isolatedModel: '千手·迅捷',
      ...(external ? {} : {
        localTextStatisticsPackageName: binding.packageName,
        localTextStatisticsToolName: binding.toolName,
        localTextStatisticsPackageDigest: binding.packageDigest,
      }),
      storePath: join(home, 'node-tasks.json'), workspaceRoot: home })
    const contributor = ctx.get('nodeContributor') as NodeContributorService
    if (external) {
      expect(contributor.orderExecutor()).toEqual({ kind: 'builtin' })
      expect(await contributor.canEnableLocalService('node')).toBe(false)
      expect(await contributor.canSelectOrderBundle(packageName)).toBe(true)
      expect(await contributor.selectOrderExecutor({ kind: 'plugin', packageName })).toEqual({ kind: 'plugin', packageName })
      expect(loadOrderExecutorSelection(dir, { kind: 'builtin' })).toEqual({
        valid: true, fromSelectionFile: true, selection: { kind: 'plugin', binding },
      })
      ownerPolicy.enabledServiceIds = ['node']
      await expect(contributor.selectOrderExecutor({ kind: 'builtin' }))
        .rejects.toThrow('COMPUTE_ORDER_EXECUTOR_SERVICE_ENABLED')
      expect(contributor.orderExecutor()).toEqual({ kind: 'plugin', packageName })
      ownerPolicy.enabledServiceIds = []
    }
    expect(await contributor.canEnableLocalService('node')).toBe(v2)
    const local = await ctx.tools.execute({ name: candidate.toolName, arguments: { text: '你好\n世界' },
      callId: ToolCallId('local-character-statistics'), signal: new AbortController().signal })
    expect(local.isError).toBe(false)
    if (local.isError) throw new Error('installed local tool failed')
    expect(JSON.parse(local.value as string)).toMatchObject({ characters: 5, nonemptyLines: 2 })
    if (v2) expect(JSON.parse(local.value as string)).toMatchObject({ wordCounts: [
      { word: '你好', count: 1 }, { word: '世界', count: 1 },
    ] })
    const runner = createLocalTextStatisticsOrderRunner(binding, installedHost, createIsolatedInlineRunner())
    const sent: string[] = []
    const agent = createOrderAcceptanceAgent({
      policy: { capabilityMode: 'builtin', authorizedTaskTypes: ['word_count'] }, runner,
      courier: { deliver: async (input) => { sent.push(input.verifiedText); return { accepted: true, reference: 'local-test' } } },
    })
    const firstWorkspace = join(home, 'attempt-1')
    await mkdir(firstWorkspace)
    const offer = { shardId: 'shard-plugin-order', attempt: 1, taskType: 'word_count', inlineInput: '你好\n世界' }
    const accepted = await agent.handleOffer(offer, { workspacePath: firstWorkspace,
      signal: new AbortController().signal, startedAtMs: Date.now() })
    expect(accepted.delivered).toBe(v2)
    expect(sent).toHaveLength(v2 ? 1 : 0)
    if (v2) expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({ task_type: 'word_count',
      result_lines: ['你好\t1', '世界\t1'] })
    expect(await manager.setBundleEnabled(packageName, false)).toMatchObject({ application: 'applied' })
    expect(await contributor.canEnableLocalService('node')).toBe(false)
    const secondWorkspace = join(home, 'attempt-2')
    await mkdir(secondWorkspace)
    const refused = await agent.handleOffer({ ...offer, shardId: 'shard-plugin-disabled', attempt: 2 },
      { workspacePath: secondWorkspace, signal: new AbortController().signal, startedAtMs: Date.now() })
    expect(refused.delivered).toBe(false)
    expect(sent).toHaveLength(v2 ? 1 : 0)
    if (external) {
      // A new Host process must recover the exact saved choice from profileContext,
      // then recheck the installed bundle instead of silently reverting to builtin.
      expect(await manager.setBundleEnabled(packageName, true)).toMatchObject({ application: 'applied' })
      await ctx.fiber.dispose()
      ctx = undefined
      ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (scope) => {
        scope.provide('profileContext', profile)
        scope.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
        Object.assign(scope.loader.builtins, { manager: PluginManager, prompt: SystemPrompt, tools: Tools })
      })
      await ctx.plugin(Timer)
      await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
      await ctx.hmr.runExclusive(async () => {})
      expect((ctx.get('profileContext') as ProfileContext).dir).toBe(dir)
      ctx.provide('connection', { fetch: { register: () => () => undefined } })
      ctx.provide('computeCore', { ownerSupplyPolicy: async () => ownerPolicy })
      applyNodeContributor(ctx, { mode: 'BACKGROUND_ONLY', autoStart: false,
        allowedTaskTypes: ['word_count'], isolatedProvider: 'qianshou-cloud', isolatedModel: '千手·迅捷',
        storePath: join(home, 'node-tasks-restarted.json'), workspaceRoot: home })
      const restarted = ctx.get('nodeContributor') as NodeContributorService
      expect(restarted.orderExecutor()).toEqual({ kind: 'plugin', packageName })
      expect(await restarted.canEnableLocalService('node')).toBe(true)
    }
  } finally {
    await ctx?.fiber.dispose()
    await drafts?.close()
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
