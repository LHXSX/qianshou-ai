/** Team-scoped delivery exercises the real continuation executor and durable messages. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { continuationManager } from '../../subagent/tests/continuation-internals.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import * as control from '../src/index.ts'
import * as discovery from '../src/list-agents.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { parkParent } from './park-parent.ts'

class TeamAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = []
  readonly script: Array<Promise<void> | undefined> = []
  gate() {
    const gate = Promise.withResolvers<void>()
    this.gates.push(gate)
    this.script.push(gate.promise)
    return gate
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.script.shift()
    yield* textResponse('Employee final result')
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const signal = new AbortController().signal
const content = (text: string) => [{ type: 'text' as const, text }]
let callId = 0
const call = (ctx: Context, name: string, args: unknown, agent: Agent) => ctx.tools.execute({
  name, arguments: args, agent, signal, callId: ToolCallId(`team-${++callId}`),
})

async function setup(enabled = true, throughLoader = false) {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'qianshou-team-'))
  const adapter = new TeamAdapter()
  cleanups.push(async () => {
    adapter.gates.forEach(gate => gate.resolve())
    await continuationManager(ctx).drain()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  let controls: { dispose(): void | Promise<void> }
  if (throughLoader) {
    const configPath = join(root, 'cordis.yml')
    writeFileSync(configPath, [
      "- name: '@deepseek-ai/dsh-tool-subagent-control'",
      '  config:', `    siblingMessaging: ${enabled}`,
      "- name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
      '  config:', `    siblingMessaging: ${enabled}`, '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-tool-subagent-control', control],
      ['@deepseek-ai/dsh-tool-subagent-control/list-agents', discovery],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    controls = { dispose: () => ctx.loader.remove(entry) }
  } else {
    controls = await ctx.plugin(control, { siblingMessaging: enabled })
    await ctx.plugin(discovery, { siblingMessaging: enabled })
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('ceo'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  const start = async (label: string, owner = parent) => {
    const previous = adapter.requests.length
    const started = await ctx.subagents.startContinuable({ provider: 'spawn', label, childId: SessionId(label),
      request: { parent: owner, prompt: content(label) }, signal })
    await vi.waitFor(() => expect(adapter.requests.length).toBeGreaterThan(previous))
    return started.childId
  }
  const live = (id: SessionId) => {
    const agent = ctx.agents.get(id)
    if (agent === undefined) throw new Error('expected resident employee')
    return agent
  }
  const gone = (id: SessionId) => vi.waitFor(() => expect(ctx.agents.get(id) === undefined).toBe(true), { timeout: 5_000 })
  return { ctx, parent, adapter, controls, start, live, gone }
}

describe('opted-in sibling messaging', () => {
  it('loads the opt-in through cordis.yml and records the teammate exchange', async () => {
    const { ctx, adapter, start, live, gone } = await setup(true, true)
    const writerGate = adapter.gate(); const reviewerGate = adapter.gate()
    const writer = live(await start('writer')); const reviewerId = await start('reviewer')
    const listing = await call(ctx, 'list_agents', { scope: 'siblings' }, writer)
    const receipt = await call(ctx, 'send_message', { agent_id: reviewerId, message: 'Please review the agreed audience.' }, writer)
    reviewerGate.resolve(); await gone(reviewerId)
    const stored = await loadStoredSession(ctx.sessionPersistence, reviewerId)
    const messageEvent = stored.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'agent-message').at(-1)
    const message = messageEvent?.type === 'user/message' ? messageEvent.data : undefined
    expect({ listing: listing.content, receipt: receipt.content, source: message?.source, content: message?.content })
      .toMatchInlineSnapshot(`
        {
          "content": [
            {
              "text": "Agent writer sent a message: ",
              "type": "text",
            },
            {
              "text": "Please review the agreed audience.",
              "type": "text",
            },
          ],
          "listing": [
            {
              "text": "reviewer [running] — reviewer",
              "type": "text",
            },
          ],
          "receipt": [
            {
              "text": "message delivered to agent reviewer",
              "type": "text",
            },
          ],
          "source": {
            "form": "relay",
            "kind": "agent-message",
            "senderSessionId": "writer",
          },
        }
      `)
    writerGate.resolve()
  })

  it('keeps default tools and executor limited to adjacent agents', async () => {
    const { ctx, adapter, start, live } = await setup(false)
    adapter.gate(); adapter.gate()
    const sender = live(await start('writer'))
    const recipient = await start('reviewer')
    await expect(ctx.subagents.sendMessage(sender, recipient, content('private finding'), { signal }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(ctx.subagents.listSiblings(sender, signal)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const schema = ctx.tools.schemas(sender).find(tool => tool.name === 'list_agents')
    expect(schema?.parameters).toMatchObject({ properties: { scope: { enum: ['children', 'descendants'] } } })
  })

  it('discovers same-team ids and durably attributes a busy-peer message to its employee author', async () => {
    const { ctx, adapter, start, live, gone } = await setup()
    const writerGate = adapter.gate(); const reviewerGate = adapter.gate()
    const writerId = await start('writer'); const reviewerId = await start('reviewer')
    const writer = live(writerId)
    const listed = await call(ctx, 'list_agents', { scope: 'siblings' }, writer)
    expect(listed.isError).toBe(false)
    expect(listed.content).toEqual([{ type: 'text', text: `${reviewerId} [running] — reviewer` }])
    const inserted: unknown[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.id === reviewerId && message.source.kind === 'agent-message') inserted.push(message)
    })
    const sent = await call(ctx, 'send_message', { agent_id: reviewerId, message: 'Check the audience and three claims.' }, writer)
    expect(sent.isError).toBe(false)
    expect(sent.content).toEqual([{ type: 'text', text: `message delivered to agent ${reviewerId}` }])
    expect(inserted).toMatchObject([{ source: { kind: 'agent-message', form: 'relay', senderSessionId: writerId },
      content: [{ type: 'text', text: `Agent ${writerId} sent a message: ` }, { type: 'text', text: 'Check the audience and three claims.' }] }])
    reviewerGate.resolve(); await gone(reviewerId)
    const stored = await loadStoredSession(ctx.sessionPersistence, reviewerId)
    expect(stored.events).toContainEqual(expect.objectContaining({ type: 'user/message', data: expect.objectContaining({
      source: { kind: 'agent-message', form: 'relay', senderSessionId: writerId },
    }) }))
    writerGate.resolve()
  })

  it('cold-resumes a ready colleague with its same durable id and employee attribution', async () => {
    const { ctx, adapter, start, live, gone } = await setup()
    adapter.script.push(undefined)
    const reviewerId = await start('reviewer'); await gone(reviewerId)
    const writerGate = adapter.gate()
    const writerId = await start('writer'); const writer = live(writerId)
    expect((await call(ctx, 'list_agents', { scope: 'siblings' }, writer)).content)
      .toEqual([{ type: 'text', text: `${reviewerId} [ready] — reviewer` }])
    await ctx.subagents.sendMessage(writer, reviewerId, content('Review revision two.'), { signal })
    await gone(reviewerId)
    const stored = await loadStoredSession(ctx.sessionPersistence, reviewerId)
    expect(stored.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(stored.events.filter(event => event.type === 'user/message').at(-1)?.data)
      .toMatchObject({ source: { senderSessionId: writerId }, content: [{ type: 'text', text: `Agent ${writerId} sent a message: ` }, { type: 'text', text: 'Review revision two.' }] })
    writerGate.resolve()
  })

  it('rejects self, cross-root, cross-team, one-shot, stale senders and sibling interruption', async () => {
    const { ctx, parent, adapter, start, live, gone } = await setup()
    adapter.gate(); const senderId = await start('writer'); const sender = live(senderId)
    adapter.gate(); const peerId = await start('reviewer')
    const other = await ctx.agentLoop.create(SessionId('other-ceo'), { provider: 'mock', model: 'mock' })
    parkParent(ctx, other)
    adapter.gate(); const foreignId = await start('foreign-team', other)
    adapter.gate(); const nestedId = await start('other-direct-team', live(peerId))
    const once = await ctx.subagents.start('spawn', { parent, label: 'one shot', prompt: content('one shot'), signal })
    await once.result; await ctx.sessions.flush(once.localAgent!.session); await once.dispose()
    for (const id of [senderId, foreignId, nestedId, once.id]) {
      await expect(ctx.subagents.sendMessage(sender, id, content('forbidden'), { signal }))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
    expect((await ctx.subagents.listSiblings(sender, signal)).map(entry => entry.id)).toEqual([peerId])
    expect((await call(ctx, 'interrupt_agent', { agent_id: peerId }, sender)).isError).toBe(true)
    adapter.gates[0]!.resolve(); await gone(senderId)
    await expect(ctx.subagents.sendMessage(sender, peerId, content('stale author'), { signal }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('revokes service authority when the opted-in control plugin disposes', async () => {
    const { ctx, adapter, controls, start, live } = await setup()
    adapter.gate(); adapter.gate()
    const sender = live(await start('writer')); const recipient = await start('reviewer')
    await controls.dispose()
    await expect(ctx.subagents.sendMessage(sender, recipient, content('after revoke'), { signal }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(ctx.subagents.listSiblings(sender, signal)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('rechecks a revoked grant after asynchronous target lookup before accepting any message', async () => {
    const { ctx, adapter, controls, start, live } = await setup()
    adapter.gate(); adapter.gate()
    const sender = live(await start('writer')); const recipient = await start('reviewer')
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const waiting = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
      const observation = await original(id, options)
      if (id === recipient) { waiting.resolve(); await release.promise }
      return observation
    })
    const received: unknown[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.id === recipient && message.source.kind === 'agent-message') received.push(message)
    })
    const pending = ctx.subagents.sendMessage(sender, recipient, content('racing revoke'), { signal })
    const outcome = expect(pending).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await waiting.promise; await controls.dispose(); release.resolve(); await outcome
    expect(received).toEqual([])
  })

  it('does not let a grant in another preset scope authorize the calling team', async () => {
    const { ctx, parent, adapter, start, live } = await setup(false)
    const preset = createScope(ctx, {})
    await preset.ctx.plugin({ inject: ['subagents'], apply: (scope: Context) => { scope.subagents.registerSiblingMessaging() } })
    adapter.gate(); adapter.gate()
    const sender = live(await start('writer')); const recipient = await start('reviewer')
    await expect(ctx.subagents.sendMessage(sender, recipient, content('outside grant'), { signal }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const ownerScope = scopeOf(parent.ctx)
    if (ownerScope === undefined) throw new Error('agent scope missing')
    bindScopeParent(ownerScope, scopeOf(preset.ctx)!)
    await expect(ctx.subagents.sendMessage(sender, recipient, content('inside grant'), { signal })).resolves.toBeTypeOf('string')
    await preset.dispose()
    await expect(ctx.subagents.sendMessage(sender, recipient, content('scope disposed'), { signal }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
