import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIsolatedInlineRunner } from '@deepseek-ai/dsh-compute-core'
import {
  createLocalTextStatisticsOrderRunner,
  inspectInstalledWordCountBundle,
  installedLocalPluginDigest,
  resolveLocalTextStatisticsOrderBinding,
  type LocalTextStatisticsOrderHost,
} from '../../../packages/host/node-contributor/src/local-plugin-order.ts'
import { createOrderAcceptanceAgent, type OrderAcceptanceCourierInput } from '../order-agent.ts'

const PACKAGE = 'qianshou-local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOOL = 'qianshou_local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-local-order-'))
  roots.push(root)
  const installed = join(root, 'node_modules', PACKAGE)
  await mkdir(installed, { recursive: true })
  await Promise.all([
    writeFile(join(installed, 'package.json'), JSON.stringify({ name: PACKAGE, version: '2.0.0', type: 'module',
      main: 'index.js', qianshouWorkflowRef: 'qianshou:text-statistics-v2',
      qianshouOrderAdapter: { version: 1, capabilityId: 'text.transform', taskType: 'word_count', toolName: TOOL,
        entry: 'index.js' } })),
    writeFile(join(installed, 'cordis.patch.yml'), `- insert:\n    - id: ${PACKAGE}\n`),
    writeFile(join(installed, 'index.js'), 'export function apply() {}\n'),
  ])
  const packageDigest = await installedLocalPluginDigest(root, PACKAGE)
  if (packageDigest === null) throw new Error('fixture missing')
  const binding = resolveLocalTextStatisticsOrderBinding({ packageName: PACKAGE, toolName: TOOL, packageDigest })
  if (binding === null) throw new Error('fixture binding missing')
  let state = 'active'
  let selected = true
  let registered = true
  let executeCount = 0
  let changeAfterExecute = false
  let incorrectOutput = false
  let wrongWordCounts = false
  const host: LocalTextStatisticsOrderHost = {
    profileDir: () => root,
    manager: () => ({ checkBundle: async () => ({ state, selected,
      rows: [{ moduleName: PACKAGE, enabled: selected, phase: state === 'active' ? 'active' : null }] }) }),
    tools: () => ({
      get: () => registered ? { name: TOOL } : undefined,
      execute: async ({ arguments: args }) => {
        executeCount += 1
        if (changeAfterExecute) state = 'disabled'
        const text = (args as { text: string }).text
        const counts = new Map<string, number>()
        for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
          counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
        }
        const wordCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100)
          .map(([word, count]) => ({ word, count: count + (wrongWordCounts ? 1 : 0) }))
        return { isError: false as const, value: JSON.stringify({
          characters: Array.from(text).length + (incorrectOutput ? 1 : 0),
          utf8Bytes: Buffer.byteLength(text),
          nonemptyLines: text.split(/\r?\n/u).filter(line => line.trim() !== '').length,
          sha256: createHash('sha256').update(text).digest('hex'),
          wordCounts,
        }) }
      },
    }),
  }
  return { root, installed, binding, host, setState: (next: string) => { state = next },
    setSelected: (next: boolean) => { selected = next }, setRegistered: (next: boolean) => { registered = next },
    setChangeAfterExecute: (next: boolean) => { changeAfterExecute = next },
    setIncorrectOutput: (next: boolean) => { incorrectOutput = next },
    setWrongWordCounts: (next: boolean) => { wrongWordCounts = next }, executeCount: () => executeCount }
}

const INPUT = '你好\n世界'

describe('installed local text-statistics plugin order binding', () => {
  it('runs the pinned installed tool through the real four-role order agent and sends a verified platform-readable document', async () => {
    const env = await fixture()
    const delivered: OrderAcceptanceCourierInput[] = []
    const agent = createOrderAcceptanceAgent({
      policy: { capabilityMode: 'builtin', authorizedTaskTypes: ['word_count'] },
      runner: createLocalTextStatisticsOrderRunner(env.binding, env.host, createIsolatedInlineRunner()),
      courier: { deliver: async (input) => { delivered.push(input); return { accepted: true, reference: 'local-order-test' } } },
    })
    const work = join(env.root, 'attempt')
    await mkdir(work)
    const result = await agent.handleOffer({ shardId: 'shard-local-plugin', attempt: 1,
      taskType: 'word_count', inlineInput: INPUT },
    { workspacePath: work, signal: new AbortController().signal, startedAtMs: Date.now() })
    expect(result.delivered).toBe(true)
    expect(result.orchestration?.verification?.outcome).toBe('passed')
    expect(delivered).toHaveLength(1)
    const document = JSON.parse(await readFile(join(work, 'result.txt'), 'utf8')) as Record<string, unknown>
    expect(document.task_type).toBe('word_count')
    expect(document.result_lines).toEqual(['你好\t1', '世界\t1'])
    expect(delivered[0]?.verifiedText).toBe(JSON.stringify(document))
    expect(env.executeCount()).toBe(1)
  })

  it('refuses inactive, unselected, missing-tool and modified packages before invoking the tool', async () => {
    for (const bad of ['inactive', 'unselected', 'missing-tool', 'modified']) {
      const env = await fixture()
      if (bad === 'inactive') env.setState('disabled')
      if (bad === 'unselected') env.setSelected(false)
      if (bad === 'missing-tool') env.setRegistered(false)
      if (bad === 'modified') await writeFile(join(env.installed, 'index.js'), 'export function apply() { /* changed */ }\n')
      const run = createLocalTextStatisticsOrderRunner(env.binding, env.host, createIsolatedInlineRunner())
      await expect(run({ taskType: 'word_count', inlineInput: INPUT, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: bad === 'modified' ? 'COMPUTE_LOCAL_ORDER_PLUGIN_CHANGED' : 'COMPUTE_LOCAL_ORDER_PLUGIN_UNAVAILABLE' })
      expect(env.executeCount()).toBe(0)
    }
  })

  it('rejects incorrect plugin output or an uninstall during execution before delivery', async () => {
    const env = await fixture()
    const run = createLocalTextStatisticsOrderRunner(env.binding, env.host, createIsolatedInlineRunner())
    env.setIncorrectOutput(true)
    await expect(run({ taskType: 'word_count', inlineInput: INPUT, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID' })
    env.setIncorrectOutput(false)
    env.setWrongWordCounts(true)
    await expect(run({ taskType: 'word_count', inlineInput: INPUT, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID' })
    env.setWrongWordCounts(false)
    env.setChangeAfterExecute(true)
    await expect(run({ taskType: 'word_count', inlineInput: INPUT, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'COMPUTE_LOCAL_ORDER_PLUGIN_UNAVAILABLE' })
  })

  it('does not select a bundle when a same-name global tool returns a wrong word frequency', async () => {
    // The tool registry has no public package-owner field. This fixture deliberately
    // exposes the claimed tool name even though the package index registers nothing.
    const env = await fixture()
    env.setWrongWordCounts(true)
    expect(await inspectInstalledWordCountBundle(PACKAGE, env.host)).toMatchObject({
      eligible: false, reason: 'output-unverified',
    })
    const run = createLocalTextStatisticsOrderRunner(env.binding, env.host, createIsolatedInlineRunner())
    await expect(run({ taskType: 'word_count', inlineInput: INPUT, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID' })
  })

  it('keeps a v1 character-statistics bundle out of the paid word_count landing', async () => {
    const env = await fixture()
    await writeFile(join(env.installed, 'package.json'), JSON.stringify({ name: PACKAGE, version: '1.0.0' }))
    const packageDigest = await installedLocalPluginDigest(env.root, PACKAGE)
    const binding = resolveLocalTextStatisticsOrderBinding({ packageName: PACKAGE, toolName: TOOL, packageDigest: packageDigest ?? '' })
    if (binding === null) throw new Error('old binding missing')
    const run = createLocalTextStatisticsOrderRunner(binding, env.host, createIsolatedInlineRunner())
    await expect(run({ taskType: 'word_count', inlineInput: INPUT, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'COMPUTE_LOCAL_ORDER_PLUGIN_TASK_TYPE_UNSUPPORTED' })
    expect(env.executeCount()).toBe(0)
  })

  it('does not infer an order binding from a package name alone', async () => {
    expect(resolveLocalTextStatisticsOrderBinding(undefined)).toBeNull()
    expect(() => resolveLocalTextStatisticsOrderBinding({ packageName: PACKAGE, toolName: TOOL, packageDigest: 'bad' }))
      .toThrow('COMPUTE_LOCAL_ORDER_PLUGIN_CONFIG_INVALID')
    expect(() => resolveLocalTextStatisticsOrderBinding({ packageName: PACKAGE, toolName: '../other', packageDigest: 'a'.repeat(64) }))
      .toThrow('COMPUTE_LOCAL_ORDER_PLUGIN_CONFIG_INVALID')
  })
})
