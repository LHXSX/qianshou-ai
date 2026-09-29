import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  COMPUTE_HONESTY_PROMPT,
  COMPUTE_HONESTY_SECTION,
  composeVisibleComputeReply,
  forbiddenComputeToolKeys,
  honestComputeSample,
  judgeComputeHonesty,
} from '../src/honesty.ts'
import { ComputeCapabilityId } from '../src/protocol.ts'
import { ComputeService } from '../src/service.ts'
import { ComputeDraftStore } from '../src/store.ts'
import * as ComputeTools from '../src/tools.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const ABSENT = { kind: 'capability-absent' as const, asked: '量子编织', catalog: ['media.transcode'] }
const UNREACHABLE = { kind: 'pool-unreachable' as const, capability: 'media.transcode' }
const DOWNGRADE = {
  kind: 'downgrade' as const,
  modelText: '可以先查目录。',
  downgradeNote: '「千手·强力」在普通版里用不了，这次由「千手·迅捷」作答。',
}

describe('compute honesty samples', () => {
  it('says 没有/做不到 without inventing a capability or node name', () => {
    const reply = honestComputeSample(ABSENT)
    expect(judgeComputeHonesty(reply, ABSENT)).toEqual([])
    expect(reply).toMatch(/没有|做不到/u)
    expect(judgeComputeHonesty('可以派到量子编织节点 n-42，大约 3 台。', ABSENT)).toEqual(
      expect.arrayContaining(['invented-node']),
    )
    expect(judgeComputeHonesty('交给 video.magic.render 就能做。', ABSENT)).toEqual(
      expect.arrayContaining(['missing-cannot', 'invented-capability:video.magic.render']),
    )
  })

  it('keeps an unknown pool count free of digits and guessed empties', () => {
    const reply = honestComputeSample(UNREACHABLE)
    expect(judgeComputeHonesty(reply, UNREACHABLE)).toEqual([])
    expect(reply).not.toMatch(/[0-9]/u)
    expect(judgeComputeHonesty('大约 0 台能接。', UNREACHABLE)).toEqual(
      expect.arrayContaining(['unexpected-digit', 'guessed-count']),
    )
    expect(judgeComputeHonesty('暂无节点', UNREACHABLE)).toEqual(expect.arrayContaining(['guessed-count']))
  })

  it('puts a non-empty downgradeNote into the visible answer', () => {
    const reply = honestComputeSample(DOWNGRADE)
    expect(judgeComputeHonesty(reply, DOWNGRADE)).toEqual([])
    expect(reply).toContain(DOWNGRADE.downgradeNote)
    expect(composeVisibleComputeReply('可以先查目录。', null)).toBe('可以先查目录。')
    expect(judgeComputeHonesty('可以先查目录。', DOWNGRADE)).toEqual(['missing-downgrade-note'])
  })
})

describe('compute honesty wiring', () => {
  let ctx: Context
  let stop: () => Promise<void>

  beforeEach(async () => {
    ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt)
    const runtime = await ctx.plugin(ToolRuntime)
    ctx.provide('computeCore', {
      capabilities: vi.fn(),
      pool: vi.fn(),
      account: vi.fn(),
      createChain: vi.fn(),
      createPlan: vi.fn(),
      publishPlan: vi.fn(),
      workload: vi.fn(),
      workloadResult: vi.fn(),
      status: vi.fn(() => ({ capabilities: { quoting: false, submission: true } })),
    })
    stop = async () => { await runtime.dispose(); await prompt.dispose() }
  })
  afterEach(async () => { await stop() })

  it('assembles the honesty section when compute tools load', async () => {
    await ctx.plugin(ComputeTools)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === COMPUTE_HONESTY_SECTION && section.text === COMPUTE_HONESTY_PROMPT)).toBe(true)
    expect(renderPrompt(assembly)).toContain('你手上没有的能力，就是没有。')
    const keys = assembly.tools.flatMap((tool) => {
      const parameters = tool.parameters as { properties?: Record<string, unknown> } | undefined
      return Object.keys(parameters?.properties ?? {})
    })
    for (const key of forbiddenComputeToolKeys()) {
      expect(keys).not.toContain(key)
    }
  })

  it('refuses submit before owner approval and never reaches the core', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-honesty-'))
    roots.push(root)
    const store = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 8, maxBytes: 64_000 })
    const getIdentity = vi.fn()
    const createDeveloperTask = vi.fn()
    const service = new ComputeService(
      { getIdentity, createDeveloperTask, close: async () => {} } as never,
      store,
      () => true,
    )
    const draft = await store.create({
      capabilityId: ComputeCapabilityId('media.transcode'),
      goal: '本机诚实样本，未下单',
      budgetMinor: 1,
      currency: 'CNY',
      maxNodes: null,
    })
    expect(draft.authorization).toBe('pending')
    await expect(service.publishPlan({ id: draft.id })).rejects.toMatchObject({
      code: 'COMPUTE_PLAN_NOT_APPROVED',
    })
    expect(createDeveloperTask).not.toHaveBeenCalled()
    expect(getIdentity).not.toHaveBeenCalled()
    const approved = await service.confirmPlan({ id: draft.id, decision: 'approved' })
    expect(approved.authorization).toBe('approved')
    await expect(service.publishPlan({ id: draft.id })).rejects.toMatchObject({
      code: 'COMPUTE_QUOTE_CONFIRMATION_REQUIRED',
    })
    expect(createDeveloperTask).not.toHaveBeenCalled()
    expect(getIdentity).not.toHaveBeenCalled()
    await service.close()
  })
})
