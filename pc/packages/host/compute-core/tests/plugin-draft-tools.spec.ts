import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { LocalPluginDraftStore } from '../src/plugin-draft.ts'
import { ComputeDraftStore } from '../src/store.ts'
import { ComputeService } from '../src/service.ts'
import { ComfyPrivateTrialLedger } from '../src/comfy-private-trial-ledger.ts'
import { PrivateComfyTrialHost } from '../src/comfy-private-trial.ts'
import { ComputeError } from '../src/errors.ts'
import * as PluginDraftTools from '../src/plugin-draft-tools.ts'
import { MAC_VIDEO_DRAFT_TEMPLATE } from '../src/private-mac-video-draft-package.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const schema = { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false }
const spec = {
  pluginId: 'owner.poster', version: '1.0.0', displayName: '海报助手',
  operations: [
    { id: 'owner.poster.draw', title: '画海报', description: '本机模型绘制海报',
      binding: { kind: 'local-model', ref: 'ollama:poster-v1' }, inputSchema: schema, outputSchema: schema,
      permissions: ['model.local'], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
      resources: { minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 1024, maxOutputBytes: 1024, maxRunMs: 1000 } },
    { id: 'owner.poster.resize', title: '调尺寸', description: '本机工作流调整尺寸',
      binding: { kind: 'workflow', ref: 'flow:resize-v1' }, inputSchema: schema, outputSchema: schema,
      permissions: [], dataScope: 'none', networkOrigins: [], dependencies: [],
      resources: { minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 1024, maxOutputBytes: 1024, maxRunMs: 1000 } },
  ],
}

describe('isolated private plugin creation tools', () => {
  it.skipIf(process.platform !== 'darwin')('installs only the saved reviewed Mac template after real Host approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-creator-install-'))
    roots.push(root)
    const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 131072 })
    const draft = await drafts.save({ spec: MAC_VIDEO_DRAFT_TEMPLATE })
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt)
    const runtime = await ctx.plugin(ToolRuntime)
    let installs = 0
    let outcome = 'rejected'
    ctx.provide('computeCore', { localPluginDrafts: () => drafts.list(), executors: {} })
    ctx.provide('profileContext' as never, { home: root, dir: join(root, 'profile') } as never)
    ctx.provide('macDrawnVideoFactory' as never, { available: true } as never)
    ctx.provide('pluginManager' as never, { listBundles: async () => [],
      installBundle: async (path: string) => { installs += 1; expect(path).toMatch(/qianshou-mac-drawn-video-0\.1\.0\.tgz$/u)
        return { application: 'restart-required', bundle: 'qianshou-mac-drawn-video' } } } as never)
    ctx.provide('approval' as never, { request: async (request: { reason: string }) => {
      expect(request.reason).toContain(draft.updatedAt)
      return outcome
    } } as never)
    const plugin = await ctx.plugin(PluginDraftTools)
    const call = async () => ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('private-install-call'), name: 'plugin_draft_install_mac_video',
      arguments: { id: draft.id, expectedUpdatedAt: draft.updatedAt }, agent: {} as never })
    try {
      expect((await call()).isError).toBe(true)
      expect(installs).toBe(0)
      outcome = 'allowed-once'
      const result = await call()
      expect(result.isError).not.toBe(true)
      const text = result.content.find(item => item.type === 'text')
      expect(text?.type === 'text' ? JSON.parse(text.text) : null)
        .toMatchObject({ state: 'restart-required', localOnly: true, dispatchable: false })
      expect(installs).toBe(1)
    } finally { await plugin.dispose(); await runtime.dispose(); await prompt.dispose(); await drafts.close() }
  })

  it('mounts observed candidates and private design tools without external order submission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-draft-tools-'))
    roots.push(root)
    const store = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 131072 })
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt)
    const runtime = await ctx.plugin(ToolRuntime)
    let draftWrites = 0
    let supplyProbes = 0
    let catalogReads = 0
    let configured = true
    let localServices = [
      { id: 'ollama:h3', kind: 'local-model', name: 'H3', verification: 'pending', reason: 'MODEL_INFERENCE_NOT_VERIFIED', privateDetail: 'not for the agent' },
      { id: 'ollama:offline', kind: 'local-model', name: 'Offline', verification: 'unavailable', reason: 'CHECK_FAILED' },
      { id: 'python3', kind: 'tool', name: 'Python', verification: 'verified', reason: null },
    ]
    let observed: { observedAt: string; localServices: typeof localServices } | null = null
    ctx.provide('computeCore', { saveLocalPluginDraft: (value: unknown) => { draftWrites += 1; return store.save(value) },
      localPluginDrafts: () => store.list(), previewLocalPluginDraft: (id: unknown) => store.preview(id),
      localPluginComfyAssetSummaries: (id: unknown) => store.comfyAssetSummaries(id),
      lastObservedSupply: () => observed,
      executors: { list: () => [{ capabilityId: 'video.drawn-mac-5s', version: '0.1.0' }] },
      listPluginAdapterBindings: () => [{ operationId: 'csv.profile', adapterId: 'qianshou.csv-host',
        adapterVersion: '1.0.0', bindingKind: 'tool', bindingRef: 'csv-profile:host-adapter',
        state: 'registered-needs-sample', sampleRequired: true,
        validUntilMs: Date.parse('2026-09-25T00:00:00.000Z') }],
      status: () => ({ configured, capabilities: { quoting: false, submission: false } }),
      capabilityDiscovery: async () => { catalogReads += 1; return {
        registry: { status: 'observed', observedAt: '2026-09-24T01:00:00.000Z', reason: null,
          registryVersion: '1.0', capabilities: [
            { capability: 'media.transcode', implementations: ['ffmpeg'], legacyTaskTypes: ['video_transcode'] },
            { capability: 'owner.poster', implementations: ['private-plugin'], legacyTaskTypes: [] },
          ] },
        requestableTaskTypes: { status: 'observed', observedAt: '2026-09-24T01:00:01.000Z', reason: null,
          items: [{ taskType: 'video_transcode', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' }] },
      } },
      querySupplySnapshot: async () => { supplyProbes += 1; throw new Error('candidate lookup must not probe') } })
    const plugin = await ctx.plugin(PluginDraftTools)
    try {
      expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
        'plugin_legal_document_template',
        'plugin_text_statistics_create', 'plugin_safe_workflow_create', 'plugin_candidate_prepare',
        'plugin_draft_creation_context',
        'plugin_draft_mac_video_template',
        'plugin_draft_model_candidates', 'plugin_draft_inspect_comfy_workflow', 'plugin_draft_probe_local_comfy',
        'plugin_draft_preflight_comfy_workflow', 'plugin_draft_bind_comfy_workflow',
        'plugin_draft_try_comfy_sample',
        'plugin_draft_save', 'plugin_draft_install_mac_video', 'plugin_draft_read', 'plugin_draft_preview',
        'plugin_reviewable_build', 'plugin_reviewable_try_sample',
        'plugin_draft_try_sample', 'plugin_private_list', 'plugin_private_activate',
        'plugin_private_run', 'plugin_private_uninstall',
      ])
      expect(ctx.tools.get('compute_submit')).toBeUndefined()
      const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === PluginDraftTools.PLUGIN_DRAFT_PROMPT_SECTION)
      expect(section?.text).toContain('短回复承接仍有效的目标')
      expect(section?.text).toContain('明确说“给我做成插件”')
      expect(section?.text).toContain('无需反问“是否要做插件”')
      expect(section?.text).toContain('不再单独问能否保存')
      expect(section?.text).toContain('仍缺才简短问当前必须的一项')
      expect(section?.text).toContain('不能编造绑定来凑草稿')
      expect(section?.text).toContain('不把“尚不能安装、发布或接单”说成“不能制作插件”')
      expect(section?.text).toContain('私有启用、固定模板安装、上传、出售和开放接单各需独立授权')
      expect(section?.text).toContain('compute_capability_landscape 核对本机、广州和上海的不同能力来源')
      expect(section?.text).toContain('其他 ComfyUI 或任意模型草稿不得借固定模板安装')
      expect(section?.text).toContain('不要扫描任意路径')
      expect(section?.text).toContain('上海语义注册表只是能力名称清单')
      const saveTool = ctx.tools.schemas().find(tool => tool.name === 'plugin_draft_save')
      expect(saveTool?.description).toContain('An explicit owner request to make a plugin authorizes this private draft save')
      expect(saveTool?.description).toContain('does not establish binding availability')

      const call = async (name: string, args: unknown, agent?: object) => {
        const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('call'), name,
          arguments: args, ...(agent ? { agent: agent as never } : {}) })
        const content = result.content.find(block => block.type === 'text')
        return { result, value: content?.type === 'text' ? content.text : '' }
      }
      const template = await call('plugin_draft_mac_video_template', {})
      expect(JSON.parse(template.value)).toMatchObject({ spec: { pluginId: 'qianshou.mac-drawn-video' },
        marketInstalled: false, dispatchable: false })
      const context = await call('plugin_draft_creation_context', {})
      expect(JSON.parse(context.value)).toMatchObject({ local: {
        observedAt: null, services: [], executors: [{ capabilityId: 'video.drawn-mac-5s', version: '0.1.0' }],
        adapters: [{ operationId: 'csv.profile', bindingKind: 'tool',
          state: 'registered-needs-sample', sampleRequired: true }],
      }, distributed: { catalog: { lookup: 'read', total: 2, version: '1.0', developerEntryStatus: 'observed',
        items: [
          { id: 'media.transcode', implementations: ['ffmpeg'], legacyTaskTypes: ['video_transcode'] },
          { id: 'owner.poster', implementations: ['private-plugin'], legacyTaskTypes: [] },
        ] },
        quotingConfigured: false, submissionConfigured: false, liveWorkersChecked: false, priceMinor: null },
      pluginReadinessChecked: false, ownerExecutionAuthorized: false })
      expect(context.value).not.toContain('untrusted text from a remote catalog')
      expect(supplyProbes).toBe(0)
      expect(draftWrites).toBe(0)
      configured = false
      const offlineContext = await call('plugin_draft_creation_context', {})
      expect(JSON.parse(offlineContext.value).distributed.catalog)
        .toEqual({ lookup: 'unconfigured', observedAt: null, reason: 'not_configured', version: null,
          total: null, items: null, developerEntryStatus: null })
      expect(catalogReads).toBe(1)
      configured = true
      expect((await call('plugin_draft_install_mac_video', { id: 'plugin_draft_missing',
        expectedUpdatedAt: '2026-09-24T00:00:00.000Z' })).result.isError).toBe(true)
      const neverObserved = await call('plugin_draft_model_candidates', {})
      expect(JSON.parse(neverObserved.value)).toEqual({ observedAt: null, models: [] })
      observed = { observedAt: '2026-09-23T12:00:00.000Z', localServices }
      const observedContext = await call('plugin_draft_creation_context', {})
      expect(JSON.parse(observedContext.value).local.services).toEqual([
        { id: 'ollama:h3', kind: 'local-model', name: 'H3', verification: 'pending' },
        { id: 'ollama:offline', kind: 'local-model', name: 'Offline', verification: 'unavailable' },
        { id: 'python3', kind: 'tool', name: 'Python', verification: 'verified' },
      ])
      expect(observedContext.value).not.toContain('not for the agent')
      const candidates = await call('plugin_draft_model_candidates', {})
      expect(candidates.result.isError).not.toBe(true)
      expect(JSON.parse(candidates.value)).toEqual({ observedAt: '2026-09-23T12:00:00.000Z',
        models: [{ id: 'ollama:h3', name: 'H3', verification: 'pending' }] })
      expect(draftWrites).toBe(0)
      expect((await store.list())).toHaveLength(0)
      localServices = []
      observed = { observedAt: '2026-09-23T12:01:00.000Z', localServices }
      const emptyCandidates = await call('plugin_draft_model_candidates', {})
      expect(JSON.parse(emptyCandidates.value)).toEqual({ observedAt: '2026-09-23T12:01:00.000Z', models: [] })
      expect(supplyProbes).toBe(0)
      expect(draftWrites).toBe(0)
      const inspected = await call('plugin_draft_inspect_comfy_workflow', { workflow: {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt' } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      } })
      expect(JSON.parse(inspected.value)).toMatchObject({ nodeCount: 2, textFields: [{ nodeId: '1', field: 'text' }],
        imageOutputNodes: [{ nodeId: '2' }], installable: false })
      expect(inspected.value).not.toContain('private prompt')
      expect(supplyProbes).toBe(0)
      expect(draftWrites).toBe(0)
      const refused = await call('plugin_draft_save', { spec })
      expect(refused.result.isError).toBe(true)
      expect((await store.list())).toHaveLength(0)
      expect((await call('plugin_draft_try_comfy_sample', { id: 'plugin_draft_missing', operationId: 'x', prompt: 'cat' })).result.isError).toBe(true)

      const saved = await call('plugin_draft_save', { spec }, {})
      expect(saved.result.isError).not.toBe(true)
      const receipt = JSON.parse(saved.value) as { id: string; state: string; installable: boolean; dispatchable: boolean }
      expect(receipt).toMatchObject({ state: 'private-draft', installable: false, dispatchable: false })
      const listed = await call('plugin_draft_read', {})
      expect(JSON.parse(listed.value)).toMatchObject({ total: 1, items: [{ id: receipt.id, operations: ['owner.poster.draw', 'owner.poster.resize'] }] })
      const one = await call('plugin_draft_read', { id: receipt.id })
      expect(JSON.parse(one.value)).toMatchObject({ id: receipt.id, spec: { displayName: '海报助手' } })
      const preview = await call('plugin_draft_preview', { id: receipt.id })
      expect(JSON.parse(preview.value)).toMatchObject({ pluginId: 'owner.poster', state: 'pending',
        installable: false, dispatchable: false })
      expect(preview.value).toContain('仍需验证')
      expect(preview.value).not.toContain('ollama:poster-v1')
      const malformed = await call('plugin_draft_save', { spec: { ...spec, operations: [{ ...spec.operations[0], binding: { kind: 'workflow', ref: '/tmp/model' } }] } }, {})
      expect(malformed.result.isError).toBe(true)
      expect((await store.list())).toHaveLength(1)
      const unsafeId = await call('plugin_draft_read', { id: '../../drafts.json' })
      expect(unsafeId.result.isError).toBe(true)
      const unsafePreview = await call('plugin_draft_preview', { id: '../../drafts.json' })
      expect(unsafePreview.result.isError).toBe(true)
    } finally {
      await plugin.dispose()
      await runtime.dispose()
      await prompt.dispose()
      await store.close()
    }
  })

  it('requires a Host one-shot approval before storing an owner graph and redacts model-facing reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-draft-approval-'))
    roots.push(root)
    const store = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 1_000_000 })
    const workflowSpec = { ...spec, operations: [{ ...spec.operations[1], binding: { kind: 'workflow', ref: 'comfy:poster-v1' } }] }
    const draft = await store.save({ spec: workflowSpec })
    const workflow = {
      '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'private.gguf' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt', clip: ['1', 0] } },
      '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
    }
    const binding = { id: draft.id, operationId: 'owner.poster.resize', workflow,
      mapping: { prompt: { nodeId: '2', field: 'text' }, outputNodeId: '3' } }
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt)
    const runtime = await ctx.plugin(ToolRuntime)
    ctx.provide('computeCore', { localPluginDrafts: () => store.list(),
      bindLocalPluginComfyAsset: (value: Parameters<typeof store.bindComfyAsset>[0]) => store.bindComfyAsset(value),
      localPluginComfyAssetSummaries: (id: unknown) => store.comfyAssetSummaries(id),
      previewLocalPluginDraft: (id: unknown) => store.preview(id), lastObservedSupply: () => null })
    const plugin = await ctx.plugin(PluginDraftTools)
    const call = async (name: string, args: unknown, agent?: object) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('bind-call'), name,
        arguments: args, ...(agent ? { agent: agent as never } : {}) })
      const content = result.content.find(block => block.type === 'text')
      return { result, value: content?.type === 'text' ? content.text : '' }
    }
    try {
      expect((await call('plugin_draft_bind_comfy_workflow', binding)).result.isError).toBe(true)
      expect((await call('plugin_draft_bind_comfy_workflow', binding, {})).result.isError).toBe(true)
      expect(await store.comfyAssetSummaries(draft.id)).toEqual([])
      let outcome = 'rejected'
      let approvalReason = ''
      ctx.provide('approval' as never, { request: async (request: { reason: string }) => {
        approvalReason = request.reason; return outcome
      } } as never)
      expect((await call('plugin_draft_bind_comfy_workflow', binding, {})).result.isError).toBe(true)
      expect(await store.comfyAssetSummaries(draft.id)).toEqual([])
      outcome = 'allowed-once'
      const saved = await call('plugin_draft_bind_comfy_workflow', binding, {})
      expect(saved.result.isError).not.toBe(true)
      const savedSummary = JSON.parse(saved.value) as { graphSha256: string }
      expect(savedSummary).toMatchObject({ operationId: 'owner.poster.resize', state: 'stored-needs-trial',
        runnable: false, installable: false, dispatchable: false })
      expect(saved.value).not.toContain('private prompt')
      expect(saved.value).not.toContain('private.gguf')
      expect(approvalReason).toContain(draft.id)
      expect(approvalReason).toContain('owner.poster.resize')
      expect(approvalReason).toContain(savedSummary.graphSha256)
      expect(approvalReason).not.toContain('private prompt')
      expect(approvalReason).not.toContain('private.gguf')
      const read = await call('plugin_draft_read', { id: draft.id })
      expect(JSON.parse(read.value)).toMatchObject({ comfyBindings: [{ state: 'stored-needs-trial' }] })
      expect(read.value).not.toContain('private prompt')
      expect(read.value).not.toContain('private.gguf')
      expect((await store.readComfyAsset(draft.id, 'owner.poster.resize')).graph['2']?.inputs.text).toBe('private prompt')
    } finally {
      await plugin.dispose()
      await runtime.dispose()
      await prompt.dispose()
      await store.close()
    }
  })

  it('routes the creator sample tool through the actual Host approval and never POSTs without it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-sample-tool-'))
    roots.push(root)
    const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 1_000_000 })
    const recipe = { ...spec, operations: [{ ...spec.operations[1],
      binding: { kind: 'workflow', ref: 'comfy:owner-render' } }] }
    const draft = await drafts.save({ spec: recipe })
    const graph = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'private template' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    }
    await drafts.bindComfyAsset({ id: draft.id, expectedUpdatedAt: draft.updatedAt,
      operationId: 'owner.poster.resize', workflow: graph,
      mapping: { prompt: { nodeId: '1', field: 'text' }, outputNodeId: '2' } })
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt)
    const runtime = await ctx.plugin(ToolRuntime)
    const calls: string[] = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname.startsWith('/object_info/')) {
        const className = url.pathname.split('/').at(-1) ?? ''
        return Response.json({ [className]: { input: { required: {} } } })
      }
      if (url.pathname === '/prompt') return Response.json({ error: 'rejected by fixture' }, { status: 400 })
      throw new Error('Unexpected fake endpoint')
    }
    let reason = ''
    const trial = new PrivateComfyTrialHost({ drafts,
      ledger: new ComfyPrivateTrialLedger(join(root, 'comfy-trials.json')),
      workspaceRoot: join(root, 'work'), outputRoot: join(root, 'images'), fetcher,
      approval: { request: async (request) => {
        const service = (ctx as unknown as { get: (name: string) => {
          request: (value: typeof request) => Promise<string>
        } | undefined }).get('approval')
        if (!service) throw new ComputeError('COMPUTE_COMFY_TRIAL_OWNER_APPROVAL_REQUIRED', 403)
        reason = request.reason
        return service.request(request)
      } },
    })
    const store = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 10, maxBytes: 131072 })
    const service = new ComputeService(null, store, () => false,
      undefined, undefined, undefined, undefined, undefined, undefined, drafts, trial)
    ctx.provide('computeCore', service)
    const tools = await ctx.plugin(PluginDraftTools)
    const args = { id: draft.id, operationId: 'owner.poster.resize', prompt: 'one private cat' }
    const invoke = () => ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('private-sample-call'), name: 'plugin_draft_try_comfy_sample', arguments: args,
      agent: {} as never })
    try {
      expect((await invoke()).isError).toBe(true)
      expect(calls).not.toContain('POST /prompt')
      let outcome = 'rejected'
      ctx.provide('approval' as never, { request: async () => outcome } as never)
      expect((await invoke()).isError).toBe(true)
      expect(reason).toContain(draft.id)
      expect(reason).not.toContain('one private cat')
      expect(calls).not.toContain('POST /prompt')
      outcome = 'allowed-once'
      expect((await invoke()).isError).toBe(true)
      expect(calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
      expect((await invoke()).isError).toBe(true)
      expect(calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
    } finally {
      await tools.dispose()
      await runtime.dispose()
      await prompt.dispose()
      await service.close()
    }
  })

  it('keeps generic sample execution behind exact adapter discovery and one owner approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-generic-sample-tool-'))
    roots.push(root)
    const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 131072 })
    const saved = await drafts.save({ spec: {
      pluginId: 'owner.text-check', version: '1.0.0', displayName: '文字核对',
      operations: [{ id: 'text.check', title: '核对文字', description: '试跑一段文字',
        binding: { kind: 'tool', ref: 'text-check:host' },
        inputSchema: { type: 'object', properties: { text: { type: 'string' } },
          required: ['text'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { length: { type: 'integer' } },
          required: ['length'], additionalProperties: false },
        permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
        resources: { minTotalMemoryBytes: 0, minFreeDiskBytes: 0,
          maxInputBytes: 1024, maxOutputBytes: 1024, maxRunMs: 1000 } }],
    } })
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt)
    const runtime = await ctx.plugin(ToolRuntime)
    let adapters: Array<Record<string, unknown>> = []
    let approvals = 0
    let executions = 0
    let allow = false
    ctx.provide('computeCore', {
      localPluginDrafts: () => drafts.list(),
      listPluginAdapterBindings: () => adapters,
      runPrivatePluginSamples: async () => {
        executions += 1
        return { id: 'sample-1', draftId: saved.id,
          candidate: { pluginId: 'owner.text-check', version: '1.0.0', candidateSha256: 'a'.repeat(64) },
          artifact: { bytes: Buffer.from('private input'), packageSha256: 'b'.repeat(64) },
          samples: [{ operationId: 'text.check', sampleExecuted: true }],
          results: [{ operationId: 'text.check', output: { length: 2 } }] }
      },
    } as never)
    ctx.provide('approval' as never, { request: async (request: { reason: string }) => {
      approvals += 1
      expect(request.reason).toContain(saved.updatedAt)
      expect(request.reason).not.toContain('私有输入内容')
      return allow ? 'allowed-once' : 'rejected'
    } } as never)
    const plugin = await ctx.plugin(PluginDraftTools)
    const invoke = (expectedUpdatedAt = saved.updatedAt) => ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('generic-sample'),
      name: 'plugin_draft_try_sample', arguments: { id: saved.id, expectedUpdatedAt,
        samples: [{ operationId: 'text.check', input: { text: '私有输入内容' } }] },
      agent: {} as never,
    })
    try {
      const readBefore = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId('generic-read-before'), name: 'plugin_draft_read',
        arguments: { id: saved.id }, agent: {} as never })
      const beforeText = readBefore.content.find(item => item.type === 'text')
      expect(beforeText?.type === 'text' ? JSON.parse(beforeText.text).adapterBindings : null).toEqual([])
      expect((await invoke()).isError).toBe(true)
      expect(approvals).toBe(0)
      adapters = [{ operationId: 'text.check', bindingKind: 'tool', bindingRef: 'text-check:host' }]
      const readAfter = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId('generic-read-after'), name: 'plugin_draft_read',
        arguments: { id: saved.id }, agent: {} as never })
      const afterText = readAfter.content.find(item => item.type === 'text')
      expect(afterText?.type === 'text' ? JSON.parse(afterText.text).adapterBindings : null)
        .toMatchObject([{ operationId: 'text.check', bindingKind: 'tool' }])
      expect((await invoke('outdated')).isError).toBe(true)
      expect(approvals).toBe(0)
      expect((await invoke()).isError).toBe(true)
      expect(approvals).toBe(1)
      expect(executions).toBe(0)
      allow = true
      const completed = await invoke()
      expect(completed.isError).not.toBe(true)
      expect(executions).toBe(1)
      const response = completed.content.find(item => item.type === 'text')
      const raw = response?.type === 'text' ? response.text : ''
      expect(JSON.parse(raw)).toMatchObject({ state: 'private-sample-completed',
        results: [{ output: { length: 2 } }], installable: false, dispatchable: false })
      expect(raw).not.toContain('private input')
    } finally {
      await plugin.dispose()
      await runtime.dispose()
      await prompt.dispose()
      await drafts.close()
    }
  })
})
