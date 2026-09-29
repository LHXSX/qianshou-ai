/** Real Loader, AgentLoop, Session, workspace registry and SQLite; only the model is deterministic. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import QianshouMemory from '../src/index.ts'
import * as MemoryTools from '../src/tools.ts'

class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly record: string) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] }) }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.requests.length
    const operation = step === 1 ? { name: 'memory_search', args: { query: 'SyntheticCommonMarker' } }
      : step === 2 ? { name: 'memory_read', args: { id: this.record } }
        : step === 3 ? { name: 'memory_propose', args: { title: 'Synthetic experience', content: 'SyntheticCandidateMarker', evidence: 'Controlled Loader test, no paid model.' } } : null
    if (operation) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`memory-step-${step}`), name: operation.name, arguments: JSON.stringify(operation.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic memory exercise finished.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let context: Context | undefined
let root: string | undefined
afterEach(async () => { await context?.fiber.dispose()
  context = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined })
async function boot() {
  root = await mkdtemp(join(tmpdir(), 'qianshou-memory-loader-'))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime], ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite], ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence], ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
    ['@deepseek-ai/dsh-host-qianshou-memory', QianshouMemory], ['@deepseek-ai/dsh-host-qianshou-memory/tools', MemoryTools],
  ])
  const configs: Record<string, unknown> = {
    '@deepseek-ai/dsh-storage-sqlite': { path: join(root, 'registry.sqlite') }, '@deepseek-ai/dsh-storage-domain': { backend: 'sqlite' },
    '@deepseek-ai/dsh-session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' },
    '@deepseek-ai/dsh-host-qianshou-memory': { path: join(root, 'device-memory', 'v1.sqlite'), capacityBytes: 1000000, expiryIntervalMs: 60000 },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...modules.keys()].map(name => `- name: '${name}'${configs[name] ? `\n  config: ${JSON.stringify(configs[name])}` : ''}`).join('\n') + '\n')
  const ctx = context = new Context(); ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) { if (!modules.has(specifier)) throw new Error(`Unexpected module: ${specifier}`); return modules.get(specifier) } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  for (const name of ['a', 'b']) await mkdir(join(root, name))
  const a = await ctx.workspaceRegistry.create(join(root, 'a'))
  const b = await ctx.workspaceRegistry.create(join(root, 'b'))
  return { ctx, a, b, root }
}

it('uses real Session tools, records model-visible results and requires owner review without any account plugin', async () => {
  const { ctx, a, b } = await boot()
  const common = await ctx.qianshouMemory.save({ title: 'Common fixture', content: 'SyntheticCommonMarker', kind: 'knowledge', scope: 'device' })
  const privateB = await ctx.qianshouMemory.save({ title: 'B fixture', content: 'SyntheticBMarker', kind: 'knowledge', scope: 'workspace', workspaceId: b.id })
  const model = new ScriptedModel(common.id); ctx.llm.registerAdapter(['memory-fixture'], model)
  const agent = await ctx.agentLoop.create(SessionId('memory-loader'), { provider: 'memory-fixture', model: 'deterministic' }, { cwd: a.path })
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const stop = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') idle.resolve() })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise controlled memory tools.' }], source: { kind: 'user' } }))
  await idle.promise; stop()
  const logs = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(logs).toHaveLength(3)
  expect(model.requests).toHaveLength(4)
  expect(JSON.stringify(model.requests[1]?.messages)).toContain('SyntheticCommonMarker')
  expect(JSON.stringify(model.requests[3]?.messages)).toContain('requiresOwnerReview')
  expect(JSON.stringify(logs)).not.toContain('SyntheticBMarker')
  const candidates = await ctx.qianshouMemory.list({ status: 'candidate' })
  expect(candidates.items).toHaveLength(1)
  expect(candidates.items[0]?.origin).toEqual({ sessionId: agent.session.id, callId: 'memory-step-3' })
  expect((await ctx.qianshouMemory.searchForSession(agent.session, { query: 'SyntheticCandidateMarker' }, new AbortController().signal)).total).toBe(0)
  await expect(ctx.qianshouMemory.readForSession(agent.session, privateB.id, new AbortController().signal)).rejects.toThrow('not-found')
  const candidate = candidates.items[0]!
  await ctx.qianshouMemory.review({ id: candidate.id, expectedRevision: 1, action: 'accept' })
  expect((await ctx.qianshouMemory.searchForSession(agent.session, { query: 'SyntheticCandidateMarker' }, new AbortController().signal)).total).toBe(1)
  expect(ctx.get('qianshouAccount')).toBeUndefined()
}, 30000)

it('uses canonical actual cwd, rejects forged scope, survives workspace removal and denies cancelled writes', async () => {
  const { ctx, a, b, root } = await boot()
  await symlink(a.path, join(root, 'a-alias'))
  const agent = await ctx.agentLoop.create(SessionId('scope-loader'), {}, { cwd: join(root, 'a-alias') })
  const result = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('proposed'), name: 'memory_propose', arguments: { title: 'Scoped', content: 'CandidateA', evidence: 'Controlled local fixture' } })
  expect(result.isError).toBe(false)
  const candidate = (await ctx.qianshouMemory.list({ status: 'candidate' })).items[0]!
  expect(candidate.workspaceId).toBe(a.id)
  const forged = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('forged'), name: 'memory_propose', arguments: { title: 'Scoped', content: 'MustNotCommit', evidence: 'fixture', workspaceId: b.id } })
  expect(forged.isError).toBe(true)
  const controller = new AbortController(); controller.abort()
  await expect(ctx.qianshouMemory.proposeForSession(agent.session, ToolCallId('cancelled'), { title: 'Cancelled', content: 'MustNotCommit', evidence: 'fixture' }, controller.signal)).rejects.toBeDefined()
  await ctx.workspaceRegistry.delete(a.id)
  await expect(ctx.qianshouMemory.proposeForSession(agent.session, ToolCallId('removed'), { title: 'Removed', content: 'MustNotCommit', evidence: 'fixture' }, new AbortController().signal)).rejects.toThrow('workspace-required')
  const recreated = await ctx.workspaceRegistry.create(a.path)
  expect(recreated.id).not.toBe(a.id)
  await ctx.qianshouMemory.review({ id: candidate.id, expectedRevision: 1, action: 'accept' })
  expect((await ctx.qianshouMemory.searchForSession(agent.session, { query: 'CandidateA' }, new AbortController().signal)).total).toBe(0)
  expect((await ctx.qianshouMemory.list({})).total).toBe(1)
}, 30000)
