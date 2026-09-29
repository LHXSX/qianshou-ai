/** Explicit tool consumer; registry names, developer entry and live nodes stay separate. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ComputeCapabilityId, ComputePlanId } from '../src/protocol.ts'
import { ComputeExecutorRegistry } from '../src/executor.ts'
import * as ComputeTools from '../src/tools.ts'

const draft = {
  id: ComputePlanId('plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  request: {
    capabilityId: ComputeCapabilityId('media.transcode'),
    goal: 'Batch ten product photos',
    budgetMinor: 150,
    currency: 'CNY' as const,
    maxNodes: null as number | null,
  },
  status: 'draft' as const,
  createdAt: '2026-09-16T12:00:00.000Z',
  quote: null,
  reason: '方案草稿已保存，尚未报价、下单或扣费；节点数量是请求上限，不代表资源已预留。',
  authorization: 'pending' as const,
  workloadId: null,
}

let ctx: Context
let stop: () => Promise<void>
const capabilityDiscovery = vi.fn()
const pool = vi.fn()
const account = vi.fn()
const createChain = vi.fn()
const createPlan = vi.fn()
const publishPlan = vi.fn()
const workload = vi.fn()
const workloadResult = vi.fn()
const lastObservedSupply = vi.fn()
let executors: ComputeExecutorRegistry

beforeEach(async () => {
  ctx = new Context()
  executors = new ComputeExecutorRegistry()
  const prompt = await ctx.plugin(SystemPrompt)
  const runtime = await ctx.plugin(ToolRuntime)
  stop = async () => { await runtime.dispose(); await prompt.dispose() }
  capabilityDiscovery.mockReset().mockResolvedValue({
    registry: { status: 'observed', observedAt: '2026-09-24T01:00:00.000Z', reason: null,
      registryVersion: '1.0', capabilities: [
        { capability: 'media.transcode', implementations: ['ffmpeg'], legacyTaskTypes: ['video_transcode'] },
        { capability: 'owner.poster', implementations: ['private-plugin'], legacyTaskTypes: [] },
      ] },
    requestableTaskTypes: { status: 'observed', observedAt: '2026-09-24T01:00:01.000Z', reason: null,
      items: [{ taskType: 'video_transcode', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' }] },
  })
  pool.mockReset().mockResolvedValue({
    lookup: 'found',
    capability: 'media.transcode',
    registryVersion: '1.0.0',
    declared: { count: 3, byImpl: { ffmpeg: 3 } },
    availableNow: { count: 0, byImpl: {}, onlineTtlSeconds: 90 },
    provides: [],
    note: '这是登记与在线声明，不是派单承诺。',
  })
  createPlan.mockReset().mockResolvedValue(draft)
  publishPlan.mockReset().mockResolvedValue({ ...draft, authorization: 'approved', workloadId: 'wl_1' })
  workload.mockReset().mockResolvedValue({ id: 'wl_1', status: 'OFFERED' })
  workloadResult.mockReset().mockResolvedValue({ id: 'wl_1', status: 'DONE', inlineOutput: '3', artifactRef: null })
  account.mockReset().mockResolvedValue({
    identity: { accountId: 41, username: 'member', role: 'enterprise', status: 'active' },
    balance: '1.2500',
    balanceNote: null,
    rewards: null,
    rewardsNote: '上游没返回这一项；收益只能来自平台，端侧不累加账本行。',
    withdrawn: {
      total: null,
      rows: [{ id: 'w1', type: 'WITHDRAW', amount: '-10.0000', workloadId: null, note: '', createdAt: '2026-09-19T00:00:00Z' }],
    },
    withdrawnNote: '累计提现只列 type=WITHDRAW 的原文，不把负数相加；账本尾有限，total 为 null。',
    ledger: [
      { id: 'w1', type: 'WITHDRAW', amount: '-10.0000', workloadId: null, note: '', createdAt: '2026-09-19T00:00:00Z' },
      { id: 'c1', type: 'CREDIT', amount: '-3.0000', workloadId: 'wl_1', note: '', createdAt: '2026-09-19T00:00:01Z' },
    ],
    ledgerNote: null,
    usageNote: '本地 token 用量不是账户余额，未计入。',
  })
  createChain.mockReset().mockResolvedValue({
    id: 'chain_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    contract: 'qianshou.recipe.v1',
    recipeId: null,
    version: '1',
    sha256: 'abc',
    request: {
      recipeId: null,
      steps: [{ capability: 'media.transcode', input: { kind: 'inline', value: 'x' } }],
      budgetMinor: 150,
      currency: 'CNY',
      maxNodes: null,
    },
    status: 'draft',
    authorization: 'pending',
    createdAt: '2026-09-19T00:00:00.000Z',
    reason: '链已存成草稿，等你的确认。尚未下单、报价或扣费。',
  })
  lastObservedSupply.mockReset().mockReturnValue(null)
  ctx.provide('computeCore', { capabilityDiscovery, pool, account, createChain, createPlan, publishPlan, workload, workloadResult, executors, lastObservedSupply })
})
afterEach(async () => { await stop() })

const call = (name: string, args: unknown, extra: { agent?: object; signal?: AbortSignal } = {}) =>
  ctx.tools.execute({
    signal: extra.signal ?? new AbortController().signal,
    callId: ToolCallId('call'),
    name,
    arguments: args,
    ...('agent' in extra ? { agent: extra.agent as never } : {}),
  })

async function parsed(name: string, args: unknown, extra?: { agent?: object }): Promise<Record<string, unknown>> {
  const result = await call(name, args, extra)
  expect(result.isError).not.toBe(true)
  const content = result.content.find(block => block.type === 'text')
  if (content?.type !== 'text') throw new Error('MISSING_TOOL_TEXT')
  return JSON.parse(content.text) as Record<string, unknown>
}

describe('scoped compute tools', () => {
  it('requires explicit registration and keeps new registry names distinct from developer tasks', async () => {
    expect(ctx.tools.get('compute_capabilities')).toBeUndefined()
    const plugin = await ctx.plugin(ComputeTools)
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('compute_')).map(tool => tool.name)).toEqual([
      'compute_cloud_catalog', 'compute_capability_landscape', 'compute_capabilities', 'compute_local_capabilities', 'compute_pool', 'compute_account', 'compute_dispatch_chain', 'compute_plan_draft', 'compute_submit', 'compute_workload_read', 'compute_workload_result',
    ])
    expect(ctx.tools.get('human_confirm')).toBeUndefined()
    expect(ctx.tools.get('compute_chain_confirm')).toBeUndefined()
    expect(ctx.tools.get('compute_confirm')).toBeUndefined()
    expect(ComputeTools.name).toBe('qianshou-compute-tools')
    expect(ComputeTools.inject).toEqual(['tools', 'computeCore'])
    expect(await parsed('compute_cloud_catalog', {})).toMatchObject({
      status: 'unreachable', reason: 'account_service_not_loaded', textModels: null,
      imageGeneration: 'not_observed', videoGeneration: 'not_observed',
    })
    expect(ctx.tools.get('compute_capabilities')?.isConcurrencySafe?.({} as never)).toBe(true)
    expect(ctx.tools.get('compute_pool')?.isConcurrencySafe?.({ capability: 'media.transcode' } as never)).toBe(true)
    expect(ctx.tools.get('compute_workload_read')?.isConcurrencySafe?.({ id: 'wl_1' } as never)).toBe(true)
    expect(ctx.tools.get('compute_workload_result')?.isConcurrencySafe?.({ id: 'wl_1' } as never)).toBe(true)
    expect(await parsed('compute_capabilities', {})).toEqual({
      registry: { status: 'observed', observedAt: '2026-09-24T01:00:00.000Z', reason: null,
        version: '1.0', total: 2, offset: 0, limit: 30, items: [
          { id: 'media.transcode', implementations: ['ffmpeg'], legacyTaskTypes: ['video_transcode'],
            namedDeveloperTaskTypes: ['video_transcode'] },
          { id: 'owner.poster', implementations: ['private-plugin'], legacyTaskTypes: [], namedDeveloperTaskTypes: [] },
        ] },
      developerEntry: { status: 'observed', observedAt: '2026-09-24T01:00:01.000Z', reason: null,
        namedTaskTypeCount: 1 },
      liveWorkersChecked: false, quoteChecked: false, ownerExecutionAuthorized: false,
    })
    expect(ctx.tools.get('compute_capabilities')?.presentCall?.({})).toEqual({ card: 'generic', title: '查询上海能力目录', kind: 'read' })
    expect((await parsed('compute_capabilities', { limit: 1, offset: 1 })).registry).toMatchObject({
      total: 2, offset: 1, limit: 1, items: [{ id: 'owner.poster', namedDeveloperTaskTypes: [] }],
    })
    expect(await parsed('compute_pool', { capability: 'media.transcode' })).toEqual({
      lookup: 'found',
      capability: 'media.transcode',
      registryVersion: '1.0.0',
      declared: { count: 3, byImpl: { ffmpeg: 3 } },
      availableNow: { count: 0, byImpl: {}, onlineTtlSeconds: 90 },
      provides: [],
      note: '这是登记与在线声明，不是派单承诺。',
    })
    expect(ctx.tools.get('compute_pool')?.presentCall?.({ capability: 'media.transcode' })).toEqual({
      card: 'generic', title: '查询算力池谁有这能力', kind: 'read', rawInput: 'media.transcode',
    })
    expect(ctx.tools.get('compute_account')?.isConcurrencySafe?.({} as never)).toBe(true)
    expect(ctx.tools.get('compute_account')?.presentCall?.({ include: 'ledger' })).toEqual({
      card: 'generic', title: '查询算力账户', kind: 'read', rawInput: 'ledger',
    })
    await plugin.dispose()
    expect(ctx.tools.get('compute_capabilities')).toBeUndefined()
  })

  it('keeps the Guangzhou account catalog separate from service health and media availability', async () => {
    ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', models: ['qianshou-text-1'] }) } as never)
    await ctx.plugin(ComputeTools)
    expect(await parsed('compute_cloud_catalog', {})).toEqual({
      status: 'observed', reason: null, textModels: ['qianshou-text-1'],
      textModelHealth: 'not_observed', imageGeneration: 'not_observed',
      videoGeneration: 'not_observed', pluginMarket: 'not_observed', price: null,
    })
  })

  it('gives natural conversation one sourced landscape without calling a worker, pricing or dispatch', async () => {
    ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', models: ['qianshou-text-1'] }) } as never)
    lastObservedSupply.mockReturnValue({ observedAt: '2026-09-24T00:30:00.000Z', localServices: [
      { id: 'tool.ffmpeg', kind: 'tool', name: 'FFmpeg', version: '7.0', verification: 'verified', reason: null },
      { id: 'model.video', kind: 'local-model', name: 'Video', version: null, verification: 'pending', reason: 'self_test_missing' },
    ] })
    await ctx.plugin(ComputeTools)
    const view = await parsed('compute_capability_landscape', {})
    expect(view.guangzhou).toMatchObject({ source: 'account-cached-model-catalog',
      status: 'observed', textModels: ['qianshou-text-1'], imageGeneration: 'not_observed',
      videoGeneration: 'not_observed', mediaServiceHealth: 'not_observed', catalogFreshness: 'cached' })
    expect(view.shanghai).toMatchObject({ source: 'live-semantic-registry', status: 'observed',
      total: 2, capabilities: [
        { id: 'media.transcode', implementations: ['ffmpeg'] },
        { id: 'owner.poster', legacyTaskTypes: [] },
      ], liveWorkersChecked: false })
    expect(view.local).toMatchObject({ lastObservedAt: '2026-09-24T00:30:00.000Z',
      observedServices: [{ id: 'tool.ffmpeg', verification: 'verified' },
        { id: 'model.video', verification: 'pending' }], currentHealthChecked: false })
    expect(view).toMatchObject({ quoteChecked: false, executionAuthorized: false,
      orderIntakeEnabled: 'not_observed' })
    expect(pool).not.toHaveBeenCalled()
    expect(createPlan).not.toHaveBeenCalled()
    expect(publishPlan).not.toHaveBeenCalled()
  })

  it('keeps an unreachable Shanghai catalog unknown even when a local executor exists', async () => {
    capabilityDiscovery.mockResolvedValueOnce({
      registry: { status: 'unreachable', observedAt: null, reason: 'request_failed',
        registryVersion: null, capabilities: null },
      requestableTaskTypes: { status: 'unreachable', observedAt: null, reason: 'request_failed', items: null },
    })
    executors.register({ capabilityId: ComputeCapabilityId('media.drawn-video'), version: '1.0.0',
      async execute() { return { outputs: [] } } })
    await ctx.plugin(ComputeTools)
    const view = await parsed('compute_capability_landscape', {})
    expect(view.shanghai).toMatchObject({ status: 'unreachable', capabilities: null,
      total: null, liveWorkersChecked: false })
    expect(view.local).toMatchObject({ registeredExecutors: [
      { capabilityId: 'media.drawn-video', version: '1.0.0' }], observedServices: null })
  })

  it('reports only live executor registrations without claiming health or order eligibility', async () => {
    await ctx.plugin(ComputeTools)
    expect(await parsed('compute_local_capabilities', {})).toEqual({
      total: 0, items: [], health: 'not_observed',
      ownerOrderAuthorization: 'not_observed', shanghaiDispatchEligibility: 'not_observed',
    })
    const remove = executors.register({
      capabilityId: ComputeCapabilityId('media.drawn-video'), version: '1.0.0',
      async execute() { return { outputs: [] } },
    })
    expect(await parsed('compute_local_capabilities', {})).toEqual({
      total: 1, items: [{ capabilityId: 'media.drawn-video', version: '1.0.0' }],
      health: 'not_observed', ownerOrderAuthorization: 'not_observed',
      shanghaiDispatchEligibility: 'not_observed',
    })
    expect(ctx.tools.get('compute_local_capabilities')?.presentCall?.({})).toEqual({
      card: 'generic', title: '查询本机已注册能力', kind: 'read',
    })
    remove()
    expect((await parsed('compute_local_capabilities', {})).total).toBe(0)
    expect(createPlan).not.toHaveBeenCalled()
    expect(publishPlan).not.toHaveBeenCalled()
  })

  it.each([0, 51, 1.5])('rejects an out-of-range capabilities limit: %s', async (limit) => {
    await ctx.plugin(ComputeTools)
    expect((await call('compute_capabilities', { limit })).isError).toBe(true)
    expect((await call('compute_pool', { capability: 'media.transcode', limit })).isError).toBe(true)
  })

  it('preserves unknown registry and developer entry instead of inventing an empty catalog', async () => {
    await ctx.plugin(ComputeTools)
    capabilityDiscovery.mockResolvedValueOnce({
      registry: { status: 'unreachable', observedAt: null, reason: 'auth_required', registryVersion: null, capabilities: null },
      requestableTaskTypes: { status: 'unreachable', observedAt: null, reason: 'auth_required', items: null },
    })
    expect(await parsed('compute_capabilities', {})).toMatchObject({
      registry: { status: 'unreachable', reason: 'auth_required', total: null, items: null },
      developerEntry: { status: 'unreachable', reason: 'auth_required', namedTaskTypeCount: null },
      liveWorkersChecked: false,
    })
    expect((await call('compute_capabilities', { offset: -1 })).isError).toBe(true)
    expect((await call('compute_capabilities', { offset: 5001 })).isError).toBe(true)
  })

  it('keeps catalog presence, declared ads, and available-now as separate facts', async () => {
    await ctx.plugin(ComputeTools)
    const found = await parsed('compute_pool', { capability: 'media.transcode' })
    expect(found.lookup).toBe('found')
    expect(found.declared).toEqual({ count: 3, byImpl: { ffmpeg: 3 } })
    expect(found.availableNow).toEqual({ count: 0, byImpl: {}, onlineTtlSeconds: 90 })
    expect(JSON.stringify(found)).not.toContain('查不到')
    pool.mockResolvedValueOnce({
      lookup: 'not_in_registry',
      capability: 'invented.capability',
      registryVersion: null,
      declared: null,
      availableNow: null,
      provides: [],
      note: '目录里没有这个能力名；不是池子里没人。',
    })
    const missing = await parsed('compute_pool', { capability: 'invented.capability' })
    expect(missing.lookup).toBe('not_in_registry')
    expect(missing.declared).toBeNull()
    expect(missing.availableNow).toBeNull()
    expect(String(missing.note)).toContain('目录里没有')
    pool.mockResolvedValueOnce({
      lookup: 'unreachable',
      capability: 'media.transcode',
      registryVersion: null,
      declared: null,
      availableNow: null,
      provides: [],
      note: '目录里有这个能力，但我现在查不到池子里有没有节点能接',
    })
    const blocked = await parsed('compute_pool', { capability: 'media.transcode' })
    expect(blocked.lookup).toBe('unreachable')
    expect(blocked.declared).toBeNull()
    expect(blocked.availableNow).toBeNull()
    expect(String(blocked.note)).toContain('查不到池子')
    expect(blocked.declared === 0 || blocked.availableNow === 0).toBe(false)
  })

  it('copies money strings and never invents a zero or sums withdrawals from negative rows', async () => {
    await ctx.plugin(ComputeTools)
    const snapshot = await parsed('compute_account', {})
    expect(snapshot.balance).toBe('1.2500')
    expect(snapshot.rewards).toBeNull()
    expect(snapshot.withdrawn).toEqual({
      total: null,
      rows: [{ id: 'w1', type: 'WITHDRAW', amount: '-10.0000', workloadId: null, note: '', createdAt: '2026-09-19T00:00:00Z' }],
    })
    expect(JSON.stringify(snapshot.withdrawn)).not.toContain('CREDIT')
    expect(snapshot.balance === 0 || snapshot.rewards === 0 || snapshot.withdrawn === 0).toBe(false)
    account.mockResolvedValueOnce({
      identity: { accountId: 41, username: 'member', role: 'enterprise', status: 'active' },
      balance: null,
      balanceNote: '上游没返回这一项',
      rewards: null,
      rewardsNote: '上游没返回这一项；收益只能来自平台，端侧不累加账本行。',
      withdrawn: { total: null, rows: [] },
      withdrawnNote: '累计提现只列 type=WITHDRAW 的原文，不把负数相加；账本尾有限，total 为 null。',
      ledger: [],
      ledgerNote: null,
      usageNote: '本地 token 用量不是账户余额，未计入。',
    })
    const missing = await parsed('compute_account', { include: 'balance' })
    expect(missing.balance).toBeNull()
    expect(missing.balanceNote).toBe('上游没返回这一项')
    expect(missing.balance === 0).toBe(false)
  })

  it('saves a local chain card without submitting and refuses a call without an agent', async () => {
    await ctx.plugin(ComputeTools)
    const args = {
      steps: [{ capability: 'media.transcode', input: { kind: 'inline', value: 'x' } }],
      budgetMinor: 150,
    }
    expect((await call('compute_dispatch_chain', args)).isError).toBe(true)
    const result = await call('compute_dispatch_chain', args, { agent: { session: { header: { cwd: '/tmp' } } } })
    expect(result.isError).not.toBe(true)
    expect(createChain).toHaveBeenCalledWith({ ...args, currency: 'CNY', maxNodes: null }, expect.any(AbortSignal))
    expect(result.meta).toMatchObject({ protocol: 'qianshou.chain-card.v1', stepCount: 1 })
    expect(ctx.tools.get('compute_dispatch_chain')?.presentCall?.({
      steps: args.steps, budgetMinor: 150,
    })).toEqual({
      card: 'generic', title: '拟定算力链 · 未下单', kind: 'execute',
    })
    expect(await parsed('compute_dispatch_chain', args, { agent: { session: { header: { cwd: '/tmp' } } } })).toMatchObject({
      status: 'draft', authorization: 'pending', contract: 'qianshou.recipe.v1',
    })
  })

  it('saves a local draft with CNY and omitted concurrency, and refuses a call without an agent', async () => {
    await ctx.plugin(ComputeTools)
    expect((await call('compute_plan_draft', {
      capabilityId: 'media.transcode', goal: draft.request.goal, budgetMinor: 150,
    })).isError).toBe(true)
    const result = await call('compute_plan_draft', {
      capabilityId: 'media.transcode', goal: draft.request.goal, budgetMinor: 150, maxNodes: 2,
    }, { agent: { session: { header: { cwd: '/tmp' } } } })
    expect(result.isError).not.toBe(true)
    expect(createPlan).toHaveBeenCalledWith({
      capabilityId: 'media.transcode', goal: draft.request.goal, budgetMinor: 150, currency: 'CNY', maxNodes: 2,
    }, expect.any(AbortSignal))
    expect(result.meta).toMatchObject({ protocol: 'qianshou.task-card.v1', cardId: draft.id, title: draft.request.goal })
    expect(ctx.tools.get('compute_plan_draft')?.presentCall?.({
      capabilityId: 'media.transcode', goal: draft.request.goal, budgetMinor: 150,
    })).toEqual({
      card: 'generic', title: '拟定算力方案 · 未下单', kind: 'execute', rawInput: draft.request.goal,
    })
    expect(await parsed('compute_plan_draft', {
      capabilityId: 'media.transcode', goal: draft.request.goal, budgetMinor: 150,
    }, { agent: { session: { header: { cwd: '/tmp' } } } })).toMatchObject({ id: draft.id, status: 'draft' })
    expect(createPlan).toHaveBeenLastCalledWith(expect.objectContaining({ maxNodes: null, currency: 'CNY' }), expect.any(AbortSignal))
  })

  it('reads an existing workload id and presents the call', async () => {
    await ctx.plugin(ComputeTools)
    expect(await parsed('compute_workload_read', { id: 'wl_1' })).toEqual({ id: 'wl_1', status: 'OFFERED' })
    expect(ctx.tools.get('compute_workload_read')?.presentCall?.({ id: 'wl_1' })).toEqual({
      card: 'generic', title: '查询算力任务', kind: 'read', rawInput: 'wl_1',
    })
    expect(await parsed('compute_workload_result', { id: 'wl_1' })).toEqual({
      id: 'wl_1', status: 'DONE', inlineOutput: '3', artifactRef: null,
    })
    expect(ctx.tools.get('compute_workload_result')?.presentCall?.({ id: 'wl_1' })).toEqual({
      card: 'generic', title: '查询算力结果', kind: 'read', rawInput: 'wl_1',
    })
  })

  it('does not expose a model-authored local/cloud route card as a verified capability', async () => {
    await ctx.plugin(ComputeTools)
    expect(ctx.tools.get('pc_route_card')).toBeUndefined()
    expect(createPlan).not.toHaveBeenCalled()
    expect(publishPlan).not.toHaveBeenCalled()
  })

  it('aborts every tool when the execution signal is already aborted', async () => {
    await ctx.plugin(ComputeTools)
    const registered = ctx.tools.schemas().filter(tool => tool.name.startsWith('compute_')).map(tool => tool.name)
    const source = readFileSync(fileURLToPath(new URL('./tools.spec.ts', import.meta.url)), 'utf8')
    expect(registered).toEqual([
      'compute_cloud_catalog', 'compute_capability_landscape', 'compute_capabilities', 'compute_local_capabilities', 'compute_pool', 'compute_account', 'compute_dispatch_chain', 'compute_plan_draft', 'compute_submit', 'compute_workload_read', 'compute_workload_result',
    ])
    for (const name of registered) expect(source).toContain(`call('${name}'`)
    const signal = AbortSignal.abort()
    expect((await call('compute_cloud_catalog', {}, { signal })).isError).toBe(true)
    expect((await call('compute_capability_landscape', {}, { signal })).isError).toBe(true)
    expect((await call('compute_capabilities', {}, { signal })).isError).toBe(true)
    expect((await call('compute_local_capabilities', {}, { signal })).isError).toBe(true)
    expect((await call('compute_pool', { capability: 'media.transcode' }, { signal })).isError).toBe(true)
    expect((await call('compute_account', {}, { signal })).isError).toBe(true)
    expect((await call('compute_dispatch_chain', {
      steps: [{ capability: 'media.transcode', input: { kind: 'inline', value: 'x' } }], budgetMinor: 0,
    }, { signal, agent: { session: { header: { cwd: '/tmp' } } } })).isError).toBe(true)
    expect((await call('compute_plan_draft', {
      capabilityId: 'media.transcode', goal: 'x', budgetMinor: 0,
    }, { signal, agent: { session: { header: { cwd: '/tmp' } } } })).isError).toBe(true)
    expect((await call('compute_submit', { id: 'plan_1' }, { signal, agent: { session: { header: { cwd: '/tmp' } } } })).isError).toBe(true)
    expect((await call('compute_workload_read', { id: 'wl_1' }, { signal })).isError).toBe(true)
    expect((await call('compute_workload_result', { id: 'wl_1' }, { signal })).isError).toBe(true)
  })

  it('aborts every registered execute body when the body signal is already aborted', async () => {
    await ctx.plugin(ComputeTools)
    const registered = ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('compute_'))
    const args: Record<string, unknown> = {
      compute_cloud_catalog: {},
      compute_capability_landscape: {},
      compute_capabilities: {},
      compute_local_capabilities: {},
      compute_pool: { capability: 'media.transcode' },
      compute_account: {},
      compute_dispatch_chain: {
        steps: [{ capability: 'media.transcode', input: { kind: 'inline', value: 'x' } }], budgetMinor: 0,
      },
      compute_plan_draft: { capabilityId: 'media.transcode', goal: 'x', budgetMinor: 0 },
      compute_submit: { id: 'plan_1' },
      compute_workload_read: { id: 'wl_1' },
      compute_workload_result: { id: 'wl_1' },
    }
    expect(registered).toEqual(Object.keys(args))
    const exec = { signal: AbortSignal.abort(), agent: { session: { header: { cwd: '/tmp' } } } }
    for (const name of registered) {
      await expect(ctx.tools.get(name)!.execute(args[name], exec as never)).rejects.toBeDefined()
    }
    expect(createPlan).not.toHaveBeenCalled()
    expect(publishPlan).not.toHaveBeenCalled()
    expect(createChain).not.toHaveBeenCalled()
    expect(capabilityDiscovery).not.toHaveBeenCalled()
    expect(pool).not.toHaveBeenCalled()
    expect(account).not.toHaveBeenCalled()
    expect(workload).not.toHaveBeenCalled()
    expect(workloadResult).not.toHaveBeenCalled()
  })
})
