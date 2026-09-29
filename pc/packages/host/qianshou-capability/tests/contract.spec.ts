/** The shipped `contracts/v1` copy is the only capability vocabulary, and the card's intent subset is validated against it. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ContractLoadError, intentViolations, isCapabilityId, loadContracts } from '../src/contract.ts'
import type { ContractSet } from '../src/contract.ts'

const REPOSITORY_CONTRACTS = fileURLToPath(new URL('../../../../contracts/v1/', import.meta.url))
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A directory holding only the two contract files, so one malformed file is the sole difference. */
async function contractsDir(registry: unknown, intent: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-capability-contracts-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const write = async (name: string, value: unknown): Promise<void> => {
    if (value === undefined) return
    await writeFile(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  await write('capabilities.registry.json', registry)
  await write('intent.schema.json', intent)
  return dir
}

const GOOD_REGISTRY = {
  contract: 'qianshou/capabilities/registry/v1',
  registry_version: '1.0',
  capabilities: [{ capability: 'media.transcode', title: '音视频转码', legacy_task_types: ['video_compress'] }],
}

const GOOD_INTENT = {
  title: 'qianshou/intent/v1',
  type: 'object',
  properties: {
    goal: { type: 'string' },
    budget: {
      type: 'object',
      properties: { amount_minor: { type: 'integer' }, currency: { type: 'string' } },
      required: ['amount_minor', 'currency'],
      additionalProperties: false,
    },
  },
}

describe('the shipped contract copy', () => {
  it('names every capability and its first platform landing', async () => {
    const contracts = await loadContracts(REPOSITORY_CONTRACTS)
    expect(contracts.registryVersion).toBe('1.0')
    expect(contracts.capabilities.get('media.transcode')).toEqual({
      id: 'media.transcode',
      title: '音视频转码',
      legacyTaskTypes: ['video_compress', 'video_repurpose'],
    })
    expect(contracts.capabilities.get('accelerator.gpu')?.legacyTaskTypes).toEqual([])
    expect([...contracts.capabilities.keys()].every(id => isCapabilityId(id))).toBe(true)
  })

  it.each([
    ['a missing registry', undefined, GOOD_INTENT, 'capabilities.registry.json'],
    ['a registry that is not JSON', '{', GOOD_INTENT, 'not JSON'],
    ['another registry contract', { ...GOOD_REGISTRY, contract: 'qianshou/capabilities/registry/v2' }, GOOD_INTENT, 'contract must be'],
    ['a blank registry version', { ...GOOD_REGISTRY, registry_version: '' }, GOOD_INTENT, 'registry_version'],
    ['an empty capability list', { ...GOOD_REGISTRY, capabilities: [] }, GOOD_INTENT, 'non-empty array'],
    ['a name outside the grammar', { ...GOOD_REGISTRY, capabilities: [{ capability: 'Media.Transcode' }] }, GOOD_INTENT, 'name_grammar'],
    ['a duplicate name', { ...GOOD_REGISTRY, capabilities: [{ capability: 'media.probe' }, { capability: 'media.probe' }] }, GOOD_INTENT, 'duplicate capability'],
    ['a non-string landing', { ...GOOD_REGISTRY, capabilities: [{ capability: 'media.probe', legacy_task_types: [7] }] }, GOOD_INTENT, 'legacy_task_types'],
    ['another intent title', GOOD_REGISTRY, { ...GOOD_INTENT, title: 'qianshou/intent/v2' }, 'title must be'],
    ['an unsupported intent schema', GOOD_REGISTRY, { ...GOOD_INTENT, properties: { goal: { type: 'nonsense' }, budget: {} } }, 'intent.schema.json'],
  ])('refuses %s at load', async (_case, registry, intent, detail) => {
    const dir = await contractsDir(registry, intent)
    await expect(loadContracts(dir)).rejects.toBeInstanceOf(ContractLoadError)
    await expect(loadContracts(dir)).rejects.toThrow(detail as string)
  })
})

describe('capability id grammar', () => {
  // `render.3d` ships in the registry, so a segment may start with a digit; rejecting it would
  // make that capability permanently unreachable, which is the mismatch the registry removes.
  it.each(['media.transcode', 'doc.pdf.extract', 'render.3d', 'ml.onnx.infer', 'a.b'])('accepts %s', (id) => {
    expect(isCapabilityId(id)).toBe(true)
  })

  it.each(['media', 'Media.Transcode', 'media..probe', '.media', 'media.', 'media probe', '', 7, null, undefined])('rejects %p', (id) => {
    expect(isCapabilityId(id)).toBe(false)
  })

  it('rejects an id longer than the accepted bound', () => {
    expect(isCapabilityId(`a.${'b'.repeat(127)}`)).toBe(false)
  })
})

describe('the card intent subset', () => {
  let contracts: ContractSet | undefined
  const load = async (): Promise<ContractSet> => contracts ??= await loadContracts(REPOSITORY_CONTRACTS)

  it('accepts a goal with and without a local budget cap', async () => {
    const set = await load()
    expect(intentViolations(set, { goal: 'compress this clip', budget: null })).toEqual([])
    expect(intentViolations(set, { goal: 'compress this clip', budget: { amount_minor: 500, currency: 'CNY' } })).toEqual([])
  })

  it.each([
    ['a value that is not an object', 'goal', 'intent must be an object'],
    ['a field outside the subset', { goal: 'g', budget: null, account_id: 'x' }, 'intent.account_id is not part of the card subset'],
    ['a non-string goal', { goal: 7, budget: null }, 'intent.goal'],
    ['a fractional budget amount', { goal: 'g', budget: { amount_minor: 1.5, currency: 'CNY' } }, 'intent.budget'],
    ['a budget without a currency', { goal: 'g', budget: { amount_minor: 100 } }, 'intent.budget'],
    ['an unknown budget field', { goal: 'g', budget: { amount_minor: 100, currency: 'CNY', vendor: 'x' } }, 'intent.budget'],
  ])('reports %s', async (_case, intent, violation) => {
    const set = await load()
    expect(intentViolations(set, intent).join('\n')).toContain(violation as string)
  })

  it('reports a goal longer than the card accepts', async () => {
    const set = await load()
    expect(intentViolations(set, { goal: 'x'.repeat(2001), budget: null })).toEqual(['intent.goal exceeds 2000 characters'])
  })
})
