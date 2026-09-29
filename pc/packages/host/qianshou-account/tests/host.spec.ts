import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import QianshouAccount from '../src/index.ts'
import { IMAGE_PROGRESS_TEXT, IMAGE_READY_TEXT } from '../src/route.ts'
import { ACCOUNT_ACCESS_REF } from '../src/store.ts'
import { ComputeService } from '../../compute-core/src/service.ts'
import type { ComputeDraftStore } from '../../compute-core/src/store.ts'
import { ComputeCapabilityId } from '../../compute-core/src/protocol.ts'

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
let imageCalls = 0
let intentCalls = 0
let holdImage: Promise<void> | undefined

class MemoryImages extends Service {
  constructor(ctx: Context) { super(ctx, 'attachments') }
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef> {
    return Promise.resolve({
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    })
  }
}

const contexts: Context[] = []
afterEach(async () => {
  imageCalls = 0
  intentCalls = 0
  holdImage = undefined
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  await closeMockServers()
})
async function fixture(url: string, options: { rejectIntent?: boolean } = {}) {
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (path.startsWith('https://account.example')) return Response.json(path.endsWith('/auth/me')
      ? { account: { id: 'fixture-user', username: 'Test User' } }
      : { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 })
    if (path.endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }] })
    if (path.endsWith('/intent') || path.endsWith('/images/generations')) {
      if (path.endsWith('/intent')) intentCalls += 1
      if (path.endsWith('/intent') && options.rejectIntent) return Response.json({ error: { message: 'auth' } }, { status: 401 })
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization !== 'Bearer fixture-access') return Response.json({ error: { message: 'auth' } }, { status: 401 })
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string; previous?: { originalText?: string }; model?: string; prompt?: string }
      if (path.endsWith('/images/generations')) {
        imageCalls += 1
        if (holdImage !== undefined) await holdImage
        if (body.model !== '千手·绘画' || body.prompt?.trim() === undefined || body.prompt.trim() === '') {
          return Response.json({ error: { message: 'bad image request' } }, { status: 400 })
        }
        return Response.json({ data: [{ b64_json: TINY_PNG }] })
      }
      if (body.text === '给我出图') return Response.json({
        ok: true, route: 'image', stage: 'clarify', capability: 'image.generate',
        originalText: '给我出图', question: '想画什么？随便也可以。',
      })
      if (body.text === '画一只猫' || (body.text === '随便' && body.previous !== undefined)) return Response.json({
        ok: true, route: 'image', stage: 'generate', capability: 'image.generate',
        prompt: body.previous?.originalText ?? body.text, model: '千手·绘画',
      })
      return Response.json({ ok: true, route: 'chat' })
    }
    return originalFetch(input, init)
  }))
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(MemoryCredentials, { OTHER_KEY: 'fixture-other' })
  await ctx.plugin(MemorySettings, { doc: {
    'agent-default-model': { provider: 'custom-provider', model: 'chosen-model' },
    'permission-presets': { selected: 'existing-permission' },
  } })
  ctx.settings.register('agent-default-model', Schema.object({ provider: Schema.string(), model: Schema.string(), reasoningEffort: Schema.string() }))
  ctx.settings.register('permission-presets', Schema.object({ selected: Schema.string() }))
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: {
    'qianshou-cloud': { displayName: 'test', api: 'openai-completions', baseURL: url, apiKeyEnv: ACCOUNT_ACCESS_REF,
      models: [{ id: 'test-model', name: 'test', contextWindow: 32000, maxTokens: 4096, reasoningEfforts: false }] },
    'custom-provider': { api: 'openai-completions', baseURL: url, apiKeyEnv: 'OTHER_KEY', models: [{ id: 'chosen-model', contextWindow: 32000, maxTokens: 4096, reasoningEfforts: false }] },
  } })
  const fiber = await ctx.plugin(QianshouAccount, { accountOrigin: 'https://account.example', gatewayBase: url, timeoutMs: 1000 })
  return { ctx, fiber, account: ctx.qianshouAccount }
}

describe('Qianshou Host composition and real loopback provider transport', () => {
  it('selects the cloud route after login and leaves other providers and permissions intact', async () => {
    const { ctx, account } = await fixture('http://127.0.0.1:1')
    const providerBefore = (ctx.settings.get('llm-pi-ai') as LlmPiAi.Config).providers?.['custom-provider']
    expect(await account.login('test-user', 'fixture-password')).toMatchObject({ cloudSelected: true, models: ['test-model'] })
    expect(ctx.settings.get('agent-default-model')).toMatchObject({ provider: 'qianshou-cloud', model: 'test-model' })
    expect((ctx.settings.get('llm-pi-ai') as LlmPiAi.Config).providers?.['qianshou-cloud']).toMatchObject({
      displayName: '千手',
      reasoning: 'high',
      compat: { thinkingFormat: 'deepseek' },
      models: [{ id: 'test-model', name: '千手v4', input: ['text', 'image'], contextWindow: 1_000_000,
        maxTokens: 65_536, reasoningEfforts: { off: null, high: 'high' } }],
    })
    expect(await account.useCloud()).toMatchObject({ cloudSelected: true, models: ['test-model'] })
    expect((ctx.settings.get('llm-pi-ai') as LlmPiAi.Config).providers?.['custom-provider']).toEqual(providerBefore)
    expect(ctx.settings.get('permission-presets')).toEqual({ selected: 'existing-permission' })
    expect(ctx.settings.get('agent-default-model')).toMatchObject({ provider: 'qianshou-cloud', model: 'test-model' })
  })
  it('does not copy another provider\'s off effort when selecting the cloud model', async () => {
    const { ctx, account } = await fixture('http://127.0.0.1:1')
    await ctx.settings.replace('agent-default-model', {
      provider: 'custom-provider', model: 'chosen-model', reasoningEffort: 'off',
    })

    await account.login('test-user', 'fixture-password')

    expect(ctx.settings.get('agent-default-model')).toEqual({
      provider: 'qianshou-cloud', model: 'test-model',
    })
    await expect(ctx.llm.resolveCallConfig(ctx.settings.get('agent-default-model') as {
      provider: string
      model: string
    })).resolves.toMatchObject({ provider: 'qianshou-cloud', model: 'test-model' })
    expect(ctx.settings.get('permission-presets')).toEqual({ selected: 'existing-permission' })
  })
  it.each(['off', 'high'] as const)('preserves the selected %s effort when refreshing the current cloud route', async (reasoningEffort) => {
    const { ctx, account } = await fixture('http://127.0.0.1:1')
    await account.login('test-user', 'fixture-password')
    await ctx.settings.replace('agent-default-model', {
      provider: 'qianshou-cloud', model: 'test-model', reasoningEffort,
    })

    expect(await account.reconnect()).toMatchObject({ phase: 'authenticated', models: ['test-model'] })
    expect(await account.useCloud()).toMatchObject({ cloudSelected: true, models: ['test-model'] })

    expect(ctx.settings.get('agent-default-model')).toEqual({
      provider: 'qianshou-cloud', model: 'test-model', reasoningEffort,
    })
    expect((ctx.settings.get('llm-pi-ai') as LlmPiAi.Config).providers?.['qianshou-cloud']).toMatchObject({
      compat: { thinkingFormat: 'deepseek' },
      models: [{ id: 'test-model', reasoningEfforts: { off: null, high: 'high' } }],
    })
  })
  it.each(['logout', 'switch', 'dispose'] as const)('%s aborts an already-started HTTP model response', async (action) => {
    const server = await mockServer([{ events: textEvents, delayMs: 200 }, { events: textEvents }])
    const { ctx, account, fiber } = await fixture(server.url)
    await account.login('test-user', 'fixture-password')
    const stream = assemble(ctx, { provider: 'qianshou-cloud', model: 'test-model', messages: [] })
    await vi.waitFor(() => { expect(server.requests).toHaveLength(1) })
    if (action === 'logout') await account.logout()
    else if (action === 'switch') await account.login('second-user', 'fixture-password')
    else await fiber.dispose()
    expect((await stream).finish.kind).toBe('aborted')
    await server.responseClosed
    expect(server.closedResponses).toBe(1)
    if (action !== 'dispose') {
      if (action === 'logout') await account.login('second-user', 'fixture-password')
      expect((await assemble(ctx, { provider: 'qianshou-cloud', model: 'test-model', messages: [] })).finish.kind).toBe('stop')
      expect(server.requests).toHaveLength(2)
    }
  })
  it('does not require an account or attach its lifetime to a different provider', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await fixture(server.url)
    expect((await assemble(ctx, { provider: 'custom-provider', model: 'chosen-model', messages: [] })).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(1)
  })
  it('rejects unauthenticated managed model calls before any provider request', async () => {
    const server = await mockServer([])
    const { ctx } = await fixture(server.url)
    const result = await assemble(ctx, { provider: 'qianshou-cloud', model: 'test-model', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: {
      code: 'QIANSHOU_LOGIN_REQUIRED', message: '尚未登录千手账号，请打开左下角「千手账号」登录后重试。',
    } })
    expect(server.requests).toHaveLength(0)
  })

  it('explains sign-in before a conversation reaches intent or model transport', async () => {
    const server = await mockServer([])
    const { ctx } = await fixture(server.url)
    await expect(assemble(ctx, {
      provider: 'qianshou-cloud', model: 'test-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
    })).rejects.toMatchObject({
      code: 'QIANSHOU_LOGIN_REQUIRED', message: '尚未登录千手账号，请打开左下角「千手账号」登录后重试。',
    })
    expect(server.requests).toHaveLength(0)
  })

  it('keeps a saved account rejected by the intent service distinct from first-time sign-in', async () => {
    const server = await mockServer([])
    const { ctx, account } = await fixture(server.url, { rejectIntent: true })
    expect(await account.login('test-user', 'fixture-password')).toMatchObject({ phase: 'authenticated', restorable: true })
    await expect(assemble(ctx, {
      provider: 'qianshou-cloud', model: 'test-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
    })).rejects.toMatchObject({
      code: 'QIANSHOU_ACCOUNT_REQUIRED', message: '千手账号暂不可用，请打开左下角「千手账号」查看登录状态后重试。',
    })
    expect(server.requests).toHaveLength(0)
  })

  it('lets the skill assistant create a plugin without generic intent interception', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx, account } = await fixture(server.url)
    await account.login('test-user', 'fixture-password')
    const result = await assemble(ctx, {
      provider: 'qianshou-cloud', model: 'test-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: '请帮我制作文字统计插件' }], source: { kind: 'user' } })],
      tools: [{ name: 'plugin_text_statistics_create', description: 'Create a local candidate', parameters: { type: 'object' } }],
    })
    expect(result.finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(1)
    expect(intentCalls).toBe(0)
  })

  it('sends only a registered video planning session to the real text model before intent', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const { ctx, account } = await fixture(server.url)
    await account.login('test-user', 'fixture-password')
    const sessionId = SessionId('qianshou.video-plan.00000000-0000-4000-8000-000000000001')
    const release = account.registerVideoAssetPlanSession(sessionId)
    const input = { provider: 'qianshou-cloud', model: 'test-model', sessionId,
      messages: [createUserMessage({ content: [{ type: 'text', text: '帮我出视频' }], source: { kind: 'user' } })] }
    expect((await assemble(ctx, input)).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(1)
    expect(intentCalls).toBe(0)
    release()
    expect((await assemble(ctx, input)).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(2)
    expect(intentCalls).toBe(1)
  })

  it('keeps conversation on the text route and sends a picture request to the image route', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }, { events: textEvents }])
    const { ctx, account } = await fixture(server.url)
    await ctx.plugin(MemoryImages)
    await account.login('test-user', 'fixture-password')
    const say = (text: string) => assemble(ctx, {
      provider: 'qianshou-cloud', model: 'test-model',
      messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    })
    expect((await say('你好')).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(1)
    expect(imageCalls).toBe(0)
    expect((await say('给我出图')).message.content).toEqual([{ type: 'text', text: '想画什么？随便也可以。' }])
    expect(server.requests).toHaveLength(1)
    const picture = await say('随便')
    expect(picture.message.content).toEqual([
      { type: 'text', text: IMAGE_READY_TEXT },
      { type: 'image', attachment: expect.objectContaining({ mediaType: 'image/png', name: 'qianshou.png' }) },
    ])
    expect(imageCalls).toBe(1)
    expect(server.requests).toHaveLength(1)
    expect(intentCalls).toBe(3)
    expect((await say('你好')).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(2)
    expect(imageCalls).toBe(1)
    const titled = await assemble(ctx, {
      provider: 'qianshou-cloud', model: 'test-model', purpose: 'session-title',
      messages: [createUserMessage({ content: [{ type: 'text', text: '画一只猫' }], source: { kind: 'user' } })],
    })
    expect(titled.finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(3)
    expect(imageCalls).toBe(1)
  })

  it('uses the Host preview at the real first turn and leaves Guangzhou chat and image follow-ups intact', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx, account } = await fixture(server.url)
    await ctx.plugin(MemoryImages)
    const compute = new ComputeService(null, {} as ComputeDraftStore, () => false)
    const preview = vi.spyOn(compute, 'previewNaturalIntent')
    const publish = vi.spyOn(compute, 'publishPlan')
    const supplyWrite = vi.spyOn(compute, 'updateSupplyPolicy')
    ctx.provide('computeCore', compute)
    await account.login('test-user', 'fixture-password')
    // oxlint-disable-next-line sonarjs/no-identical-functions -- Existing scenarios keep their local request helper.
    const say = (text: string) => assemble(ctx, {
      provider: 'qianshou-cloud', model: 'test-model',
      messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    })
    expect((await say('你好')).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(1)
    expect((await say('画一只猫')).message.content).toEqual([
      { type: 'text', text: IMAGE_READY_TEXT },
      { type: 'image', attachment: expect.objectContaining({ mediaType: 'image/png' }) },
    ])
    expect(imageCalls).toBe(1)
    expect(server.requests).toHaveLength(1)
    expect((await say('在本机整理文件夹')).message.content).toEqual([
      { type: 'text', text: '这台电脑还没准备好做这件事。可以看看有没有合适的插件，或换一种方式。' },
    ])
    expect((await say('借用别人的电脑压缩视频')).message.content).toEqual([
      { type: 'text', text: '暂时没有找到能接这项工作的设备。你还没有下单，也不会产生费用。' },
    ])
    const execute = vi.fn(async () => ({ outputs: [] }))
    compute.executors.register({ capabilityId: ComputeCapabilityId('media.transcode'), version: '1', execute })
    expect((await say('在本机压缩视频')).message.content).toEqual([
      { type: 'text', text: '这台电脑有对应能力。下一步确认要用的内容和权限，再开始处理。' },
    ])
    expect((await say('让我的电脑接单赚钱')).message.content).toEqual([
      { type: 'text', text: '去“我的能力”选择想接的工作。只有你亲自开启后，这台电脑才会进入接单候选。' },
    ])
    expect((await say('本机或借别人的电脑压缩视频')).message.content).toEqual([
      { type: 'text', text: '你想先在这台电脑做，使用千手云，还是借用其他设备？' },
    ])
    expect(server.requests).toHaveLength(1)
    expect(imageCalls).toBe(1)
    expect(intentCalls).toBe(2)
    expect(publish).not.toHaveBeenCalled()
    expect(supplyWrite).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    const beforeClarify = preview.mock.calls.length
    expect((await say('给我出图')).message.content).toEqual([{ type: 'text', text: '想画什么？随便也可以。' }])
    expect(preview.mock.calls.length).toBe(beforeClarify + 1)
    expect((await say('随便')).message.content[1]).toMatchObject({ type: 'image' })
    expect(preview.mock.calls.length).toBe(beforeClarify + 1)
    expect(imageCalls).toBe(2)
  })

  it('lets ordinary local file work reach its visible shell tools without requiring a compute executor', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const { ctx, account } = await fixture(server.url)
    const compute = new ComputeService(null, {} as ComputeDraftStore, () => false)
    const publish = vi.spyOn(compute, 'publishPlan')
    const supplyWrite = vi.spyOn(compute, 'updateSupplyPolicy')
    ctx.provide('computeCore', compute)
    await account.login('test-user', 'fixture-password')
    for (const [text, name] of [['请在本机生成3页PPT并交付文件', 'bash'], ['请在本机做一个PPT', 'pwsh']] as const) {
      const result = await assemble(ctx, {
        provider: 'qianshou-cloud', model: 'test-model',
        messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
        tools: [{ name, description: 'Owner workspace command execution', parameters: { type: 'object' } }],
      })
      expect(result.finish.kind).toBe('stop')
      expect(result.message.content).not.toEqual([{ type: 'text', text: '这台电脑还没准备好做这件事。可以看看有没有合适的插件，或换一种方式。' }])
    }
    expect(server.requests).toHaveLength(2)
    expect(intentCalls).toBe(2)
    expect(imageCalls).toBe(0)
    expect(publish).not.toHaveBeenCalled()
    expect(supplyWrite).not.toHaveBeenCalled()
  })

  it('shows local next steps and a clear cloud login prompt without sending a signed-out turn to Guangzhou', async () => {
    const server = await mockServer([])
    const { ctx } = await fixture(server.url)
    const compute = new ComputeService(null, {} as ComputeDraftStore, () => false)
    compute.executors.register({ capabilityId: ComputeCapabilityId('media.transcode'), version: '1',
      execute: async () => ({ outputs: [] }) })
    ctx.provide('computeCore', compute)
    // oxlint-disable-next-line sonarjs/no-identical-functions -- Existing scenarios keep their local request helper.
    const say = (text: string) => assemble(ctx, {
      provider: 'qianshou-cloud', model: 'test-model',
      messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    })
    expect((await say('在本机压缩视频')).message.content).toEqual([
      { type: 'text', text: '这台电脑有对应能力。下一步确认要用的内容和权限，再开始处理。' },
    ])
    expect((await say('帮我生成图片')).message.content).toEqual([
      { type: 'text', text: '请先登录千手账号，再使用千手云出图。' },
    ])
    expect(server.requests).toEqual([])
    expect(imageCalls).toBe(0)
  })

  it('streams the picture wait sentence before the image bytes return', async () => {
    let release = (): void => {}
    holdImage = new Promise<void>((resolve) => { release = resolve })
    const server = await mockServer([])
    const { ctx, account } = await fixture(server.url)
    await ctx.plugin(MemoryImages)
    await account.login('test-user', 'fixture-password')
    const stream = ctx.llm.stream({
      provider: 'qianshou-cloud', model: 'test-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: '画一只猫' }], source: { kind: 'user' } })],
    })
    const iterator = stream[Symbol.asyncIterator]()
    const opened = await iterator.next()
    const progress = await iterator.next()
    expect(opened.value).toMatchObject({ type: 'block-start', blockType: 'text' })
    expect(progress.value).toMatchObject({ type: 'text-delta', text: IMAGE_PROGRESS_TEXT })
    expect(imageCalls).toBe(0)
    release()
    const assembler = new BlockAssembler()
    assembler.push(opened.value)
    assembler.push(progress.value)
    let step = await iterator.next()
    while (!step.done) {
      assembler.push(step.value)
      step = await iterator.next()
    }
    expect(assembler.message({ kind: 'model', provider: 'qianshou-cloud', model: 'test-model' }).content).toEqual([
      { type: 'text', text: IMAGE_READY_TEXT },
      { type: 'image', attachment: expect.objectContaining({ mediaType: 'image/png' }) },
    ])
    expect(imageCalls).toBe(1)
  })
})
