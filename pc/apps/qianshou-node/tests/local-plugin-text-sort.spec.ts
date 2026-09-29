import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createIsolatedInlineRunner } from '@deepseek-ai/dsh-compute-core'
import {
  createLocalInlineOrderRunner, findInstalledInlineOrderBinding, inspectInstalledInlineOrderBundle,
  type LocalTextStatisticsOrderHost,
} from '../../../packages/host/node-contributor/src/local-plugin-order.ts'

const PACKAGE = 'qianshou-test-text-sort'
const TOOL = 'qianshou_test_text_sort'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-sort-order-'))
  roots.push(root)
  const installed = join(root, 'node_modules', PACKAGE)
  await mkdir(installed, { recursive: true })
  await Promise.all([
    writeFile(join(installed, 'package.json'), JSON.stringify({ name: PACKAGE, version: '1.0.0',
      type: 'module', main: 'index.js', qianshouOrderAdapter: { version: 2,
        capabilityId: 'text.transform', taskType: 'text_sort', toolName: TOOL, entry: 'index.js',
        inputKind: 'inline', outputKind: 'inline_json', contractVersion: 'v1' } })),
    writeFile(join(installed, 'cordis.patch.yml'), `- insert:\n    - id: ${PACKAGE}\n`),
    writeFile(join(installed, 'index.js'), 'export function apply() {}\n'),
  ])
  let wrong = false
  let calls = 0
  const host: LocalTextStatisticsOrderHost = {
    profileDir: () => root,
    manager: () => ({ checkBundle: async () => ({ state: 'active', selected: true,
      rows: [{ moduleName: PACKAGE, enabled: true, phase: 'active' }] }) }),
    tools: () => ({ get: name => name === TOOL ? { name } : undefined,
      execute: async ({ arguments: args }) => {
        calls += 1
        const text = (args as { text: string }).text
        const input = text.trimStart().startsWith('{')
          ? JSON.parse(text) as { lines: string[]; params: { numeric?: boolean; reverse?: boolean;
            unique?: boolean; case_insensitive?: boolean } }
          : { lines: text.split('\n'), params: {} as { numeric?: boolean; reverse?: boolean;
            unique?: boolean; case_insensitive?: boolean } }
        const lines = input.params.unique ? [...new Set(input.lines)] : [...input.lines]
        lines.sort((left, right) => {
          if (input.params.numeric) {
            const number = (value: string) => /^\d+$/u.test(value) ? Number(value) : Infinity
            return number(left) - number(right) || 0
          }
          const a = input.params.case_insensitive ? left.toLowerCase() : left
          const b = input.params.case_insensitive ? right.toLowerCase() : right
          return a < b ? -1 : a > b ? 1 : 0
        })
        if (input.params.reverse) lines.reverse()
        return { isError: false as const, value: JSON.stringify({ sortedLines: wrong ? ['fabricated'] : lines }) }
      } }),
  }
  return { root, installed, host, setWrong: (value: boolean) => { wrong = value }, calls: () => calls }
}

it('binds an installed text_sort contract, verifies its option fixtures, and produces a platform document', async () => {
  const env = await fixture()
  const binding = await findInstalledInlineOrderBinding(PACKAGE, env.host)
  expect(binding).toMatchObject({ packageName: PACKAGE, taskType: 'text_sort' })
  expect(await inspectInstalledInlineOrderBundle(PACKAGE, env.host)).toMatchObject({ eligible: true,
    contract: { taskType: 'text_sort', inputKind: 'inline', outputKind: 'inline_json' } })
  expect(env.calls()).toBe(3)
  const runner = createLocalInlineOrderRunner(binding!, env.host, createIsolatedInlineRunner())
  const response = await runner({ taskType: 'text_sort', inlineInput: '三\n一\n二', signal: new AbortController().signal })
  const document = JSON.parse(response.text) as Record<string, unknown>
  expect(document).toMatchObject({ status: 'ok', task_type: 'text_sort', schema_version: 'v1',
    summary: { input_lines: 3, output_lines: 3 }, result_lines: ['一', '三', '二'] })
})

it('refuses a fabricated sorted result and an installed package changed after selection', async () => {
  const env = await fixture()
  const binding = await findInstalledInlineOrderBinding(PACKAGE, env.host)
  if (binding === null) throw new Error('fixture missing')
  const runner = createLocalInlineOrderRunner(binding, env.host, createIsolatedInlineRunner())
  env.setWrong(true)
  await expect(runner({ taskType: 'text_sort', inlineInput: 'z\na', signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID' })
  env.setWrong(false)
  await writeFile(join(env.installed, 'index.js'), 'export function apply() { /* changed */ }\n')
  await expect(runner({ taskType: 'text_sort', inlineInput: 'z\na', signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'COMPUTE_LOCAL_ORDER_PLUGIN_CHANGED' })
})

it('does not bind a text_sort package that omits its exact input or output contract', async () => {
  const env = await fixture()
  const manifest = JSON.parse(await readFile(join(env.installed, 'package.json'), 'utf8'))
  delete manifest.qianshouOrderAdapter.outputKind
  await writeFile(join(env.installed, 'package.json'), JSON.stringify(manifest))
  expect(await findInstalledInlineOrderBinding(PACKAGE, env.host)).toBeNull()
  expect(await inspectInstalledInlineOrderBundle(PACKAGE, env.host)).toMatchObject({
    eligible: false, reason: 'platform-task-unmapped',
  })
})
