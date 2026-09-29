/** Explicit tool consumer; quoting and submission flags come from Host status, never invented prices. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ComputeCapabilityId, ComputePlanId } from '../src/protocol.ts'
import * as ComputeTools from '../src/tools.ts'

const draft = {
  id: ComputePlanId('plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  request: {
    capabilityId: ComputeCapabilityId('image.batch'),
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
const capabilities = vi.fn()
const createPlan = vi.fn()
const workload = vi.fn()
const status = vi.fn()

beforeEach(async () => {
  ctx = new Context()
  const prompt = await ctx.plugin(SystemPrompt)
  const runtime = await ctx.plugin(ToolRuntime)
  stop = async () => { await runtime.dispose(); await prompt.dispose() }
  capabilities.mockReset().mockResolvedValue([{ id: 'image.batch', name: 'Image batch', description: 'Batch', delivery: 'remote', available: true }])
  createPlan.mockReset().mockResolvedValue(draft)
  workload.mockReset().mockResolvedValue({ id: 'wl_1', status: 'OFFERED' })
  status.mockReset().mockReturnValue({ capabilities: { quoting: false, submission: true } })
  ctx.provide('computeCore', { capabilities, createPlan, workload, status })
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
  it('requires explicit registration and reports observed quoting and submission flags', async () => {
    expect(ctx.tools.get('compute_capabilities')).toBeUndefined()
    const plugin = await ctx.plugin(ComputeTools)
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('compute_')).map(tool => tool.name)).toEqual([
      'compute_capabilities', 'compute_plan_draft', 'compute_workload_read',
    ])
    expect(ComputeTools.name).toBe('qianshou-compute-tools')
    expect(ComputeTools.inject).toEqual(['tools', 'computeCore'])
    expect(ctx.tools.get('compute_capabilities')?.isConcurrencySafe?.({} as never)).toBe(true)
    expect(ctx.tools.get('compute_workload_read')?.isConcurrencySafe?.({ id: 'wl_1' } as never)).toBe(true)
    expect(await parsed('compute_capabilities', {})).toEqual({
      total: 1,
      items: [{ id: 'image.batch', name: 'Image batch', description: 'Batch', delivery: 'remote', available: true }],
      quoting: false,
      submission: true,
    })
    expect(ctx.tools.get('compute_capabilities')?.presentCall?.({})).toEqual({ card: 'generic', title: '查询共享算力能力', kind: 'read' })
    await plugin.dispose()
    expect(ctx.tools.get('compute_capabilities')).toBeUndefined()
  })

  it.each([0, 31, 1.5])('rejects an out-of-range capabilities limit: %s', async (limit) => {
    await ctx.plugin(ComputeTools)
    expect((await call('compute_capabilities', { limit })).isError).toBe(true)
  })

  it('saves a local draft with CNY and omitted concurrency, and refuses a call without an agent', async () => {
    await ctx.plugin(ComputeTools)
    expect((await call('compute_plan_draft', {
      capabilityId: 'image.batch', goal: draft.request.goal, budgetMinor: 150,
    })).isError).toBe(true)
    const result = await call('compute_plan_draft', {
      capabilityId: 'image.batch', goal: draft.request.goal, budgetMinor: 150, maxNodes: 2,
    }, { agent: { session: { header: { cwd: '/tmp' } } } })
    expect(result.isError).not.toBe(true)
    expect(createPlan).toHaveBeenCalledWith({
      capabilityId: 'image.batch', goal: draft.request.goal, budgetMinor: 150, currency: 'CNY', maxNodes: 2,
    }, expect.any(AbortSignal))
    expect(result.meta).toMatchObject({ protocol: 'qianshou.task-card.v1', cardId: draft.id, title: draft.request.goal })
    expect(ctx.tools.get('compute_plan_draft')?.presentCall?.({
      capabilityId: 'image.batch', goal: draft.request.goal, budgetMinor: 150,
    })).toEqual({
      card: 'generic', title: '拟定算力方案 · 未下单', kind: 'execute', rawInput: draft.request.goal,
    })
    expect(await parsed('compute_plan_draft', {
      capabilityId: 'image.batch', goal: draft.request.goal, budgetMinor: 150,
    }, { agent: { session: { header: { cwd: '/tmp' } } } })).toMatchObject({ id: draft.id, status: 'draft' })
    expect(createPlan).toHaveBeenLastCalledWith(expect.objectContaining({ maxNodes: null, currency: 'CNY' }), expect.any(AbortSignal))
  })

  it('reads an existing workload id and presents the call', async () => {
    await ctx.plugin(ComputeTools)
    expect(await parsed('compute_workload_read', { id: 'wl_1' })).toEqual({ id: 'wl_1', status: 'OFFERED' })
    expect(ctx.tools.get('compute_workload_read')?.presentCall?.({ id: 'wl_1' })).toEqual({
      card: 'generic', title: '查询算力任务', kind: 'read', rawInput: 'wl_1',
    })
  })

  it('aborts every tool when the execution signal is already aborted', async () => {
    await ctx.plugin(ComputeTools)
    const signal = AbortSignal.abort()
    expect((await call('compute_capabilities', {}, { signal })).isError).toBe(true)
    expect((await call('compute_plan_draft', {
      capabilityId: 'image.batch', goal: 'x', budgetMinor: 0,
    }, { signal, agent: { session: { header: { cwd: '/tmp' } } } })).isError).toBe(true)
    expect((await call('compute_workload_read', { id: 'wl_1' }, { signal })).isError).toBe(true)
  })
})
