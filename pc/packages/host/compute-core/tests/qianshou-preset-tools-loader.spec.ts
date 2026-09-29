/** The two shipped Qianshou agent compositions expose observed compute reads through a real Host Loader. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ComputeTools from '../src/tools.ts'

const presets = join(dirname(fileURLToPath(import.meta.url)), '../../../../qianshou/presets')
const computeToolPackage = '@deepseek-ai/dsh-compute-core/tools'
const toolRuntimePackage = '@deepseek-ai/dsh-tools'
const systemPromptPackage = '@deepseek-ai/dsh-system-prompt'
const computeFixturePackage = 'qianshou-preset-compute-fixture'
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mountedComputeTool(preset: string): Promise<string> {
  const source = await readFile(join(presets, preset, 'agent.cordis.yml'), 'utf8')
  const entries = source.split(/(?=^- id: )/mu).filter(entry => entry.startsWith('- id: qianshou-compute-tools\n'))
  expect(entries, `${preset} must mount one compute tool consumer`).toHaveLength(1)
  expect(entries[0]).not.toMatch(/^\s+disabled: true$/mu)
  const name = /^  name: '([^']+)'$/mu.exec(entries[0] ?? '')?.[1]
  expect(name).toBe(computeToolPackage)
  return entries[0] ?? ''
}

describe('Qianshou preset compute tool composition', () => {
  it.each(['qianshou-ceo', 'qianshou-call', 'qianshou-plugin-creator'])('%s loads real reads with its own planning permission', async preset => {
    const entry = await mountedComputeTool(preset)
    const root = await mkdtemp(join(tmpdir(), 'qianshou-preset-compute-'))
    roots.push(root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      `- name: '${systemPromptPackage}'`,
      `- name: '${toolRuntimePackage}'`,
      `- name: '${computeFixturePackage}'`,
      entry,
      '',
    ].join('\n'))

    const capabilityDiscovery = vi.fn().mockResolvedValue({
      registry: { status: 'observed', observedAt: '2026-09-24T01:00:00.000Z', reason: null,
        registryVersion: '1.0', capabilities: [
          { capability: 'text.transform', implementations: ['node'], legacyTaskTypes: ['word_count'] },
        ] },
      requestableTaskTypes: { status: 'observed', observedAt: '2026-09-24T01:00:01.000Z', reason: null,
        items: [{ taskType: 'word_count', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' }] },
    })
    const pool = vi.fn().mockResolvedValue({
      lookup: 'unreachable', capability: 'text.transform', registryVersion: null,
      declared: null, availableNow: null, provides: [], note: '此刻无法核实在线节点。',
    })
    const fixture = {
      name: computeFixturePackage,
      apply(ctx: Context) {
        ctx.provide('computeCore', {
          capabilityDiscovery, pool,
          executors: { list: () => [] },
          lastObservedSupply: () => null,
        } as never)
      },
    }
    const modules = new Map<string, unknown>([
      [systemPromptPackage, SystemPrompt], [toolRuntimePackage, ToolRuntime],
      [computeFixturePackage, fixture], [computeToolPackage, ComputeTools],
    ])
    const ctx = await boot(`qianshou-${preset}-compute-tools`, configPath, undefined, preparing => {
      preparing.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof preparing.loader.internal>
    })
    contexts.push(ctx)

    expect(ctx.tools.get('compute_capabilities')).toBeDefined()
    expect(ctx.tools.get('compute_cloud_catalog')).toBeDefined()
    expect(ctx.tools.get('compute_capability_landscape')).toBeDefined()
    expect(ctx.tools.get('compute_local_capabilities')).toBeDefined()
    expect(ctx.tools.get('compute_pool')).toBeDefined()
    expect(ctx.tools.get('pc_route_card')).toBeUndefined()
    expect(ctx.tools.get('compute_confirm')).toBeUndefined()
    expect(ctx.tools.get('compute_chain_confirm')).toBeUndefined()
    for (const name of ['compute_dispatch_chain', 'compute_plan_draft', 'compute_submit']) {
      if (preset === 'qianshou-plugin-creator') expect(ctx.tools.get(name)).toBeUndefined()
      else expect(ctx.tools.get(name)).toBeDefined()
    }
    if (preset === 'qianshou-plugin-creator') {
      const result = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId('forbidden-submit'), name: 'compute_submit', arguments: { id: 'plan_1' } })
      expect(result.isError).toBe(true)
    }

    const cloud = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('cloud'), name: 'compute_cloud_catalog', arguments: {},
    })
    expect(cloud.isError).not.toBe(true)
    expect(cloud.content).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'text', text: expect.stringContaining('"imageGeneration":"not_observed"'),
    })]))

    const catalog = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('catalog'), name: 'compute_capabilities', arguments: {},
    })
    expect(catalog.isError).not.toBe(true)
    expect(catalog.content).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'text', text: expect.stringContaining('"id":"text.transform"'),
    })]))
    expect(catalog.content).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'text', text: expect.stringContaining('"liveWorkersChecked":false'),
    })]))
    expect(capabilityDiscovery).toHaveBeenCalledOnce()

    const local = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('local'), name: 'compute_local_capabilities', arguments: {},
    })
    expect(local.isError).not.toBe(true)
    expect(local.content).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'text', text: expect.stringContaining('"health":"not_observed"'),
    })]))

    const workers = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('workers'), name: 'compute_pool', arguments: { capability: 'text.transform' },
    })
    expect(workers.isError).not.toBe(true)
    expect(workers.content).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'text', text: expect.stringContaining('"availableNow":null'),
    })]))
    expect(pool).toHaveBeenCalledWith('text.transform', expect.any(AbortSignal))
  })
})
