/** Save a private draft, build its allowlisted bundle, then install and call it in a disposable profile. */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { LocalPluginCandidateBuilder } from '@deepseek-ai/dsh-compute-core/src/plugin-candidate.ts'
import { LocalPluginDraftStore } from '@deepseek-ai/dsh-compute-core/src/plugin-draft.ts'
import * as PluginDraftTools from '@deepseek-ai/dsh-compute-core/src/plugin-draft-tools.ts'
import QianshouPluginCatalog from '../../../host/qianshou-plugin-catalog/src/index.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PluginManager from '../src/index.ts'

it('creates through the conversation tool, installs, enables and calls one private local candidate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'plugin-candidate-install-'))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  let drafts: LocalPluginDraftStore | undefined
  try {
    drafts = new LocalPluginDraftStore({ path: join(home, 'drafts.json'), maxDrafts: 2, maxBytes: 131072 })
    const candidates = new LocalPluginCandidateBuilder(drafts, join(home, 'candidates'))
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
    const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
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
    ctx.provide('computeCore', {
      saveLocalPluginDraft: (value: unknown) => drafts!.save(value),
      localPluginDrafts: () => drafts!.list(),
      prepareLocalPluginCandidate: (id: unknown) => candidates.prepare(id),
      listLocalPluginCandidates: () => candidates.list(),
    })
    await ctx.plugin(PluginDraftTools)
    await ctx.plugin(QianshouPluginCatalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
      connection: 'shipped', apiBaseUrl: '', installHome: home, publisherKeys: {} })
    const created = await ctx.tools.execute({ name: 'plugin_text_statistics_create',
      arguments: { displayName: '文字统计' }, agent: {} as never,
      callId: ToolCallId('conversation-create-candidate'), signal: new AbortController().signal })
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('conversation creation tool failed')
    const candidate = JSON.parse(String(created.value)) as {
      state: string; draftId: string; packagePath: string; packageName: string; packageDigest: string; toolName: string;
      installed: boolean; enabled: boolean; published: boolean; dispatchable: boolean;
    }
    expect(candidate).toMatchObject({ state: 'private-candidate', installed: false,
      enabled: false, published: false, dispatchable: false })
    expect(await candidates.list()).toMatchObject([{ packageName: candidate.packageName,
      toolName: candidate.toolName, displayName: '文字统计', orderAdapter: {
        taskType: 'word_count', inputKind: 'inline', outputKind: 'inline_json' } }])
    const checkRequest = { draftId: candidate.draftId, packageDigest: candidate.packageDigest }
    const authorDraft = await ctx.qianshouPluginCatalog.saveLocalOrderPublicationDraft({
      ...checkRequest, name: '词频助手', purpose: '汇总文本中的词频', category: 'text',
      configuration: '无需密钥，仅接受文本输入。', salePriceYuan: '2.50' })
    expect(authorDraft).toMatchObject({ state: 'local-draft', salePriceYuan: '2.50',
      taskContract: { taskType: 'word_count', inputKind: 'inline', outputKind: 'inline_json' } })
    expect(await ctx.qianshouPluginCatalog.localOrderPublicationDraft(checkRequest)).toEqual(authorDraft)
    expect(await ctx.qianshouPluginCatalog.checkLocalCandidateInstall(checkRequest))
      .toMatchObject({ matched: false, reason: 'not-installed' })

    const manager = ctx.pluginManager
    expect(await manager.inspect(candidate.packagePath)).toMatchObject({ status: 'accepted', kind: 'path',
      name: candidate.packageName, bundle: true })
    const installed = await manager.installBundle(candidate.packagePath, { enabled: false })
    expect(installed, JSON.stringify(installed)).toMatchObject({
      application: 'applied', bundle: candidate.packageName })
    expect(await ctx.qianshouPluginCatalog.checkLocalCandidateInstall(checkRequest))
      .toMatchObject({ matched: true, reason: 'matched' })
    expect(ctx.tools.get(candidate.toolName)).toBeUndefined()
    expect(await manager.setBundleEnabled(candidate.packageName, true)).toMatchObject({ application: 'applied' })
    expect(await manager.checkBundle(candidate.packageName)).toMatchObject({ state: 'active', rows: [{ phase: 'active' }] })
    const result = await ctx.tools.execute({ name: candidate.toolName, arguments: { text: '你好\n世界' },
      callId: ToolCallId('candidate-real-call'), signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(JSON.parse(String(result.value))).toEqual({ characters: 5, utf8Bytes: 13, nonemptyLines: 2,
      sha256: createHash('sha256').update('你好\n世界').digest('hex'),
      wordCounts: [{ word: '你好', count: 1 }, { word: '世界', count: 1 }] })
    const removed = await manager.removeBundle(candidate.packageName)
    expect(removed, JSON.stringify(removed)).toMatchObject({ application: 'applied' })
    expect(ctx.tools.get(candidate.toolName)).toBeUndefined()
    expect(await ctx.qianshouPluginCatalog.checkLocalCandidateInstall(checkRequest))
      .toMatchObject({ matched: false, reason: 'not-installed' })

    // The second workflow has different generated logic and no order adapter.
    const reverseCreated = await ctx.tools.execute({ name: 'plugin_safe_workflow_create',
      arguments: { workflowRef: 'qianshou:text-reverse-v1', displayName: '文本反转' }, agent: {} as never,
      callId: ToolCallId('conversation-create-reverse'), signal: new AbortController().signal })
    expect(reverseCreated.isError).toBe(false)
    if (reverseCreated.isError) throw new Error('reverse creation tool failed')
    const reverse = JSON.parse(String(reverseCreated.value)) as { packagePath: string; packageName: string;
      toolName: string; draftId: string }
    expect((await candidates.list()).find(item => item.draftId === reverse.draftId)?.orderAdapter).toBeUndefined()
    expect(await manager.inspect(reverse.packagePath)).toMatchObject({ status: 'accepted', kind: 'path',
      name: reverse.packageName, bundle: true })
    expect(await manager.installBundle(reverse.packagePath, { enabled: false })).toMatchObject({ application: 'applied' })
    expect(await manager.setBundleEnabled(reverse.packageName, true)).toMatchObject({ application: 'applied' })
    const reversed = await ctx.tools.execute({ name: reverse.toolName, arguments: { text: '千手 AI' },
      callId: ToolCallId('reverse-real-call'), signal: new AbortController().signal })
    expect(reversed.isError).toBe(false)
    expect(JSON.parse(String(reversed.value))).toEqual({ reversed: 'IA 手千' })
    expect(await manager.removeBundle(reverse.packageName)).toMatchObject({ application: 'applied' })
  } finally {
    await ctx?.fiber.dispose()
    await drafts?.close()
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
