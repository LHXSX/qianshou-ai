import { describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createIsolatedInlineRunner } from '@deepseek-ai/dsh-compute-core'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createIsolatedAgentSession } from '../src/isolated-agent.ts'

function contextWith(agents: unknown, presets?: unknown): Context {
  return {
    get: (name: string) => name === 'agents' ? agents : name === 'agentPresets' ? presets : undefined,
  } as Context
}

function handle(events: readonly unknown[], extra: {
  whenIdle?: () => Promise<void>
  dispose?: () => Promise<void>
} = {}) {
  const agent = {
    followup: vi.fn(),
    whenIdle: extra.whenIdle ?? (async () => undefined),
    cancel: vi.fn(),
    session: {
      snapshotEvents: (from: ReturnType<typeof SessionLogOffset>) => {
        expect(from).toBe(SessionLogOffset(0))
        return events
      },
    },
  }
  return {
    agent,
    dispose: extra.dispose ?? vi.fn(async () => undefined),
  }
}

describe('isolated agent session', () => {
  it('refuses when the Host has no agent registry', async () => {
    const run = createIsolatedAgentSession(contextWith(undefined), {
      provider: 'local-ollama',
      model: 'llama3.2:latest',
    })
    await expect(run.run({
      taskType: 'ocr_image',
      inlineInput: 'goal',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_ISOLATED_SESSION_UNAVAILABLE' })
  })

  it('creates a fresh session on the explicit route and returns last assistant text', async () => {
    const published = handle([
      { type: 'turn/start', data: {} },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'reasoning', text: 'think' }] } },
      },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'first' }] } },
      },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'final answer' }] } },
      },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ])
    const agentCtx = { id: 'node-agent' }
    const mount = vi.fn(async () => ({ id: 'standard' }))
    const ownerWorkspaceRoot = join(homedir(), 'private-owner-attempts')
    let privateCwd = ''
    const create = vi.fn(async (options: {
      sessionId: string
      agentOptions: { provider: string; model: string }
      meta?: { cwd?: string }
      setup?: (scope: typeof agentCtx) => Promise<void>
    }) => {
      expect(options.agentOptions).toEqual({ provider: 'local-ollama', model: 'llama3.2:latest' })
      privateCwd = options.meta?.cwd ?? ''
      expect(privateCwd).not.toBe(ownerWorkspaceRoot)
      expect(privateCwd).toContain('qianshou-order-')
      expect((await stat(privateCwd)).isDirectory()).toBe(true)
      expect(options.sessionId.startsWith('qianshou.node.')).toBe(true)
      await options.setup?.(agentCtx)
      expect(mount).toHaveBeenCalledWith(agentCtx)
      return published
    })
    const run = createIsolatedAgentSession(contextWith({ create }, { mount }), {
      provider: 'local-ollama',
      model: 'llama3.2:latest',
      ownerWorkspaceRoot,
    })
    await expect(run.run({
      taskType: 'ocr_image',
      inlineInput: 'count items',
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: 'final answer' })
    expect(published.agent.followup).toHaveBeenCalledTimes(1)
    const message = published.agent.followup.mock.calls[0]?.[0] as { content: readonly { type: string; text: string }[] }
    expect(message.content[0]?.text).toBe('count items')
    expect(published.dispose).toHaveBeenCalledTimes(1)
    await expect(stat(privateCwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('hides unrequested host paths in both delivered fields but preserves the path supplied by the customer', async () => {
    const ownerWorkspaceRoot = join(homedir(), 'private-owner-attempts')
    const customerPath = join(homedir(), 'shared', 'requested.txt')
    let privateCwd = ''
    const create = vi.fn(async (options: { meta: { cwd: string } }) => {
      privateCwd = options.meta.cwd
      return handle([
        { type: 'assistant/message', data: { message: { content: [{ type: 'text',
          text: `你好。工作区：${ownerWorkspaceRoot}/task-1；临时目录：${privateCwd}。请求文件：${customerPath}` }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ])
    })
    const agent = createIsolatedAgentSession(contextWith({ create }), {
      provider: 'local-ollama', model: 'small', ownerWorkspaceRoot,
    })
    const run = createIsolatedInlineRunner({ agent, agentTaskTypes: ['word_count'] })
    const { text } = await run({
      taskType: 'word_count', inlineInput: `请返回 ${customerPath} 的结果`, signal: new AbortController().signal,
    })
    const result = JSON.parse(text) as { summary_text: string; result_lines: string[] }
    expect(result.summary_text).toBe(result.result_lines[0])
    expect(result.summary_text).toContain('你好。工作区：')
    expect(result.summary_text).toContain('【本机路径已隐藏】')
    expect(result.summary_text).toContain(customerPath)
    expect(text).not.toContain(ownerWorkspaceRoot)
    expect(text).not.toContain(privateCwd)
    await expect(stat(privateCwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['Windows drive', 'C:\\Users\\Ada\\private orders'],
    ['UNC share', '\\\\fileserver\\ada\\private orders'],
  ])('hides an unrequested %s child path including its backslash suffix', async (_kind, ownerWorkspaceRoot) => {
    const privatePath = `${ownerWorkspaceRoot}\\secrets\\draft.txt`
    const requestedPath = `${ownerWorkspaceRoot}\\shared\\requested.txt`
    const create = vi.fn(async () => handle([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text',
        text: `你好。内部：${privatePath}；客户文件：${requestedPath}` }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]))
    const agent = createIsolatedAgentSession(contextWith({ create }), {
      provider: 'local-ollama', model: 'small', ownerWorkspaceRoot,
    })
    const run = createIsolatedInlineRunner({ agent, agentTaskTypes: ['word_count'] })
    const { text } = await run({
      taskType: 'word_count', inlineInput: `请返回 ${requestedPath}`, signal: new AbortController().signal,
    })
    const result = JSON.parse(text) as { summary_text: string; result_lines: string[] }
    expect(result.summary_text).toBe(result.result_lines[0])
    expect(result.summary_text).toContain('你好。内部：【本机路径已隐藏】；客户文件：')
    expect(result.summary_text).toContain(requestedPath)
    expect(text).not.toContain(privatePath)
    expect(text).not.toContain('secrets\\draft.txt')
  })

  it('maps factory failure to unavailable and aborts before the model turn', async () => {
    const create = vi.fn(async () => {
      throw new Error('no adapter')
    })
    const run = createIsolatedAgentSession(contextWith({ create }), {
      provider: 'local-ollama',
      model: 'llama3.2:latest',
    })
    await expect(run.run({
      taskType: 'ocr_image',
      inlineInput: 'goal',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_ISOLATED_SESSION_UNAVAILABLE' })
    const aborted = new AbortController()
    aborted.abort()
    const published = handle([])
    const createOk = vi.fn(async () => published)
    const aborting = createIsolatedAgentSession(contextWith({ create: createOk }), {
      provider: 'local-ollama',
      model: 'llama3.2:latest',
    })
    await expect(aborting.run({
      taskType: 'ocr_image',
      inlineInput: 'goal',
      signal: aborted.signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_ABORTED' })
    expect(published.agent.followup).not.toHaveBeenCalled()
    expect(createOk).not.toHaveBeenCalled()
    expect(published.dispose).not.toHaveBeenCalled()
  })

  it('cancels unpublished creation through the registry signal', async () => {
    const abort = new AbortController()
    const create = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('setup aborted')) }, { once: true })
    }))
    const session = createIsolatedAgentSession(contextWith({ create }), { provider: 'local', model: 'small' })
    const result = session.run({ taskType: 'text', inlineInput: 'goal', signal: abort.signal })
    const rejected = expect(result).rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_ABORTED' })
    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    expect(create.mock.calls[0]?.[0].signal).toBe(abort.signal)
    abort.abort()
    await rejected
  })

  it('drains a handle if cancellation races with successful publication', async () => {
    const abort = new AbortController()
    const published = handle([])
    const session = createIsolatedAgentSession(contextWith({ create: async () => {
      abort.abort()
      return published
    } }), { provider: 'local', model: 'small' })
    await expect(session.run({ taskType: 'text', inlineInput: 'goal', signal: abort.signal }))
      .rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_ABORTED' })
    expect(published.agent.followup).not.toHaveBeenCalled()
    expect(published.dispose).toHaveBeenCalledTimes(1)
  })

  it('cancels an in-flight turn when the attempt aborts', async () => {
    const signal = new AbortController()
    const published = handle([], {
      whenIdle: async () => {
        signal.abort()
        await new Promise(resolve => setTimeout(resolve, 0))
      },
    })
    const run = createIsolatedAgentSession(contextWith({ create: async () => published }), {
      provider: 'local-ollama',
      model: 'llama3.2:latest',
    })
    await expect(run.run({
      taskType: 'ocr_image',
      inlineInput: 'goal',
      signal: signal.signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_ABORTED' })
    expect(published.agent.cancel).toHaveBeenCalledWith({ kind: 'parent' })
    expect(published.dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty result instead of reporting an empty successful delivery', async () => {
    const published = handle([
      { type: 'assistant/attempt', data: { stream: [] } },
      { type: 'assistant/message', data: { message: { content: [] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ])
    const run = createIsolatedAgentSession(contextWith({ create: async () => published }), {
      provider: 'local-ollama',
      model: 'llama3.2:latest',
    })
    await expect(run.run({
      taskType: 'ocr_image',
      inlineInput: 'goal',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_INCOMPLETE' })
    expect(published.dispose).toHaveBeenCalledTimes(1)
  })
})
