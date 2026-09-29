/** Pin the model-visible landscape result through the real CEO preset tool mount. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ComputeTools from '../src/tools.ts'

const preset = join(dirname(fileURLToPath(import.meta.url)), '../../../../qianshou/presets/qianshou-ceo/agent.cordis.yml')

it('pins the CEO tool landscape as model-visible text without contacting live services', async () => {
  const source = await readFile(preset, 'utf8')
  expect(source).toMatch(/^- id: qianshou-compute-tools\n  name: '@deepseek-ai\/dsh-compute-core\/tools'/m)

  const root = await mkdtemp(join(tmpdir(), 'qianshou-landscape-output-'))
  let ctx: Context | undefined
  let discoveryCalls = 0
  try {
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: 'qianshou-landscape-external-fixture'",
      "- name: '@deepseek-ai/dsh-compute-core/tools'",
      '',
    ].join('\n'))

    const externalFixture = {
      name: 'qianshou-landscape-external-fixture',
      apply(scope: Context) {
        scope.provide('qianshouAccount', {
          state: async () => ({ phase: 'authenticated', models: ['千手·迅捷'] }),
        } as never)
        scope.provide('computeCore', {
          async capabilityDiscovery() {
            discoveryCalls++
            return {
              registry: { status: 'observed', observedAt: '2026-09-24T01:00:00.000Z', reason: null,
                registryVersion: 'registry-1', capabilities: [
                  { capability: 'media.transcode', implementations: ['ffmpeg'], legacyTaskTypes: ['video_compress'] },
                  { capability: 'owner.drawn-video', implementations: ['local-plugin'], legacyTaskTypes: [] },
                ] },
              requestableTaskTypes: { status: 'observed', observedAt: '2026-09-24T01:00:01.000Z', reason: null,
                items: [{ taskType: 'video_compress' }] },
            }
          },
          executors: { list: () => [{ capabilityId: 'owner.drawn-video', version: '1.0.0' }] },
          lastObservedSupply: () => ({ observedAt: '2026-09-24T00:30:00.000Z', localServices: [
            { id: 'tool.ffmpeg', kind: 'tool', name: 'FFmpeg', version: '7.0', verification: 'verified', reason: null },
            { id: 'model.video', kind: 'local-model', name: '本机视频模型', version: null,
              verification: 'pending', reason: 'self_test_missing' },
          ] }),
          pool: () => { throw new Error('worker lookup must not run') },
          createPlan: () => { throw new Error('planning must not run') },
          publishPlan: () => { throw new Error('dispatch must not run') },
        } as never)
      },
    }
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['qianshou-landscape-external-fixture', externalFixture],
      ['@deepseek-ai/dsh-compute-core/tools', ComputeTools],
    ])
    ctx = await boot('qianshou-ceo-landscape-output', config, undefined, preparing => {
      preparing.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof preparing.loader.internal>
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('landscape'), name: 'compute_capability_landscape', arguments: {},
    })
    expect(result.isError).not.toBe(true)
    expect(discoveryCalls).toBe(1)
    const content = result.content.find(block => block.type === 'text')
    if (content?.type !== 'text') throw new Error('landscape did not return model-visible text')
    expect(JSON.parse(content.text)).toMatchObject({
      shanghai: { capabilities: [{ id: 'media.transcode' }, { id: 'owner.drawn-video', legacyTaskTypes: [] }],
        liveWorkersChecked: false },
      local: { registeredExecutors: [{ capabilityId: 'owner.drawn-video', version: '1.0.0' }],
        currentHealthChecked: false, ownerOrderAuthorizationChecked: false },
      quoteChecked: false, executionAuthorized: false, orderIntakeEnabled: 'not_observed',
    })
    expect(content.text).toMatchSnapshot()
  } finally {
    await ctx?.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
