/** Exercise contribution isolation against the real DSH registry and Agent loop. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { readHostForegroundTaskActivity } from '@deepseek-ai/dsh-compute-core'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, maxTokensResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createIsolatedAgentSession } from '../src/isolated-agent.ts'
import { resolveIsolatedRoute } from '../src/plugin.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function host() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('PC owner and contribution sessions', () => {
  it('measures absence as unknown and an empty live registry as idle', async () => {
    expect(readHostForegroundTaskActivity(new Context())).toBeNull()
    expect(readHostForegroundTaskActivity(await host())).toBe(false)
  })

  it('returns a real loop result and drains the isolated agent', async () => {
    const ctx = await host()
    const adapter = new MockAdapter([textResponse('task result')], {
      efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
    })
    ctx.llm.registerAdapter(['worker'], adapter)
    const route = resolveIsolatedRoute('worker', 'small', 'off')
    if (route === null) throw new Error('expected configured isolated route')
    const session = createIsolatedAgentSession(ctx, route)
    await expect(session.run({ taskType: 'text', inlineInput: 'finish task', signal: new AbortController().signal }))
      .resolves.toEqual({ text: 'task result' })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.reasoningEffort).toBe(ReasoningEffortId('off'))
    expect(ctx.agents.list()).toHaveLength(0)
    expect(readHostForegroundTaskActivity(ctx)).toBe(false)
  })

  it('keeps owner activity, context and cancellation separate from contribution', async () => {
    const ctx = await host()
    const ownerAdapter = new MockAdapter(['hang'])
    const workerAdapter = new MockAdapter(['hang'])
    ctx.llm.registerAdapter(['owner'], ownerAdapter)
    ctx.llm.registerAdapter(['worker'], workerAdapter)
    // A similar session name does not grant background status.
    const owner = await ctx.agents.create({ sessionId: SessionId('qianshou.node.owner'),
      agentOptions: { provider: 'owner', model: 'private' } })
    const abort = new AbortController()
    const session = createIsolatedAgentSession(ctx, { provider: 'worker', model: 'small' })
    const work = session.run({ taskType: 'text', inlineInput: 'public assignment', signal: abort.signal })
    const stopped = expect(work).rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_ABORTED' })
    await expect.poll(() => workerAdapter.requests.length).toBe(1)
    expect(readHostForegroundTaskActivity(ctx)).toBe(false)
    owner.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'private owner conversation' }], source: { kind: 'user' } }))
    await expect.poll(() => ownerAdapter.requests.length).toBe(1)
    expect(readHostForegroundTaskActivity(ctx)).toBe(true)
    expect(JSON.stringify(workerAdapter.requests)).not.toContain('private owner conversation')
    expect(JSON.stringify(ownerAdapter.requests)).not.toContain('public assignment')
    abort.abort()
    await stopped
    expect(ctx.agents.list()).toEqual([owner.agent])
    expect(owner.agent.status).toBe('running')
    expect(readHostForegroundTaskActivity(ctx)).toBe(true)
    owner.agent.cancel({ kind: 'user' })
    await owner.agent.whenIdle()
    expect(readHostForegroundTaskActivity(ctx)).toBe(false)
    await owner.dispose()
  })

  it.each(['error', 'max-tokens'] as const)('does not deliver a %s model turn as successful work', async (reason) => {
    const ctx = await host()
    const adapter = new MockAdapter(reason === 'max-tokens' ? [maxTokensResponse('incomplete result')] : [])
    ctx.llm.registerAdapter(['worker'], adapter)
    const session = createIsolatedAgentSession(ctx, { provider: 'worker', model: 'small' })
    await expect(session.run({ taskType: 'text', inlineInput: 'finish task', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_INCOMPLETE' })
    expect(ctx.agents.list()).toHaveLength(0)
  })
})
