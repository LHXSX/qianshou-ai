import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import { TestSessionQuery } from '../../subagent/tests/test-session-query.ts'
import EmployeeSettingsService, { EMPLOYEE_SETTINGS_NAMESPACE as NS } from '../src/employee-settings.ts'
import * as tool from '../src/index.ts'
import { mountScriptedProvider } from './scripted-provider.ts'
import { callSubagent, fakeAgent, text } from './harness.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected async load(): Promise<Record<string, unknown>> { return structuredClone(this.doc) }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
  }
}
const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function boot(enabled = true, config: Partial<tool.Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(EmployeeSettingsService)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  const requests: SubagentStartRequest[] = []
  await mountScriptedProvider(ctx, { name: 'mock', onStart: (request) => { requests.push(request) } })
  await ctx.plugin(tool, { provider: 'mock', employeeRouting: enabled, ...config })
  ctx.llm.registerAdapter(['alpha', 'beta'], new MockAdapter([]))
  const parent = fakeAgent()
  Object.assign(parent, { options: { provider: 'alpha', model: 'ceo-model' } })
  const dispatch = (extra: Record<string, unknown> = {}) => callSubagent(ctx, {
    employee: 'writer', description: '写一篇介绍', prompt: '写给首次使用产品的读者。', ...extra,
  }, { agent: parent })
  return { ctx, requests, parent, dispatch }
}

describe('employee routing authority', () => {
  it('follows CEO, then team default, while keeping an employee-specific route independent', async () => {
    const { ctx, requests, dispatch } = await boot()
    expect((await dispatch()).isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'ceo-model' })
    await ctx.settings.update(NS, { defaultRoute: { provider: 'beta', model: 'team-model' } })
    expect((await dispatch()).isError).toBe(false)
    expect(requests[1]?.agentOptions).toEqual({ provider: 'beta', model: 'team-model' })
    const roster = ctx.employeeSettings.current().employees
    roster.find(e => e.id === 'writer')!.route = { provider: 'alpha', model: 'writer-model' }
    await ctx.settings.update(NS, { employees: roster })
    expect((await dispatch()).isError).toBe(false)
    expect(requests[2]?.agentOptions).toEqual({ provider: 'alpha', model: 'writer-model' })
    expect(requests[2]?.label).toContain('写作员工')
    expect(JSON.stringify(requests[2]?.prompt)).toContain('交回委派你的 CEO')
    await ctx.settings.update(NS, { defaultRoute: { provider: 'beta', model: 'team-new' } })
    expect((await dispatch()).isError).toBe(false)
    expect(requests[3]?.agentOptions?.model).toBe('writer-model')
    expect(requests[1]?.agentOptions?.model).toBe('team-model')
  })

  it('reports live credential-free roles and protects settings from detached mutation', async () => {
    const { ctx, parent } = await boot()
    const result = await ctx.tools.execute({ name: 'list_employees', arguments: {}, agent: parent,
      signal: new AbortController().signal, callId: ToolCallId('roster') })
    expect(text(result)).toContain('写作员工 (writer) · alpha/ceo-model · ceo')
    ctx.employeeSettings.current().employees.splice(0)
    expect(ctx.employeeSettings.current().employees).toHaveLength(5)
  })

  it('blocks forced explicit overrides, unknown employees and unavailable providers before spawn', async () => {
    const { ctx, requests, dispatch } = await boot()
    expect(text(await dispatch({ provider: 'beta', model: 'arbitrary' }))).toContain('cannot be combined')
    expect(text(await dispatch({ employee: 'invented' }))).toContain('unknown employee')
    await ctx.settings.update(NS, { defaultRoute: { provider: 'missing', model: 'nope' } })
    const result = await dispatch()
    expect(result.isError).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it('rejects stale assignment after asynchronous route preflight rather than dispatching a removed employee', async () => {
    const { ctx, dispatch, requests } = await boot()
    const original = ctx.llm.resolveCallConfig.bind(ctx.llm)
    vi.spyOn(ctx.llm, 'resolveCallConfig').mockImplementationOnce(async (...args) => {
      await ctx.settings.update(NS, { employees: ctx.employeeSettings.current().employees.filter(e => e.id !== 'writer') })
      return original(...args)
    })
    expect((await dispatch()).isError).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it('does not inherit a route-owned reasoning effort when changing providers', async () => {
    const { ctx, dispatch, requests, parent } = await boot()
    Object.assign(parent.options, { reasoningEffort: ReasoningEffortId('high') })
    await ctx.settings.update(NS, { defaultRoute: { provider: 'beta', model: 'no-reasoning' } })
    expect((await dispatch()).isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'beta', model: 'no-reasoning' })
  })

  it('uses the latest CEO request route and effort while retaining the configured child output limit', async () => {
    const { ctx, dispatch, requests, parent } = await boot(true, { agentOptions: {
      provider: 'missing', model: 'tool-default', reasoningEffort: ReasoningEffortId('unsupported'), maxTokens: 256,
    } })
    Object.assign(parent.options, { reasoningEffort: ReasoningEffortId('old-effort'), maxTokens: 4096 })
    ctx.llm.registerAdapter(['live'], new MockAdapter([], {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low'),
    }))
    parent.session.append('request/header', {
      header: { config: { provider: 'live', model: 'current', reasoningEffort: ReasoningEffortId('low') } },
      reason: 'initial',
    })
    expect((await dispatch()).isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'live', model: 'current', reasoningEffort: 'low', maxTokens: 256,
    })
    parent.session.append('request/header', {
      header: { config: { provider: 'beta', model: 'without-reasoning' } }, reason: 'initial',
    })
    expect((await dispatch()).isError).toBe(false)
    expect(requests[1]?.agentOptions).toEqual({ provider: 'beta', model: 'without-reasoning', maxTokens: 256 })
  })

  it('rejects a changed team route while preflight is awaiting instead of creating a stale assignment', async () => {
    const { ctx, dispatch, requests } = await boot()
    const original = ctx.llm.resolveCallConfig.bind(ctx.llm)
    vi.spyOn(ctx.llm, 'resolveCallConfig').mockImplementationOnce(async (...args) => {
      await ctx.settings.update(NS, { defaultRoute: { provider: 'beta', model: 'changed' } })
      return original(...args)
    })
    expect(text(await dispatch())).toContain('assignment changed')
    expect(requests).toHaveLength(0)
    expect((await dispatch()).isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'beta', model: 'changed' })
  })

  it('rejects undeclared routing and credential fields before persistence without echoing their values', async () => {
    const { ctx } = await boot()
    const roster = ctx.employeeSettings.current().employees
    for (const patch of [
      { apiKey: 'TEST_SECRET_DO_NOT_PERSIST' },
      { defaultRoute: { provider: 'alpha', model: 'model', apiKey: 'TEST_SECRET_DO_NOT_PERSIST' } },
      { defaultRoute: { provider: 'alpha', model: 'model', reasoningEffort: 'high' } },
      { employees: roster.map(employee => ({ ...employee, apiKey: 'TEST_SECRET_DO_NOT_PERSIST' })) },
      { employees: roster.map(employee => ({ ...employee, route: { provider: 'alpha', model: 'model', maxTokens: 5000 } })) },
    ]) {
      await expect(ctx.settings.update(NS, patch)).rejects.toThrow('unsupported fields')
    }
    expect(ctx.employeeSettings.current()).toEqual({ defaultRoute: null, employees: roster })
    expect(JSON.stringify(ctx.settings.get(NS))).not.toContain('TEST_SECRET_DO_NOT_PERSIST')
  })

  it('leaves standard tools unchanged when employee routing is not opted in', async () => {
    const { ctx, dispatch, requests } = await boot(false)
    expect(ctx.tools.schemas().some(s => s.name === 'list_employees')).toBe(false)
    expect((await dispatch()).isError).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it('validates duplicate ids, blank routes and bounded roster length at settings writes', async () => {
    const { ctx } = await boot()
    const roster = ctx.employeeSettings.current().employees
    await expect(ctx.settings.update(NS, { employees: [...roster, roster[0]] })).rejects.toThrow('unique')
    await expect(ctx.settings.update(NS, { defaultRoute: { provider: ' ', model: 'x' } })).rejects.toThrow('non-empty')
    await expect(ctx.settings.update(NS, { employees: Array.from({ length: 25 }, (_, i) => ({ ...roster[0], id: `employee-${i}` })) })).rejects.toThrow('at most 24')
    expect(ctx.employeeSettings.current().employees).toHaveLength(5)
  })

  it('creates a durable employee and reuses that exact child route after team settings change', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const root = await mkdtemp(join(tmpdir(), 'dsh-employee-continuable-'))
    roots.push(root)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(EmployeeSettingsService)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(tool, { provider: 'spawn', backgroundMode: 'continuable', employeeRouting: true })
    const adapter = new MockAdapter([textResponse('first employee result'), textResponse('reused employee result')])
    ctx.llm.registerAdapter(['beta'], adapter)
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([
      textResponse('CEO received the first result'), textResponse('CEO received the revised result'),
    ]))
    const parent = await ctx.agentLoop.create(SessionId('employee-ceo'), { provider: 'alpha', model: 'ceo' })
    await ctx.settings.update(NS, { defaultRoute: { provider: 'beta', model: 'writer-original' } })
    const started = await callSubagent(ctx, { employee: 'writer', description: 'initial article', prompt: 'write an article' }, { agent: parent })
    expect(started.isError).toBe(false)
    if (started.isError || typeof started.value !== 'object' || started.value === null
      || !('kind' in started.value) || started.value.kind !== 'continuable'
      || !('subagentId' in started.value) || typeof started.value.subagentId !== 'string') {
      throw new Error('expected a real continuable employee id')
    }
    const childId = SessionId(started.value.subagentId)
    expect(text(started)).toContain('写作员工 (writer) · beta/writer-original · team')
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(ctx.agents.get(childId)).toBeUndefined()
    }, { timeout: 5000 })
    const first = await loadStoredSession(ctx.sessionPersistence, childId)
    expect(first.meta.parentSession).toBe(parent.id)
    expect(first.events.find(event => event.type === 'subagent/descriptor')?.data).toMatchObject({
      agentProvider: 'beta', agentModel: 'writer-original', label: '写作员工 · initial article',
    })
    expect(first.events.some(event => event.type === 'assistant/message')).toBe(true)
    await ctx.settings.update(NS, { defaultRoute: { provider: 'alpha', model: 'new-team-default' }, employees: [] })
    await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text: 'revise the article' }], {
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(2)
      expect(ctx.agents.get(childId)).toBeUndefined()
    }, { timeout: 5000 })
    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['beta', 'writer-original'], ['beta', 'writer-original'],
    ])
    const resumed = await loadStoredSession(ctx.sessionPersistence, childId)
    expect(resumed.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(resumed.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    expect(JSON.stringify(resumed.events)).toContain('revise the article')
  })
})

it('keeps an employee provider binding while automatic effort interprets its task on that provider', async () => {
  const { ctx, parent, requests, dispatch } = await boot()
  await ctx.settings.update(NS, { defaultRoute: { provider: 'beta', model: 'team-model' } })
  const { setAgentRoutingIntent } = await import('@deepseek-ai/dsh-agent')
  setAgentRoutingIntent(parent, { provider: 'alpha', model: 'ceo-model', routing: { model: 'auto', effort: 'auto', candidates: ['ceo-model', 'alternative'] } })
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, model) => ({ provider, id: model, name: model,
    reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }] } }))
  vi.spyOn(ctx.llm, 'resolveCallConfig').mockImplementation(async config => config)
  const stream = vi.spyOn(ctx.llm, 'stream').mockImplementation(async function* (options) {
    expect(options.provider).toBe('beta')
    expect(options.model).toBe('team-model')
    expect(options.reasoningEffort).toBe('low')
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ model: 'team-model', reasoningEffort: 'high', reason: 'A fact-checked introduction requires careful synthesis.' }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const result = await dispatch()
  expect(result.isError, text(result)).toBe(false)
  expect(stream).toHaveBeenCalledOnce()
  expect(requests[0]?.agentOptions).toMatchObject({ provider: 'beta', model: 'team-model', reasoningEffort: 'high' })
  const event = parent.session.ownEvents().find(event => event.type === 'model/routing-start')
  expect(event?.data).toMatchObject({ provider: 'beta', policy: { model: 'manual', effort: 'auto', candidates: ['team-model'] } })
})
