import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { skillAuthoringTemplate } from '../src/skill-authoring-template.ts'
import { readGenericOrderSource } from '../src/generic-order-source.ts'
import { runGenericOrderChallenge, verifyGenericOrderAdapter } from '../src/generic-order-adapter.ts'
import { localOrderSourceRejection } from '../src/order-source-diagnostics.ts'
import { canonicalOrderJson } from '../src/order-json-canonical.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function author() {
  const root = await mkdtemp(join(tmpdir(), 'chinese-schema-authoring-'))
  roots.push(root)
  for (const [name, content] of Object.entries(skillAuthoringTemplate.files)) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  const adapter = join(root, 'scripts/order_adapter')
  const path = join(adapter, 'task-definition.json')
  const template = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const contentSchema: Record<string, unknown> = { type: 'object', title: '中文计数', additionalProperties: false,
    required: ['text'], properties: { text: { type: 'string', title: '待统计文字', minLength: 1, maxLength: 1000 } } }
  const outputSchema: Record<string, unknown> = { type: 'object', title: '计数结果', additionalProperties: false,
    required: ['result'], properties: { result: { type: 'string', title: '统计结果', minLength: 1, maxLength: 32 } } }
  const definition = { ...template,
    inputSchema: { ...template.inputSchema as Record<string, unknown>, contentSchema }, outputSchema }
  await writeFile(path, canonicalOrderJson(definition))
  await writeFile(join(adapter, 'src/adapter.quickjs.js'), 'function run(input) { return { result: `共${[...input.text].length}个字符` } }')
  for (const [sample, text, expected] of [['one', '你好千手🙂', '共5个字符'], ['two', 'A🙂', '共2个字符']]) {
    await writeFile(join(adapter, `samples/count-${sample}.input.json`), JSON.stringify({ text }))
    await writeFile(join(adapter, `samples/count-${sample}.expected.json`), JSON.stringify({ result: expected }))
  }
  return { path, definition, skill: join(root, 'SKILL.md') }
}

it('authors from the actual template with Chinese titles and runs Unicode examples using ASCII machine keys', async () => {
  const { skill } = await author()
  const source = await readGenericOrderSource(skill)
  expect(source.taskDefinition?.inputSchema.contentSchema).toMatchObject({
    required: ['text'], properties: { text: { title: '待统计文字' } },
  })
  expect(source.taskDefinition?.outputSchema).toMatchObject({
    required: ['result'], properties: { result: { title: '统计结果' } },
  })
  expect(await verifyGenericOrderAdapter(source)).toMatchObject({ localVerified: true, platformReady: false })
  expect((await runGenericOrderChallenge(source, Buffer.from('{"text":"你好千手🙂"}'))).output)
    .toEqual({ result: '共5个字符' })
  expect(skillAuthoringTemplate.instructions).toContain('机器字段名必须使用 ASCII')
  expect(skillAuthoringTemplate.instructions).toContain('title 受支持')
})

it.each(['input', 'output'] as const)('rejects Chinese %s machine keys with a usable repair instruction', async (kind) => {
  const { path, definition, skill } = await author()
  if (kind === 'input') definition.inputSchema.contentSchema = { type: 'object', additionalProperties: false,
    required: ['待统计文字'], properties: { 待统计文字: { type: 'string', title: '待统计文字' } } }
  else definition.outputSchema = { type: 'object', additionalProperties: false,
    required: ['结果'], properties: { 结果: { type: 'string', title: '统计结果' } } }
  await writeFile(path, canonicalOrderJson(definition))
  const failure: unknown = await readGenericOrderSource(skill).catch((error: unknown) => error)
  const rejection = localOrderSourceRejection(failure)
  expect(rejection).toMatchObject({ reason: `${kind}-schema`, platformContacted: false })
  expect(String(rejection?.repair)).toContain('ASCII')
  expect(String(rejection?.repair)).toContain('title')
})

it('continues to reject unsupported field descriptions while titles remain valid', async () => {
  const { path, definition, skill } = await author()
  definition.inputSchema.contentSchema.properties = {
    text: { type: 'string', title: '待统计文字', description: '用户友好说明不等于受支持的契约关键字' },
  }
  await writeFile(path, canonicalOrderJson(definition))
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})
