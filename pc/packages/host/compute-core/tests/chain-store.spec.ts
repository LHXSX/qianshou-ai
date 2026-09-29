import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CHAIN_CONFIRM_TIMEOUT_MS,
  ComputeChainStore,
  defaultChainConfirm,
  parseChainConfirmation,
  parseChainLocator,
  parseChainRequest,
  parseHumanConfirm,
} from '../src/chain-store.ts'
import { ComputeError } from '../src/errors.ts'
import { ComputeService } from '../src/service.ts'
import { ComputeDraftStore } from '../src/store.ts'
import type { QianshouCoreClient } from '../src/core-client.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('compute chain drafts', () => {
  it('admits registry capabilities and generated input kinds', () => {
    const request = parseChainRequest({
      steps: [
        { capability: 'media.transcode', input: { kind: 'inline', value: { n: 1 } } },
        { capability: 'speech.transcribe', input: { kind: 'ref', uri: 'https://example.test/a.wav', sha256: 'ab' } },
      ],
      budgetMinor: 12,
      currency: 'CNY',
    })
    expect(request.steps).toHaveLength(2)
    expect(request.recipeId).toBeNull()
  })

  it('rejects package names, legacy task types, and extra step keys', () => {
    expect(() => parseChainRequest({
      steps: [{ capability: 'ffmpeg', input: { kind: 'inline', value: 'x' } }],
      budgetMinor: 1, currency: 'CNY',
    })).toThrow(ComputeError)
    expect(() => parseChainRequest({
      steps: [{ capability: 'video_compress', input: { kind: 'inline', value: 'x' } }],
      budgetMinor: 1, currency: 'CNY',
    })).toThrow(ComputeError)
    expect(() => parseChainRequest({
      steps: [{ capability: 'media.transcode', input: { kind: 'inline', value: 'x' }, worker: 'n1' }],
      budgetMinor: 1, currency: 'CNY',
    })).toThrow(/INVALID_COMPUTE_FIELD/u)
  })

  it('persists a pending card and never calls developer-task create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-chain-'))
    roots.push(root)
    const chains = new ComputeChainStore({ path: join(root, 'chains.json'), maxChains: 8, maxBytes: 64_000 })
    const createDeveloperTask = vi.fn()
    const getCapabilityRegistry = vi.fn().mockResolvedValue({ registryVersion: 'fixture-v1', capabilities: [{ capability: 'doc.pdf.extract' }] })
    const service = new ComputeService(
      { createDeveloperTask, getCapabilityRegistry, close: async () => {} } as unknown as QianshouCoreClient,
      { close: async () => {} } as unknown as ComputeDraftStore,
      () => true,
      undefined,
      undefined,
      undefined,
      chains,
    )
    const draft = await service.createChain({
      steps: [{ capability: 'doc.pdf.extract', input: { kind: 'inline', value: 'pdf' } }],
      budgetMinor: 3,
      currency: 'CNY',
    })
    expect(draft.status).toBe('draft')
    expect(draft.authorization).toBe('pending')
    expect(draft.reason).toContain('等你的确认')
    expect(draft.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(createDeveloperTask).not.toHaveBeenCalled()
    expect(draft.humanConfirm).toEqual(defaultChainConfirm())
    expect(draft.humanConfirm.onAbsent).toBe('hold')
    expect(draft.humanConfirm.timeoutMs).toBe(DEFAULT_CHAIN_CONFIRM_TIMEOUT_MS)
    expect(draft.absence).toBeNull()
    expect(draft.stepDraftIds).toBeNull()
    await chains.close()
  })

  it('prepares a new task only when its developer catalogue row admits inline input; chains still require registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-new-capability-'))
    roots.push(root)
    const chains = new ComputeChainStore({ path: join(root, 'chains.json'), maxChains: 8, maxBytes: 64_000 })
    const plans = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 8, maxBytes: 64_000 })
    const getCapabilityRegistry = vi.fn().mockResolvedValue({ registryVersion: 'fixture-v2', capabilities: [
      { capability: 'owner.poster.v2', implementations: ['reviewed-package'], legacyTaskTypes: [] },
    ] })
    const getDeveloperTaskTypes = vi.fn().mockResolvedValue([
      { taskType: 'owner.poster.v2', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
        requiredParams: [] },
    ])
    const createDeveloperTask = vi.fn()
    const client = { getCapabilityRegistry, getDeveloperTaskTypes, createDeveloperTask,
      close: async () => {} } as unknown as QianshouCoreClient
    const service = new ComputeService(client, plans, () => true, undefined, undefined, undefined, chains)
    const plan = await service.createPlan({ capabilityId: 'owner.poster.v2', goal: '先拟海报制作方案', budgetMinor: 5, currency: 'CNY', maxNodes: null })
    expect(plan.request.capabilityId).toBe('owner.poster.v2')
    expect(plan.authorization).toBe('pending')
    expect(plan.workloadId).toBeNull()
    const draft = await service.createChain({
      steps: [{ capability: 'owner.poster.v2', input: { kind: 'inline', value: { prompt: '海报' } } }],
      budgetMinor: 5, currency: 'CNY',
    })
    expect(draft.request.steps[0]?.capability).toBe('owner.poster.v2')
    expect(draft.authorization).toBe('pending')
    expect(draft.stepDraftIds).toBeNull()
    expect(createDeveloperTask).not.toHaveBeenCalled()
    await expect(service.createPlan({ capabilityId: 'owner.unknown', goal: '未知', budgetMinor: 0, currency: 'CNY', maxNodes: null }))
      .rejects.toMatchObject({ code: 'COMPUTE_CAPABILITY_UNAVAILABLE' })
    await expect(service.createChain({
      steps: [{ capability: 'owner.unknown', input: { kind: 'inline', value: 'x' } }],
      budgetMinor: 0, currency: 'CNY',
    })).rejects.toMatchObject({ code: 'COMPUTE_CAPABILITY_NOT_REGISTRY' })
    getDeveloperTaskTypes.mockRejectedValueOnce(new ComputeError('CORE_HTTP_503', 503))
    await expect(service.createPlan({ capabilityId: 'owner.poster.v2', goal: '离线时不保存', budgetMinor: 0, currency: 'CNY', maxNodes: null }))
      .rejects.toMatchObject({ code: 'CORE_HTTP_503' })
    getCapabilityRegistry.mockRejectedValueOnce(new ComputeError('CORE_HTTP_503', 503))
    await expect(service.createChain({
      steps: [{ capability: 'owner.poster.v2', input: { kind: 'inline', value: 'x' } }],
      budgetMinor: 0, currency: 'CNY',
    })).rejects.toMatchObject({ code: 'CORE_HTTP_503' })
    expect(await plans.list()).toHaveLength(1)
    expect((await chains.get(draft.id)).id).toBe(draft.id)
    expect(createDeveloperTask).not.toHaveBeenCalled()
    await service.close()
  })
})

describe('human_confirm on local chain cards', () => {
  const steps = [{ capability: 'doc.pdf.extract', input: { kind: 'inline', value: 'pdf' } }]

  it('defaults timeout and on_absent to a 24h hold', () => {
    expect(parseHumanConfirm({})).toEqual({ timeoutMs: 86_400_000, onAbsent: 'hold' })
    expect(parseHumanConfirm({ timeout: 3_600_000, on_absent: 'abort' })).toEqual({
      timeoutMs: 3_600_000, onAbsent: 'abort',
    })
    expect(() => parseHumanConfirm({ on_absent: 'ignore' })).toThrow(/INVALID_COMPUTE_FIELD/u)
    expect(() => parseChainConfirmation({ id: 'chain_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', decision: 'pending' })).toThrow(/INVALID_COMPUTE_FIELD/u)
    expect(() => parseChainLocator({ id: 'chain_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', extra: 1 })).toThrow(/INVALID_COMPUTE_FIELD/u)
  })

  it('records owner confirm and expand without calling the core', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-confirm-'))
    roots.push(root)
    const chains = new ComputeChainStore({ path: join(root, 'chains.json'), maxChains: 8, maxBytes: 64_000 })
    const store = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 8, maxBytes: 64_000 })
    const getIdentity = vi.fn()
    const createDeveloperTask = vi.fn()
    const getCapabilityRegistry = vi.fn().mockResolvedValue({ registryVersion: 'fixture-v1', capabilities: [
      { capability: 'media.transcode' }, { capability: 'speech.transcribe' },
    ] })
    const service = new ComputeService(
      { getIdentity, createDeveloperTask, getCapabilityRegistry, close: async () => {} } as unknown as QianshouCoreClient,
      store,
      () => true,
      undefined,
      undefined,
      undefined,
      chains,
    )
    const draft = await service.createChain({
      steps: [
        { capability: 'media.transcode', input: { kind: 'inline', value: 'clip' } },
        { capability: 'speech.transcribe', input: { kind: 'ref', uri: 'https://example.test/a.wav' } },
      ],
      budgetMinor: 8,
      currency: 'CNY',
      human_confirm: { timeout: 3_600_000, on_absent: 'hold' },
    })
    expect(draft.humanConfirm).toEqual({ timeoutMs: 3_600_000, onAbsent: 'hold' })
    await expect(service.expandChain({ id: draft.id })).rejects.toMatchObject({ code: 'COMPUTE_CHAIN_NOT_APPROVED' })
    const approved = await service.confirmChain({ id: draft.id, decision: 'approved' })
    expect(approved.authorization).toBe('approved')
    expect(approved.reason).toContain('本机确认')
    expect(approved.reason).toContain('尚未下单')
    const first = await service.expandChain({ id: draft.id })
    expect(first.drafts).toHaveLength(2)
    expect(first.drafts.map(item => item.request.capabilityId)).toEqual(['media.transcode', 'speech.transcribe'])
    expect(first.drafts.every(item => item.authorization === 'pending' && item.workloadId === null)).toBe(true)
    expect(first.chain.stepDraftIds).toEqual(first.drafts.map(item => item.id))
    const second = await service.expandChain({ id: draft.id })
    expect(second.drafts.map(item => item.id)).toEqual(first.drafts.map(item => item.id))
    expect(getIdentity).not.toHaveBeenCalled()
    expect(createDeveloperTask).not.toHaveBeenCalled()
    await service.close()
  })

  it('writes an absence trace for hold, abort, and proceed_with_default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-absent-'))
    roots.push(root)
    const chains = new ComputeChainStore({ path: join(root, 'chains.json'), maxChains: 8, maxBytes: 64_000 })
    const hold = await chains.create(
      parseChainRequest({ steps, budgetMinor: 1, currency: 'CNY' }),
      { timeoutMs: 1_000, onAbsent: 'hold' },
    )
    const abort = await chains.create(
      parseChainRequest({ steps, budgetMinor: 1, currency: 'CNY' }),
      { timeoutMs: 1_000, onAbsent: 'abort' },
    )
    const proceed = await chains.create(
      parseChainRequest({ steps, budgetMinor: 1, currency: 'CNY' }),
      { timeoutMs: 1_000, onAbsent: 'proceed_with_default' },
    )
    // The store stamps cards with the real creation clock; use the latest
    // observed card timestamp so this test remains valid across wall-clock dates.
    const now = new Date(Math.max(Date.parse(hold.createdAt), Date.parse(abort.createdAt), Date.parse(proceed.createdAt)) + 1_000)
    const early = await chains.noteAbsence(hold.id, new Date(new Date(hold.createdAt).getTime() + 500))
    expect(early.absence).toBeNull()
    expect(early.authorization).toBe('pending')
    const held = await chains.noteAbsence(hold.id, now)
    expect(held.authorization).toBe('pending')
    expect(held.absence?.behavior).toBe('hold')
    expect(held.absence?.note).toContain('缺席')
    expect(held.reason).toContain('hold')
    const aborted = await chains.noteAbsence(abort.id, now)
    expect(aborted.authorization).toBe('declined')
    expect(aborted.absence?.behavior).toBe('abort')
    await expect(chains.confirm(abort.id, 'approved')).rejects.toMatchObject({ code: 'COMPUTE_CHAIN_ABSENT_ABORTED' })
    const passed = await chains.noteAbsence(proceed.id, now)
    expect(passed.authorization).toBe('approved')
    expect(passed.absence?.behavior).toBe('proceed_with_default')
    expect(passed.reason).toContain('proceed_with_default')
    expect(passed.reason).toContain('尚未下单')
    await chains.close()
  })
})
