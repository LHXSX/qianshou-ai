/** Loader-composed real AgentLoop, SessionController and JSONL; no external model request. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { sessionPort } from '../src/session-port.ts'
import { ConnectStore } from '../src/store.ts'
import { ConnectService } from '../src/service.ts'

const contexts: Context[] = [], directories: string[] = [], services: ConnectService[] = []
afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.dispose()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})
async function boot(root: string) {
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime], ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop], ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
    ['fixture/controller', { inject: ['agents', 'sessions', 'llm', 'sessionProjections'], apply: (ctx: Context) => {
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      createSessionTestController(ctx, { defaultModelSelection: () => ({ provider: 'not-used', model: 'not-used' }), cwd: root })
    } }],
  ])
  const configs: Record<string, unknown> = { '@deepseek-ai/dsh-agent-loop': { agents: [] }, '@deepseek-ai/dsh-system-prompt': { personaPrefix: '' },
    '@deepseek-ai/dsh-session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' } }
  const filename = join(root, 'cordis.yml')
  await writeFile(filename, [...modules.keys()].map(name => `- name: '${name}'${configs[name] ? `\n  config: ${JSON.stringify(configs[name])}` : ''}`).join('\n') + '\n')
  const ctx = new Context(); contexts.push(ctx); ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw new Error('Unexpected fixture module'); return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } }); await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}
async function directory() { const root = await mkdtemp(join(tmpdir(), 'connect-session-loader-')); directories.push(root); return root }

it('recovers a persisted inbox-only admission after restart without activating an Agent or duplicating a message', async () => {
  const root = await directory(), ctx = await boot(root), id = SessionId('cold-inbox-connection')
  const agent = await ctx.agentLoop.create(id, {}, { cwd: root })
  const storePath = join(root, 'connection.sqlite'), store = await ConnectStore.open(storePath, 4, 10)
  const service = new ConnectService(store, sessionPort(ctx), 4, 1000); services.push(service)
  const created = await service.create({ sessionId: id, label: 'Synthetic cold recovery', mode: 'text', durationMinutes: 60 })
  const token = created.path.split('#')[1]!, claimed = store.claim(created.grant.id, 'stable_request_01', 'PersistedInboxMarker')
  agent.inbox.append('next-turn', createUserMessage({ content: [{ type: 'text', text: 'PersistedInboxMarker' }], source: { kind: 'user', rpcId: claimed.rpcId } }))
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
  expect(await ctx.sessions.flush(agent.session)).toBe(true)
  await service.dispose(); await ctx.fiber.dispose()
  const restored = await boot(root), restoredStore = await ConnectStore.open(storePath, 4, 10)
  const restoredService = new ConnectService(restoredStore, sessionPort(restored), 4, 1000); services.push(restoredService)
  expect(restored.agents.get(id)).toBeUndefined(); expect(restored.sessions.get(id)).toBeUndefined()
  await expect(restoredService.receipt(token, 'stable_request_01', new AbortController().signal)).resolves.toMatchObject({ state: 'received' })
  expect(restored.agents.get(id)).toBeUndefined(); expect(restored.sessions.get(id)).toBeUndefined()
  const inspected = await restored.sessionController.inspect(id)
  expect(inspected.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === claimed.rpcId))).toHaveLength(1)
}, 20000)

it('waits for the actual Session flush before publishing received, and cancels admission after late activation', async () => {
  const root = await directory(), ctx = await boot(root), id = SessionId('direct-connection-admission')
  const agent = await ctx.agentLoop.create(id, {}, { cwd: root })
  // Retain the real durable Inbox while preventing an external model request in this fixture.
  const followup = vi.spyOn(agent, 'followup').mockImplementation((message) => { agent.inbox.append('next-turn', message) })
  const store = await ConnectStore.open(join(root, 'connection.sqlite'), 4, 10)
  const service = new ConnectService(store, sessionPort(ctx), 4, 1000); services.push(service)
  const created = await service.create({ sessionId: id, label: 'Synthetic flush', mode: 'text', durationMinutes: 60 }), token = created.path.split('#')[1]!
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  const stop = ctx.on('session/flush', () => gate.promise)
  let settled = false
  const pending = service.send(token, 'stable_request_02', 'Queued once', new AbortController().signal).then((value) => { settled = true; return value })
  await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })
  expect(settled).toBe(false); expect(store.receipt(created.grant.id, 'stable_request_02')?.state).toBe('uncertain')
  gate.resolve(); await expect(pending).resolves.toMatchObject({ state: 'received' }); stop()
  const activate = Promise.withResolvers<{ agent: typeof agent }>()
  const resolve = vi.spyOn(ctx.sessionController, 'resolveAgent').mockReturnValueOnce(activate.promise)
  const next = service.send(token, 'stable_request_03', 'Must not queue', new AbortController().signal)
  await vi.waitFor(() => { expect(resolve).toHaveBeenCalledOnce() })
  service.revoke(id, created.grant.id); activate.resolve({ agent })
  await expect(next).resolves.toMatchObject({ state: 'uncertain' })
  expect(followup).toHaveBeenCalledOnce()
}, 20000)
