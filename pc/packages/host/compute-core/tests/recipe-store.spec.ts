import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeChainStore } from '../src/chain-store.ts'
import { ComputeError } from '../src/errors.ts'
import { ComputeRecipeStore, parseRecipeMatchQuery } from '../src/recipe-store.ts'
import { ComputeService } from '../src/service.ts'
import type { ComputeDraftStore } from '../src/store.ts'
import type { QianshouCoreClient } from '../src/core-client.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const STEPS = [
  { capability: 'media.transcode', input: { kind: 'inline', value: 'clip' } },
  { capability: 'speech.transcribe', input: { kind: 'ref', uri: 'https://example.test/a.wav' } },
] as const

async function openService() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-recipe-'))
  roots.push(root)
  const chains = new ComputeChainStore({ path: join(root, 'chains.json'), maxChains: 8, maxBytes: 64_000 })
  const recipes = new ComputeRecipeStore({ path: join(root, 'recipes.json'), maxRecipes: 8, maxBytes: 64_000 })
  const getIdentity = vi.fn()
  const createDeveloperTask = vi.fn()
  const getCapabilityRegistry = vi.fn().mockResolvedValue({ registryVersion: 'fixture-v1', capabilities: [
    { capability: 'media.transcode' }, { capability: 'speech.transcribe' }, { capability: 'doc.pdf.extract' },
  ] })
  const service = new ComputeService(
    { getIdentity, createDeveloperTask, getCapabilityRegistry, close: async () => {} } as unknown as QianshouCoreClient,
    { close: async () => {} } as unknown as ComputeDraftStore,
    () => true,
    undefined,
    undefined,
    undefined,
    chains,
    recipes,
  )
  return { service, chains, recipes, getIdentity, createDeveloperTask }
}

describe('compute recipe settlement', () => {
  it('hits an accepted recipe on the second intent and does not compose or call the core', async () => {
    const { service, getIdentity, createDeveloperTask } = await openService()
    const first = await service.createChain({ steps: STEPS, budgetMinor: 4, currency: 'CNY' })
    expect(first.status).toBe('draft')
    const settled = await service.settleRecipe({
      status: 'ok',
      recipe_id: 'series-10ep-drama',
      steps: STEPS,
      verify: { passed: true },
    })
    expect(settled.admission).toBe('accepted')
    expect(settled.contract).toBe('qianshou.recipe.v1')
    expect(settled.version).toBe(1)
    expect(settled.taskTypes).toEqual(['video_compress', 'audio_transcribe_refine'])
    expect(settled.mediaKinds).toEqual(['inline', 'ref'])
    const second = await service.createChain({
      recipe_id: 'series-10ep-drama',
      steps: STEPS,
      budgetMinor: 9,
      currency: 'CNY',
    })
    expect(second.status).toBe('hit')
    expect(second.authorization).toBe('pending')
    expect(second.sha256).toBe(settled.sha256)
    expect(second.reason).toContain('未重新编链')
    expect(second.request.steps.map(step => step.capability)).toEqual(['media.transcode', 'speech.transcribe'])
    expect(getIdentity).not.toHaveBeenCalled()
    expect(createDeveloperTask).not.toHaveBeenCalled()
    await service.close()
  })

  it('matches the task-type sequence and media set without step inputs, and misses a different media set', async () => {
    const { service } = await openService()
    const named = await service.settleRecipe({ status: 'ok', recipe_id: 'series-10ep-drama', steps: STEPS })
    const hit = await service.matchRecipe({
      task_types: ['video_compress', 'whisper_transcribe'],
      media_kinds: ['ref', 'inline'],
    })
    expect(hit?.admission).toBe('accepted')
    expect(hit?.sha256).toBe(named.sha256)
    const reused = await service.createChain({ recipe_id: 'series-10ep-drama', budgetMinor: 1, currency: 'CNY' })
    expect(reused.status).toBe('hit')
    expect(reused.sha256).toBe(named.sha256)
    expect(reused.request.steps.map(step => step.capability)).toEqual(['media.transcode', 'speech.transcribe'])
    await expect(service.matchRecipe({
      capabilities: ['media.transcode', 'speech.transcribe'],
      media_kinds: ['inline'],
    })).resolves.toBeNull()
    await service.close()
  })

  it('refuses to settle partial and does not auto-hit failed or rejected rows', async () => {
    const { service } = await openService()
    await expect(service.settleRecipe({ status: 'partial', steps: STEPS })).rejects.toMatchObject({ code: 'COMPUTE_RECIPE_PARTIAL' })
    await expect(service.settleRecipe({ status: 'ok', steps: STEPS, verify: { passed: false } })).rejects.toMatchObject({
      code: 'COMPUTE_RECIPE_VERIFY_FAILED',
    })
    const failed = await service.settleRecipe({ status: 'failed', recipe_id: 'broken', steps: STEPS })
    expect(failed.admission).toBe('candidate')
    await expect(service.matchRecipe({ recipe_id: 'broken' })).resolves.toBeNull()
    const ok = await service.settleRecipe({
      status: 'ok',
      recipe_id: 'keep',
      steps: [{ capability: 'doc.pdf.extract', input: { kind: 'inline', value: 'pdf' } }],
    })
    expect(ok.admission).toBe('accepted')
    await service.rejectRecipe({ sha256: ok.sha256 })
    await expect(service.matchRecipe({ recipe_id: 'keep' })).resolves.toBeNull()
    const draft = await service.createChain({
      recipe_id: 'keep',
      steps: [{ capability: 'doc.pdf.extract', input: { kind: 'inline', value: 'pdf' } }],
      budgetMinor: 1,
      currency: 'CNY',
    })
    expect(draft.status).toBe('draft')
    await service.acceptRecipe({ recipe_id: 'keep' })
    const again = await service.matchRecipe({ recipe_id: 'keep' })
    expect(again?.admission).toBe('accepted')
    await expect(service.createChain({ recipe_id: 'missing-only', budgetMinor: 1, currency: 'CNY' })).rejects.toMatchObject({
      code: 'COMPUTE_RECIPE_MISS',
    })
    await expect(service.settleRecipe({
      status: 'ok',
      steps: [{ capability: 'ffmpeg', input: { kind: 'inline', value: 'x' } }],
    })).rejects.toBeInstanceOf(ComputeError)
    await service.close()
  })

  it('uses the generated reverse map instead of rebuilding one from legacy rows', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/recipe-store.ts', import.meta.url)), 'utf8')
    expect(source).toContain("import { CAPABILITY_BY_TASK_TYPE, LEGACY_TASK_TYPES_BY_CAPABILITY, SEMANTIC_CAPABILITY_NAMES } from './capability-registry.ts'")
    expect(source).not.toContain('new Map')
    expect(parseRecipeMatchQuery({ task_types: ['video_compress', 'whisper_transcribe'] }).taskTypes)
      .toEqual(['media.transcode', 'speech.transcribe'])
    expect(() => parseRecipeMatchQuery({ task_types: ['invented.capability'] })).toThrow('task_types')
    // A registry observation permits planning, but does not prove a new plugin
    // has completed the execution/verification receipt needed for recipe reuse.
    expect(() => parseRecipeMatchQuery({ capabilities: ['owner.poster.v2'] }))
      .toThrow(ComputeError)
  })
})
