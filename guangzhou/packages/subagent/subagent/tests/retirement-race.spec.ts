import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '../src/index.ts'
import { establishCatalogChild } from '../src/catalog.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from './test-session-query.ts'
import LocalJobRegistry from '../../../jobs/jobs-local/src/index.ts'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const signal = new AbortController().signal

class HeldAdapter extends LlmAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.entered.resolve(undefined)
    await this.release.promise
    yield* textResponse('completed')
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retire-race-'))
  const ctx = new Context()
  const adapter = new HeldAdapter()
  cleanups.push(async () => {
    adapter.release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('root'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

async function employee(ctx: Context, parent: Agent, id: string) {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id), meta: { origin: 'subagent', parentSession: parent.id },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  handle.agent.session.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'fixture', label: id })
  establishCatalogChild(parent.session, handle.agent.session.header, { mode: 'one-shot', label: id })
  await ctx.sessions.flush(handle.agent.session)
  return handle.agent
}

function address(parent: Agent, child: Agent) {
  return { parentSessionId: parent.id, childSessionId: child.id, mode: 'one-shot' as const }
}

async function gateCorpus(ctx: Context) {
  const captured = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const list = ctx.sessionQuery.listSessions.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'listSessions').mockImplementationOnce(async (supplied) => {
    const rows = await list(supplied)
    captured.resolve(undefined)
    await release.promise
    return rows
  })
  return { captured: captured.promise, release: () => { release.resolve(undefined) } }
}

describe('retirement admission and durability boundaries', () => {
  it('refuses an idle driver that still owns a running background job without cancelling it', async () => {
    const { ctx, parent } = await setup()
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('retirement-test')
    const target = await employee(ctx, parent, 'target')
    const done = Promise.withResolvers<JobOutcome>()
    const cancel = vi.fn(() => { done.resolve({ status: 'killed' }) })
    const job = ctx.jobs.start({ kind: 'bash', label: 'isolated background work', owner: target, run: () => ({ done: done.promise, cancel }) })
    expect(target.status).toBe('idle')
    await expect(ctx.subagents.retire(address(parent, target), signal)).rejects.toMatchObject({ code: 'subagent/busy' })
    expect(ctx.jobs.list(target).find(item => item.id === job)?.status).toBe('running')
    expect(cancel).not.toHaveBeenCalled()
    done.resolve({ status: 'completed' })
    await vi.waitFor(() => { expect(ctx.jobs.list(target).find(item => item.id === job)?.status).toBe('completed') })
    await expect(ctx.subagents.retire(address(parent, target), signal)).resolves.toMatchObject({ accepted: true })
  })

  it('refuses a subtree when a new running grandchild was published after the header snapshot', async () => {
    const { ctx, parent, adapter } = await setup()
    const target = await employee(ctx, parent, 'target')
    const gate = await gateCorpus(ctx)
    const retirement = ctx.subagents.retire(address(parent, target), signal)
    const refused = expect(retirement).rejects.toMatchObject({ code: 'subagent/busy' })
    await gate.captured
    const child = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'new descendant', request: { parent: target, prompt: [{ type: 'text', text: 'work' }] }, signal })
    await adapter.entered.promise
    gate.release()
    await refused
    expect(ctx.agents.get(child.childId)?.status).toBe('running')
    expect(parent.session.snapshotEvents().some(event => event.type === 'subagent/retired')).toBe(false)
  })

  it('allows retiring an idle employee while an unrelated sibling starts a running child', async () => {
    const { ctx, parent, adapter } = await setup()
    const target = await employee(ctx, parent, 'target')
    const sibling = await employee(ctx, parent, 'sibling')
    const gate = await gateCorpus(ctx)
    const retirement = ctx.subagents.retire(address(parent, target), signal)
    await gate.captured
    const child = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'other team work', request: { parent: sibling, prompt: [{ type: 'text', text: 'work' }] }, signal })
    await adapter.entered.promise
    gate.release()
    await expect(retirement).resolves.toMatchObject({ accepted: true, childSessionIds: [target.id] })
    expect(ctx.agents.get(child.childId)?.status).toBe('running')
    expect((await ctx.subagents.retiredSessionIds()).has(child.childId)).toBe(false)
  })

  it('keeps ordinary user forks and their own employees outside retirement ownership', async () => {
    const { ctx, parent } = await setup()
    const target = await employee(ctx, parent, 'target')
    const fork = await ctx.agents.create({ sessionId: SessionId('user-fork'), meta: { parentSession: target.id }, agentOptions: { provider: 'mock', model: 'mock' } })
    const forkEmployee = await employee(ctx, fork.agent, 'fork-employee')
    await expect(ctx.subagents.retire(address(parent, target), signal)).resolves.toMatchObject({ childSessionIds: [target.id] })
    const removed = await ctx.subagents.retiredSessionIds()
    expect(removed.has(fork.agent.id)).toBe(false)
    expect(removed.has(forkEmployee.id)).toBe(false)
    await expect(ctx.agents.create({ sessionId: SessionId('late-owned-child'),
      meta: { origin: 'subagent', parentSession: target.id }, agentOptions: { provider: 'mock', model: 'mock' },
    })).rejects.toMatchObject({ code: 'RETIRED' })
    expect(ctx.agents.get(SessionId('late-owned-child'))).toBeUndefined()
  })

  it('does not acknowledge a failed flush and retries the same committed decision without duplicate events', async () => {
    const { ctx, parent } = await setup()
    const target = await employee(ctx, parent, 'target')
    const notified = vi.fn()
    ctx.on('subagents/retired', notified)
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(ctx.subagents.retire(address(parent, target), signal)).rejects.toMatchObject({ code: 'gateway/internal' })
    expect(notified).not.toHaveBeenCalled()
    await expect(ctx.subagents.startContinuable({ provider: 'spawn', label: 'must not start', request: { parent: target, prompt: [] }, signal })).rejects.toMatchObject({ code: 'RETIRED' })
    await expect(ctx.subagents.retire(address(parent, target), signal)).resolves.toMatchObject({ accepted: true })
    expect(notified).toHaveBeenCalledOnce()
    expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/retired')).toHaveLength(1)
  })

  it('contains an unreadable historical parent without hiding an unrelated healthy project', async () => {
    const { ctx, parent } = await setup()
    const healthy = await employee(ctx, parent, 'healthy')
    const damaged = await ctx.agents.create({ sessionId: SessionId('damaged-project'), agentOptions: { provider: 'mock', model: 'mock' } })
    const unknown = await employee(ctx, damaged.agent, 'unknown-employee')
    await ctx.sessions.flush(damaged.agent.session)
    await damaged.dispose()
    expect(ctx.sessions.get(damaged.agent.id)).toBeUndefined()
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id, options) => {
      if (id === damaged.agent.id) return Promise.reject(new Error('one damaged historical log'))
      return observe(id, options)
    })
    expect(await ctx.subagents.listChildren(parent.id)).toEqual([expect.objectContaining({ kind: 'child', id: healthy.id })])
    expect(await ctx.subagents.listChildren(damaged.agent.id)).toEqual([{ kind: 'diagnostic', id: unknown.id, reason: 'unavailable' }])
    const excluded = await ctx.subagents.retiredSessionIds()
    expect(excluded.has(parent.id)).toBe(false)
    expect(excluded.has(healthy.id)).toBe(false)
    expect(excluded.has(unknown.id)).toBe(true)
  })
})
