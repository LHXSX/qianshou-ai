/** Durable human retirement preserves history and refuses only work in the addressed subtree. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '../src/index.ts'
import type { SubagentPromptRequestId } from '../src/control-types.ts'
import { establishCatalogChild } from '../src/catalog.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession, seedStoredSession } from './persistence-helpers.ts'

const contexts: Context[] = []
const roots: string[] = []
const signal = new AbortController().signal
const parentId = SessionId('retirement-parent')
const route = { provider: 'mock', model: 'mock' }

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of contexts.splice(0).reverse()) {
    try { await ctx.fiber.dispose() } catch (error) { failures.push(error) }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (failures.length) throw new AggregateError(failures, 'retirement fixture cleanup failed')
})

/** Reuse the source-level loop and JSONL fixture while allowing a fresh Host over the same files. */
async function bootHost(script: ConstructorParameters<typeof MockAdapter>[0], persistedRoot?: string, cacheRoot?: string) {
  const root = persistedRoot ?? mkdtempSync(join(tmpdir(), 'dsh-subagent-retirement-'))
  if (persistedRoot === undefined) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (cacheRoot !== undefined) {
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
      { root: cacheRoot })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  }
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, root }
}

/** Explicitly activate the parent only in fixtures that need to submit work. */
async function boot(script: ConstructorParameters<typeof MockAdapter>[0], persistedRoot?: string, cacheRoot?: string) {
  const host = await bootHost(script, persistedRoot, cacheRoot)
  const { ctx } = host
  const parent = persistedRoot === undefined
    ? await ctx.agentLoop.create(parentId, route)
    : (await ctx.agents.resume({ resumeSessionId: parentId, agentOptions: route })).agent
  return { ...host, parent }
}

/** Create a real idle loop with the same durable one-shot identity recorded by providers. */
async function employee(ctx: Context, parent: Agent, name: string) {
  const handle = await ctx.agents.create({
    sessionId: SessionId(name), parentAgent: parent,
    meta: { parentSession: parent.id, origin: 'subagent' }, agentOptions: route,
  })
  const descriptor = { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot' as const, provider: 'spawn', label: name }
  handle.agent.session.append('subagent/descriptor', descriptor)
  establishCatalogChild(parent.session, handle.agent.session.header, descriptor)
  await ctx.sessions.flush(handle.agent.session)
  await ctx.sessions.flush(parent.session)
  return handle.agent
}

const address = (parent: Agent, child: Agent) => ({ parentSessionId: parent.id, childSessionId: child.id, mode: 'one-shot' as const })

describe('durable subagent retirement', () => {
  it('replays retirement beyond a real stale checkpoint after restarting with a cold parent', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'dsh-retirement-cache-'))
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'dsh-retirement-checkpoint-'))
    roots.push(cacheRoot, checkpointRoot)
    const first = await boot([], undefined, cacheRoot)
    const child = await employee(first.ctx, first.parent, 'cached-before-retirement')
    await first.ctx.sessionProjectionCache.write(first.parent.session)
    const membershipKeys = ['subagentRetirements', 'subagentCatalog'] as const
    const oldSnapshot = first.ctx.sessionProjectionCache.cachedSnapshot(first.parent.session.header, SessionLogOffset(0), membershipKeys)
    expect(oldSnapshot?.values.subagentRetirements).toEqual([])
    expect(oldSnapshot?.values.subagentCatalog).toMatchObject([{ id: child.id }])
    // Save an actual valid checkpoint. Restoring it models a lost write-behind
    // update while retaining the later authoritative retirement in JSONL.
    cpSync(cacheRoot, checkpointRoot, { recursive: true })
    const childHistory = await loadStoredSession(first.ctx.sessionPersistence, child.id)
    await first.ctx.subagents.retire(address(first.parent, child), signal)
    const parentHistory = await loadStoredSession(first.ctx.sessionPersistence, first.parent.id)
    const retirement = parentHistory.events.find(event => event.type === 'subagent/retired')
    expect(retirement).toBeDefined()
    expect(oldSnapshot?.asOfSeq).toBeLessThan(retirement!.seq)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    rmSync(cacheRoot, { recursive: true, force: true })
    cpSync(checkpointRoot, cacheRoot, { recursive: true })

    const second = await bootHost([], first.root, cacheRoot)
    expect(second.ctx.sessions.get(parentId)).toBeUndefined()
    expect(second.ctx.agents.get(parentId)).toBeUndefined()
    expect(second.ctx.sessionProjectionCache.cachedSnapshot(parentHistory.meta, SessionLogOffset(0), membershipKeys)).toEqual(oldSnapshot)
    // This is the first membership read: no parent resume or earlier list can
    // repair the stale hint before the summary exclusion path is exercised.
    expect(await second.ctx.subagents.retiredSessionIds(signal)).toContain(child.id)
    expect((await second.ctx.subagents.remoteExportList(parentId, signal)).entries).toEqual([])
    expect(second.ctx.sessions.get(parentId)).toBeUndefined()
    expect(second.ctx.agents.get(child.id)).toBeUndefined()
    expect(second.adapter.requests).toHaveLength(0)
    expect((await loadStoredSession(second.ctx.sessionPersistence, child.id)).events).toEqual(childHistory.events)
  })

  it('keeps completed child history but refuses new delivery after a complete Host restart', async () => {
    const first = await boot([textResponse('completed child result')])
    const started = await first.ctx.subagents.startContinuable({
      provider: 'spawn', label: 'finished employee', signal,
      request: { parent: first.parent, prompt: [{ type: 'text', text: 'finish this task' }] },
    })
    await vi.waitFor(() => { expect(first.ctx.agents.get(started.childId)).toBeUndefined() }, { timeout: 5_000 })
    const before = await loadStoredSession(first.ctx.sessionPersistence, started.childId)
    expect(before.events.some(event => event.type === 'assistant/message')).toBe(true)
    const target = { parentSessionId: first.parent.id, childSessionId: started.childId, mode: 'continuable' as const }
    expect(await first.ctx.subagents.retire(target, signal)).toEqual({
      accepted: true, parentSessionId: first.parent.id, childSessionIds: [started.childId],
    })
    const committed = await loadStoredSession(first.ctx.sessionPersistence, first.parent.id)
    expect(committed.events.filter(event => event.type === 'subagent/retired')).toHaveLength(1)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await boot([], first.root)
    await expect(second.ctx.subagents.prompt({
      ...target, requestId: 'retired-after-restart' as SubagentPromptRequestId,
      delivery: 'queue', content: [{ type: 'text', text: 'must not run after retirement' }],
    }, signal)).rejects.toMatchObject({ code: 'subagent/retired' })
    expect(second.adapter.requests).toHaveLength(0)
    expect(second.ctx.agents.get(started.childId)).toBeUndefined()
    expect((await second.ctx.subagents.remoteExportList(second.parent.id, signal)).entries).toEqual([])
    expect(await second.ctx.subagents.retiredSessionIds(signal)).toContain(started.childId)
    expect((await loadStoredSession(second.ctx.sessionPersistence, started.childId)).events).toEqual(before.events)
    expect(await second.ctx.subagents.retire(target, signal)).toMatchObject({ accepted: true, childSessionIds: [started.childId] })
    expect((await loadStoredSession(second.ctx.sessionPersistence, second.parent.id)).events
      .filter(event => event.type === 'subagent/retired')).toHaveLength(1)
  })

  it('refuses an idle ancestor with a running grandchild without stopping that task', async () => {
    const { ctx, parent, adapter } = await boot(['hang'])
    const target = await employee(ctx, parent, 'idle-parent')
    const grandchild = await employee(ctx, target, 'working-grandchild')
    grandchild.followup(createUserMessage({ content: [{ type: 'text', text: 'keep working' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1); expect(grandchild.status).toBe('running') })
    const cancel = vi.spyOn(grandchild, 'cancel')
    await expect(ctx.subagents.retire(address(parent, target), signal)).rejects.toMatchObject({
      code: 'subagent/busy', details: { childSessionIds: [grandchild.id] },
    })
    expect(cancel).not.toHaveBeenCalled()
    expect(adapter.requests[0]?.signal?.aborted).toBe(false)
    expect(grandchild.status).toBe('running')
    expect(parent.session.snapshotEvents().some(event => event.type === 'subagent/retired')).toBe(false)
    expect((await ctx.subagents.remoteExportList(parent.id, signal)).entries).toMatchObject([{ id: target.id, retireBlocked: 'busy' }])
  })

  it.each(['next-turn', 'next-step'] as const)('refuses an idle ancestor with durable cold %s input and preserves that queue', async (targetQueue) => {
    const { ctx, parent, adapter } = await boot([])
    const target = await employee(ctx, parent, 'idle-with-cold-child')
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('cold-queued-child'), createdAt: 123,
      isSeeded: false, origin: 'subagent', parentSession: target.id }
    const queued = createUserMessage({ content: [{ type: 'text', text: 'accepted pending work' }], source: { kind: 'user' } })
    await seedStoredSession(ctx.sessionPersistence, header, [
      { type: 'subagent/descriptor', seq: SessionSeq(0), time: 123,
        data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'spawn', label: 'queued child' } },
      { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 124,
        data: { target: targetQueue, start: 0, removedCount: 0, inserted: [queued] } },
    ])
    establishCatalogChild(target.session, header, { mode: 'one-shot', label: 'queued child' })
    await ctx.sessions.flush(target.session)
    const before = await loadStoredSession(ctx.sessionPersistence, header.id)
    expect(ctx.agents.get(header.id)).toBeUndefined()
    await expect(ctx.subagents.retire(address(parent, target), signal)).rejects.toMatchObject({
      code: 'subagent/busy', details: { childSessionIds: [header.id] },
    })
    expect((await loadStoredSession(ctx.sessionPersistence, header.id)).events).toEqual(before.events)
    expect(parent.session.snapshotEvents().some(event => event.type === 'subagent/retired')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.agents.get(header.id)).toBeUndefined()
  })

  it('retires an idle target while an unrelated sibling continues its current task', async () => {
    const { ctx, parent, adapter } = await boot(['hang'])
    const target = await employee(ctx, parent, 'finished-target')
    const sibling = await employee(ctx, parent, 'busy-sibling')
    sibling.followup(createUserMessage({ content: [{ type: 'text', text: 'independent work' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1); expect(sibling.status).toBe('running') })
    const cancel = vi.spyOn(sibling, 'cancel')
    expect(await ctx.subagents.retire(address(parent, target), signal)).toEqual({
      accepted: true, parentSessionId: parent.id, childSessionIds: [target.id],
    })
    expect(cancel).not.toHaveBeenCalled()
    expect(adapter.requests[0]?.signal?.aborted).toBe(false)
    expect(sibling.status).toBe('running')
    expect((await ctx.subagents.remoteExportList(parent.id, signal)).entries).toMatchObject([{ id: sibling.id, activity: 'running' }])
  })
})
