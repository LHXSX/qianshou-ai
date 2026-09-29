/** Human parallel dispatch over a real Agent loop and durable child lifecycle. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentAdmissionPart, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentControl from '../../../subagent/tool-subagent-control/src/index.ts'
import { loadStoredSession } from '../../../subagent/subagent/tests/persistence-helpers.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { ApiSessionAgentController } from '../src/agent.ts'
import type { SessionRequestId } from '../src/types.ts'
import { applySessionListMetadata } from '../src/list.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose() })

async function setup() {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-parallel-dispatch-'))
  cleanup.push(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  // The first parent request stays live. Every independently created child
  // can nevertheless complete with an actual streamed answer.
  const adapter = new MockAdapter(['hang', textResponse('child result'), textResponse('second result')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parallel-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const selection: ModelSelectionRef = { current: { provider: 'mock', model: 'mock' }, assembled: undefined }
  const agents = {
    resolveAgent: () => Promise.resolve({ agent: parent }),
    selectionFor: () => selection,
    serializeImageAdmission: <T>(_agent: unknown, work: () => Promise<T>) => work(),
  } as unknown as ApiSessionAgentController
  const bindPrompt = vi.fn(() => ({ commit: vi.fn(), [Symbol.dispose]: () => {} }))
  const resolveFile = vi.fn((): FileAttachmentRef | undefined => undefined)
  const retirePrompt = vi.fn()
  const admitPromptContent = vi.fn((content: readonly AttachmentAdmissionPart[]) => Promise.resolve(content))
  const readImage = vi.fn()
  ctx.provide('fileUploads', { resolve: resolveFile, bindPrompt, retirePrompt } as never)
  ctx.provide('attachments', {
    admitPromptContent, readImage,
  } as never)
  const controller = new SessionCommandController(ctx, agents, root)
  const request = (requestId = 'dispatch-1') => ({
    sessionId: parent.id,
    requestId: requestId as SessionRequestId,
    content: [{ type: 'text' as const, text: 'Review a separate module' }],
    clientTimeZone: 'Asia/Shanghai',
  })
  return { ctx, parent, adapter, controller, request, bindPrompt, agents, resolveFile, retirePrompt, admitPromptContent, readImage }
}

const signal = () => new AbortController().signal

describe('direct human parallel dispatch', () => {
  it('starts a real child while the parent remains busy, persists provenance, and coalesces retries', async () => {
    const { ctx, parent, adapter, controller, request, agents } = await setup()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Long parent task' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const cancel = vi.spyOn(parent, 'cancel')
    const followup = vi.spyOn(parent, 'followup')
    const steer = vi.spyOn(parent, 'steer')
    const [first, concurrent] = await Promise.all([
      controller.dispatchParallel(request(), signal()),
      controller.dispatchParallel(request(), signal()),
    ])
    expect(first).toEqual(concurrent)
    expect(first.parentSessionId).toBe(parent.id)
    expect(first.mode).toBe('continuable')
    expect(cancel).not.toHaveBeenCalled()
    // A settlement notice may be delivered later; the dispatch itself never
    // routes the requested human task into the parent's inbox.
    expect(followup.mock.calls.some(([message]) => message.content.some(part => part.type === 'text' && part.text === 'Review a separate module'))).toBe(false)
    expect(steer.mock.calls.some(([message]) => message.content.some(part => part.type === 'text' && part.text === 'Review a separate module'))).toBe(false)
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(2) })
    expect(parent.status).toBe('running')
    await vi.waitFor(() => { expect(ctx.agents.get(first.childSessionId)).toBeUndefined() })
    using child = await ctx.sessionQuery.observeSession(first.childSessionId)
    expect(child.header).toMatchObject({ origin: 'subagent', parentSession: parent.id, cwd: parent.session.header.cwd })
    expect(child.events.find(event => event.type === 'user/message' && event.data.id === first.messageId)).toMatchObject({
      data: { source: { kind: 'user', rpcId: request().requestId, clientTimeZone: 'Asia/Shanghai' } },
    })
    const reconnected = new SessionCommandController(ctx, agents, parent.session.header.cwd!)
    expect(await reconnected.dispatchParallel(request(), signal())).toEqual(first)
    expect(child.events.some(event => event.type === 'assistant/message')).toBe(true)
    const catalog = await ctx.subagents.listChildren(parent.id)
    expect(catalog.filter(entry => entry.kind === 'child')).toHaveLength(1)
  })

  it('rejects empty, cancelled, and foreign-file submissions before starting a child', async () => {
    const { ctx, controller, request, bindPrompt } = await setup()
    const start = vi.spyOn(ctx.subagents, 'startContinuable')
    await expect(controller.dispatchParallel({ ...request(), content: [{ type: 'text', text: ' ' }] }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    const cancelled = new AbortController(); cancelled.abort()
    await expect(controller.dispatchParallel(request(), cancelled.signal)).rejects.toBeTruthy()
    await expect(controller.dispatchParallel({ ...request('files'), content: [{ type: 'file', receiptId: 'foreign' as never }] }, signal())).rejects.toMatchObject({ code: 'session/attachment-invalid' })
    expect(start).not.toHaveBeenCalled()
    expect(bindPrompt).not.toHaveBeenCalled()
  })

  it('keeps a parent containing only accepted dispatches visible after reloading metadata', async () => {
    const { parent, controller, request } = await setup()
    const accepted = await controller.dispatchParallel(request(), signal())
    const events = parent.session.snapshotEvents()
    const receipt = events.find(event => event.type === 'parallel/dispatched')
    expect(receipt).toMatchObject({ data: { ...accepted, requestId: request().requestId } })
    expect(events.reduce(applySessionListMetadata, { blank: true, lastPromptAt: null })).toMatchObject({ blank: false })
  })

  it('persists the entire human message before acknowledgement and replays one receipt after reconnect', async () => {
    const { ctx, parent, adapter, controller, request, agents } = await setup()
    const start = vi.spyOn(ctx.subagents, 'startContinuable')
    const text = `  第一段：请完整保留原始需求。\n\n${'长段落，包含标点和 emoji 🐙。'.repeat(400)}\n最后一行。  `
    const submission = { ...request(), label: '独立实现任务', content: [{ type: 'text' as const, text }] }
    const accepted = await controller.dispatchParallel(submission, signal())
    const stored = await loadStoredSession(ctx.sessionPersistence, parent.id)
    const receipts = stored.events.filter(event => event.type === 'parallel/dispatched')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      data: { ...accepted, requestId: submission.requestId, label: '独立实现任务', message: {
        id: accepted.messageId, role: 'user', content: submission.content,
        source: { kind: 'user', rpcId: submission.requestId, clientTimeZone: 'Asia/Shanghai', parallelContentBlocks: 1 },
      } },
    })
    expect(parent.session.deriveMessages()).toEqual([])
    expect(parent.inbox.nextTurn).toHaveLength(0)
    expect(parent.inbox.nextStep).toHaveLength(0)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const reconnected = new SessionCommandController(ctx, agents, parent.session.header.cwd!)
    const changedRetry = { ...submission, content: [{ type: 'text' as const, text: 'A retry cannot replace the original.' }] }
    expect(await reconnected.dispatchParallel(changedRetry, signal())).toEqual(accepted)
    expect(start).toHaveBeenCalledTimes(1)
    expect(adapter.requests).toHaveLength(1)
    expect((await loadStoredSession(ctx.sessionPersistence, parent.id)).events.filter(event => event.type === 'parallel/dispatched')).toEqual(receipts)
  })

  it('stores ordered durable image and file references and authorizes the image from the parent receipt', async () => {
    const { ctx, parent, controller, request, resolveFile, admitPromptContent, readImage, retirePrompt } = await setup()
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: '方案.png',
    }
    const file: FileAttachmentRef = { attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`), name: '需求.txt', bytes: 6 }
    resolveFile.mockReturnValue(file)
    admitPromptContent.mockImplementation(async content => content.map(part => part.type === 'image' ? { type: 'image', attachment: image } : part) as never)
    readImage.mockResolvedValue({ ref: image, data: Uint8Array.from([1, 2, 3]) })
    const submission = { ...request(), content: [
      { type: 'text' as const, text: '结合图和文件执行。' },
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQID', name: '方案.png' },
      { type: 'file' as const, receiptId: 'owned-upload' as never },
      { type: 'text' as const, text: '\n保持原来顺序。' },
    ] }
    const accepted = await controller.dispatchParallel(submission, signal())
    const stored = await loadStoredSession(ctx.sessionPersistence, parent.id)
    const dispatched = stored.events.find(event => event.type === 'parallel/dispatched')
    expect(dispatched).toMatchObject({ data: { message: { id: accepted.messageId, content: [
      submission.content[0], { type: 'image', attachment: image }, { type: 'file', attachment: file }, submission.content[3],
    ] } } })
    expect(JSON.stringify(dispatched)).not.toContain('owned-upload')
    expect(JSON.stringify(dispatched)).not.toContain('AQID')
    expect(await controller.attachment({ sessionId: parent.id, attachmentId: image.attachmentId })).toEqual({ attachment: image, data: 'AQID' })
    expect(retirePrompt).toHaveBeenCalledWith(parent, submission.requestId)
    resolveFile.mockReturnValue(undefined)
    expect(await controller.dispatchParallel(submission, signal())).toEqual(accepted)
    expect(admitPromptContent).toHaveBeenCalledTimes(1)
    expect(parent.session.deriveMessages()).toEqual([])
  })

  it.each([false, true])('recovers a missing parent receipt without redispatch or internal guidance (legacy=%s)', async (legacy) => {
    const { ctx, parent, adapter, controller, request, agents } = await setup()
    await ctx.plugin(SubagentControl)
    const startContinuable = ctx.subagents.startContinuable.bind(ctx.subagents)
    let createdChild: SessionId | undefined
    const start = vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      if (legacy && spec.source?.kind === 'user' && 'parallelContentBlocks' in spec.source) {
        const { parallelContentBlocks: _count, ...source } = spec.source
        spec = { ...spec, source }
      }
      const accepted = await startContinuable(spec)
      createdChild = accepted.childId
      vi.spyOn(parent.session, 'append').mockImplementationOnce(() => { throw new Error('parent receipt write failed') })
      return accepted
    })
    const submission = { ...request(), label: '原始任务标签', content: [{ type: 'text' as const, text: '请解释引号里的文字：Your parent agent id is。\n保留这一句。' }] }
    await expect(controller.dispatchParallel(submission, signal())).rejects.toMatchObject({ code: 'gateway/internal' })
    expect(parent.session.snapshotEvents().filter(event => event.type === 'parallel/dispatched')).toHaveLength(0)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    if (createdChild === undefined) throw new Error('fixture did not start a child')
    using child = await ctx.sessionQuery.observeSession(createdChild)
    const original = child.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && 'rpcId' in event.data.source && event.data.source.rpcId === submission.requestId)
    expect(original?.type === 'user/message' && original.data.content).toHaveLength(2)
    const reconnected = new SessionCommandController(ctx, agents, parent.session.header.cwd!)
    const accepted = await reconnected.dispatchParallel({ ...submission, content: [{ type: 'text', text: 'changed retry' }] }, signal())
    const events = (await loadStoredSession(ctx.sessionPersistence, parent.id)).events.filter(event => event.type === 'parallel/dispatched')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ data: { ...accepted, label: '原始任务标签' } })
    if (legacy) expect(events[0]!.data.message).toBeUndefined()
    else expect(events[0]!.data.message).toMatchObject({ id: accepted.messageId, content: submission.content })
    expect(JSON.stringify(events)).not.toContain('send your result to that agent')
    expect(await reconnected.dispatchParallel(submission, signal())).toEqual(accepted)
    expect(start).toHaveBeenCalledTimes(1)
    expect(adapter.requests).toHaveLength(1)
    expect(parent.session.deriveMessages()).toEqual([])
  })
})
